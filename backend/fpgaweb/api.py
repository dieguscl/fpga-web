"""HTTP API: boards, build submission, SSE job events, bitstream download, SPA."""

import asyncio
import ipaddress
import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from fpgaweb.boards import Board, BoardRegistry
from fpgaweb.config import Settings
from fpgaweb.flash import flash_plan
from fpgaweb.jobs import JobManager, QueueFull
from fpgaweb.ratelimit import RateLimiter
from fpgaweb.validation import ValidationError, validate_files

MAX_BODY = 2_000_000


class BuildBody(BaseModel):
    board: str
    top: str
    files: dict[str, str]
    lint: bool = True


class BodySizeLimitMiddleware:
    """Pure-ASGI middleware rejecting request bodies over `max_bytes`.

    A `Content-Length` header over the limit is rejected up front, without
    reading any body. Everything else -- including a chunked body with no
    `Content-Length` -- is counted as the app itself reads it via `receive`;
    once the running total exceeds `max_bytes`, an `HTTPException(413)` is
    raised from inside that `receive` call instead of returning the next
    chunk, so the app never gets to finish parsing an oversized body.
    FastAPI's own body-parsing (`fastapi.routing.get_request_handler`) wraps
    `await request.body()` in a try/except that re-raises `HTTPException` as
    is but converts *any other* exception to a generic 400 -- so this must
    raise `HTTPException`, not a custom exception type, to actually surface
    as 413 instead of being swallowed into a 400.
    This has to be a raw ASGI middleware (not `@app.middleware("http")` /
    `BaseHTTPMiddleware`, which only sees whatever `Content-Length` the
    client claims) to actually stop a chunked-encoded body of unknown size
    once it exceeds the limit.
    """

    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        for name, value in scope.get("headers", ()):
            if name == b"content-length":
                if value.isdigit() and int(value) > self.max_bytes:
                    resp = JSONResponse({"detail": "request too large"}, status_code=413)
                    return await resp(scope, receive, send)
                break

        total = 0

        async def counted_receive():
            nonlocal total
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > self.max_bytes:
                    raise HTTPException(413, "request too large")
            return message

        await self.app(scope, counted_receive, send)


