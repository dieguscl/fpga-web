"""HTTP API: boards, build submission, SSE job events, bitstream download, SPA."""

import asyncio
import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
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
                return cf.strip()
            fwd = request.headers.get("x-forwarded-for")
            if fwd:
                return fwd.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    @app.middleware("http")
    async def limit_body(request: Request, call_next):
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_BODY:
            return JSONResponse({"detail": "request too large"}, status_code=413)
        return await call_next(request)

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
            raise HTTPException(429, "you already have a build running; wait for it to finish")
        if not limiter.allow(ip):
            return JSONResponse({"detail": "too many builds; slow down"}, status_code=429,
                                headers={"Retry-After": str(limiter.retry_after(ip))})
        try:
            job = manager.submit(ip, board, body.top, files, body.lint)
        except QueueFull:
            raise HTTPException(503, "build server is busy; try again in a minute")
        return {"job_id": job.id, "queue_position": job.events[0]["position"]}

    @app.get("/api/jobs/{job_id}/events")
    async def events(job_id: str, request: Request, start: int | None = None):
        job = manager.get(job_id)
        if job is None:
            raise HTTPException(404, "unknown or expired job")
        if start is None:
            start = int(request.query_params.get("from", "0") or 0)
            last = request.headers.get("last-event-id")
            if last and last.isdigit():
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