class SecurityHeadersMiddleware:
    """Pure-ASGI middleware adding COOP/COEP headers to every HTTP response.

    Required for in-browser flashing: @yowasp/openfpgaloader's wasm bundle
    allocates a `SharedArrayBuffer`-backed `WebAssembly.Memory` for its
    pthread worker, which browsers only permit when the page is cross-origin
    isolated (`window.crossOriginIsolated === true`). That requires both
    `Cross-Origin-Opener-Policy: same-origin` and
    `Cross-Origin-Embedder-Policy: require-corp` on the top-level document's
    response -- so this covers every response, including the static SPA
    shell (`/`) and the API, not just one route.
    Implemented as raw ASGI (like `BodySizeLimitMiddleware` above), not
    `@app.middleware("http")`/`BaseHTTPMiddleware`, so it adds headers to
    streaming responses (the SSE job-events endpoint) by rewriting the
    `http.response.start` message instead of buffering the whole response.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((b"cross-origin-opener-policy", b"same-origin"))
                headers.append((b"cross-origin-embedder-policy", b"require-corp"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_headers)


def _normalise_ip(ip: str) -> str:
    """Key IPv6 clients by their /64, so per-IP limits can't be trivially
    bypassed by rotating within the /64 a residential or mobile ISP routes to
    a single customer. IPv4 addresses are returned as-is (a /32 is already
    one host), and anything that doesn't parse as an IP address (e.g. the
    ASGI test client's "testclient" placeholder) is also returned as-is.
    """
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if addr.version == 6:
        return str(ipaddress.ip_network(f"{ip}/64", strict=False))
    return ip


def _board_json(b: Board) -> dict:
    fp = flash_plan(b)
    return {"id": b.id, "description": b.description, "arch": b.arch, "part": b.part_num,
            "constraint_ext": b.constraint_ext, "bitstream_ext": b.bitstream_ext,
            "flash": fp.mode, "ofl_args": fp.args, "writes_flash": fp.writes_flash}


def create_app(settings: Settings, registry: BoardRegistry, manager: JobManager,
               limiter: RateLimiter) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await manager.start()
        try:
            yield
        finally:
            await manager.stop()

    app = FastAPI(title="FPGA Web IDE", lifespan=lifespan, docs_url=None, redoc_url=None)
    boards_json = [_board_json(b) for b in registry.all()]

    def client_ip(request: Request) -> str:
        if settings.trust_proxy:
            cf = request.headers.get("cf-connecting-ip")
            if cf:
                return _normalise_ip(cf.strip())
            fwd = request.headers.get("x-forwarded-for")
            if fwd:
                return _normalise_ip(fwd.split(",")[0].strip())
        host = request.client.host if request.client else "unknown"
        return _normalise_ip(host)

    app.add_middleware(BodySizeLimitMiddleware, max_bytes=MAX_BODY)
    app.add_middleware(SecurityHeadersMiddleware)

    @app.get("/api/boards")
    async def boards() -> list[dict]:
        return boards_json

    @app.get("/api/boards/{board_id}/template")
    async def template(board_id: str) -> dict:
        try:
            t = registry.template(board_id)
        except KeyError:
            raise HTTPException(404, "unknown board")
        return {"top": t.top, "files": t.files}

    @app.post("/api/build", status_code=202)
    async def build(body: BuildBody, request: Request):
        try:
            board = registry.get(body.board)
        except KeyError:
            raise HTTPException(400, f"unknown board: {body.board}")
        try:
            files = validate_files(board, body.top, body.files)
        except ValidationError as e:
            raise HTTPException(400, str(e))
        ip = client_ip(request)
        if manager.active_count(ip) > 0:
            raise HTTPException(429, "you already have a build running; wait for it to finish",
                               headers={"Retry-After": "10"})
        # Check queue capacity before spending a rate-limit token: a 503 here
        # must be free to retry, not counted against the caller's rate limit.
        # submit() below still re-checks and can still raise QueueFull itself
        # to cover the race against a concurrent submission.
        if manager.queue_full():
            raise HTTPException(503, "build server is busy; try again in a minute")
        if not limiter.allow(ip):
            return JSONResponse({"detail": "too many builds; slow down"}, status_code=429,
                                headers={"Retry-After": str(limiter.retry_after(ip))})
        try:
            job = manager.submit(ip, board, body.top, files, body.lint)
        except QueueFull:
            raise HTTPException(503, "build server is busy; try again in a minute")
        return {"job_id": job.id, "queue_position": job.events[0]["position"]}

    @app.get("/api/jobs/{job_id}/events")
    async def events(job_id: str, request: Request,
                     from_: int = Query(0, alias="from", ge=0)):
        job = manager.get(job_id)
        if job is None:
            raise HTTPException(404, "unknown or expired job")
        start = from_
        last = request.headers.get("last-event-id")
        if last and last.isascii() and last.isdigit():
            start = int(last) + 1

        async def gen():
            it = job.stream(start).__aiter__()
            nxt = asyncio.ensure_future(it.__anext__())
            try:
                while True:
                    done, _ = await asyncio.wait({nxt}, timeout=settings.sse_ping_s)
                    if not done:
                        yield ": ping\n\n"
                        continue
                    try:
                        i, ev = nxt.result()
                    except StopAsyncIteration:
                        return
                    yield f"id: {i}\ndata: {json.dumps(ev)}\n\n"
                    nxt = asyncio.ensure_future(it.__anext__())
            finally:
                nxt.cancel()

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/jobs/{job_id}/bitstream")
    async def bitstream(job_id: str):
        job = manager.get(job_id)
        if job is None or job.bitstream is None:
            raise HTTPException(404, "no bitstream for this job")
        p = job.bitstream
        # Controller ruling: sandboxed steps can plant symlinks in the job
        # dir, so refuse to serve anything but a real regular file.
        if p.is_symlink() or not p.is_file():
            raise HTTPException(404, "no bitstream for this job")
        return FileResponse(p, media_type="application/octet-stream",
                            filename=f"{job.board.id}{job.board.bitstream_ext}")

    if settings.static_dir is not None:
        app.mount("/", StaticFiles(directory=settings.static_dir, html=True), name="spa")
    return app
