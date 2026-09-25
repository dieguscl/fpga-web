import dataclasses
import json

import httpx
import pytest
import uvicorn

from fpgaweb.api import create_app
from fpgaweb.jobs import JobManager
from fpgaweb.ratelimit import RateLimiter
from tests.test_jobs import FakeChipdb, FakeRunner

V = "module main(input clk, output led); assign led = clk; endmodule\n"
BODY = {"board": "icebreaker", "top": "main", "files": {"main.v": V, "p.pcf": ""}, "lint": False}


@pytest.fixture
async def client(settings, registry):
    async def _client(runner=None, limiter=None, **overrides):
        s = dataclasses.replace(settings, **overrides)
        manager = JobManager(s, run_step=runner or FakeRunner(), chipdb=FakeChipdb())
        app = create_app(s, registry, manager, limiter or RateLimiter(100, 600))
        await manager.start()
        clients.append((manager, httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                                    base_url="http://t")))
        return clients[-1][1]

    clients = []
    yield _client
    for manager, c in clients:
        await c.aclose()
        await manager.stop()


def sse_events(text: str) -> list[tuple[int, dict]]:
    out = []
    for frame in text.strip().split("\n\n"):
        if frame.startswith(":"):
            continue  # heartbeat comment
        lines = dict(l.split(": ", 1) for l in frame.splitlines())
        out.append((int(lines["id"]), json.loads(lines["data"])))
    return out


async def test_boards_listing(client):
    c = await client()
    r = await c.get("/api/boards")
    assert r.status_code == 200
    basys = next(b for b in r.json() if b["id"] == "basys3")
    assert basys == {"id": "basys3", "description": "Basys3 (Xilinx, Artix7)", "arch": "xilinx",
                     "part": "XC7A35T-1CPG236", "constraint_ext": ".xdc", "bitstream_ext": ".bit",
                     "flash": "browser", "ofl_args": ["--board", "basys3"], "writes_flash": False}


async def test_template(client):
    c = await client()
    r = await c.get("/api/boards/icebreaker/template")
    assert r.status_code == 200 and r.json()["top"]
    assert (await c.get("/api/boards/nope/template")).status_code == 404


async def test_build_happy_path_and_events(client):
    c = await client()
    r = await c.post("/api/build", json=BODY)
    assert r.status_code == 202
    job_id = r.json()["job_id"]
    assert r.json()["queue_position"] == 1
    r = await c.get(f"/api/jobs/{job_id}/events")
    assert r.headers["content-type"].startswith("text/event-stream")
    events = sse_events(r.text)
    assert events[-1][1]["type"] == "done"
    assert [i for i, _ in events] == list(range(len(events)))
    r = await c.get(f"/api/jobs/{job_id}/bitstream")
    assert r.status_code == 200 and r.content == b"\x7e\xaa\x99\x7e"
    assert 'filename="icebreaker.bin"' in r.headers["content-disposition"]


async def test_sse_resume_last_event_id(client):
    c = await client()
    job_id = (await c.post("/api/build", json=BODY)).json()["job_id"]
    full = sse_events((await c.get(f"/api/jobs/{job_id}/events")).text)
    r = await c.get(f"/api/jobs/{job_id}/events", headers={"Last-Event-ID": "2"})
    assert sse_events(r.text) == full[3:]
    r = await c.get(f"/api/jobs/{job_id}/events?from=4")
    assert sse_events(r.text) == full[4:]


async def test_sse_from_query_rejects_non_integer(client):
    c = await client()
    job_id = (await c.post("/api/build", json=BODY)).json()["job_id"]
    r = await c.get(f"/api/jobs/{job_id}/events?from=abc")
    assert r.status_code == 422


async def test_sse_non_ascii_last_event_id_is_ignored(client):
    c = await client()
    job_id = (await c.post("/api/build", json=BODY)).json()["job_id"]
    full = sse_events((await c.get(f"/api/jobs/{job_id}/events")).text)
    # "\xb2" (superscript two) passes str.isdigit() but int("\xb2") raises
    # ValueError -- must be ignored (fall back to a full replay), not 500.
    # httpx requires ASCII for a str header value, so pass raw latin-1 bytes.
    r = await c.get(f"/api/jobs/{job_id}/events",
                    headers={"Last-Event-ID": "\xb2".encode("latin-1")})
    assert r.status_code == 200
    assert sse_events(r.text) == full


async def test_validation_error_is_400(client):
    c = await client()
    r = await c.post("/api/build", json={**BODY, "files": {"main.v": V, "p.xdc": ""}})
    assert r.status_code == 400 and ".pcf" in r.json()["detail"]


async def test_unknown_board_is_400(client):
    c = await client()
    r = await c.post("/api/build", json={**BODY, "board": "nope"})
    assert r.status_code == 400 and "unknown board" in r.json()["detail"]


async def test_malformed_body_is_400_or_422(client):
    c = await client()
    r = await c.post("/api/build", json={"board": 1})
    assert r.status_code in (400, 422)


async def test_body_too_large_is_413(client):
    c = await client()
    r = await c.post("/api/build", content=b"{" + b" " * 2_100_000 + b"}",
                     headers={"content-type": "application/json"})
    assert r.status_code == 413


async def test_chunked_body_too_large_is_413(client):
    # No Content-Length header: httpx sends this as a chunked/streamed body,
    # so only counting bytes as they're actually read (not trusting a
    # declared Content-Length) can catch it.
    async def body():
        for _ in range(21):
            yield b" " * 100_000  # 2_100_000 bytes total, > MAX_BODY

    c = await client()
    r = await c.post("/api/build", content=body(), headers={"content-type": "application/json"})
    assert r.status_code == 413


async def test_rate_limit_429(client):
    c = await client(limiter=RateLimiter(1, 600))
    r = await c.post("/api/build", json=BODY)
    assert r.status_code == 202
    await c.get(f"/api/jobs/{r.json()['job_id']}/events")  # wait until the first job is finished
    r = await c.post("/api/build", json=BODY)
    assert r.status_code == 429 and "Retry-After" in r.headers


async def test_one_active_job_per_ip(client):
    import asyncio
    gate = asyncio.Event()
    c = await client(runner=FakeRunner(gate=gate))
    assert (await c.post("/api/build", json=BODY)).status_code == 202
    r = await c.post("/api/build", json=BODY)
    assert r.status_code == 429 and "already" in r.json()["detail"]
    assert r.headers["retry-after"] == "10"
    gate.set()


async def test_queue_full_503(client):
    import asyncio
    gate = asyncio.Event()
    c = await client(runner=FakeRunner(gate=gate), queue_max=0)
    r = await c.post("/api/build", json=BODY)
    assert r.status_code == 503
    gate.set()


async def test_queue_full_503_does_not_consume_rate_limit_token(client):
    limiter = RateLimiter(1, 600)
    c_full = await client(queue_max=0, limiter=limiter)
    r = await c_full.post("/api/build", json=BODY)
    assert r.status_code == 503

    # Same limiter (same simulated client IP), a manager with room this time:
    # the 503 above must not have burnt the limiter's one allowed token.
    c_ok = await client(limiter=limiter)
    r = await c_ok.post("/api/build", json=BODY)
    assert r.status_code == 202


async def test_forwarded_for_used_only_when_trusted(client):
    import asyncio
    gate = asyncio.Event()
    c = await client(runner=FakeRunner(gate=gate), trust_proxy=True)
    h1 = {"X-Forwarded-For": "9.9.9.9, 10.0.0.1"}
    h2 = {"X-Forwarded-For": "8.8.8.8"}
    assert (await c.post("/api/build", json=BODY, headers=h1)).status_code == 202
    assert (await c.post("/api/build", json=BODY, headers=h2)).status_code == 202  # different client
    assert (await c.post("/api/build", json=BODY, headers=h1)).status_code == 429
    gate.set()


async def test_cf_connecting_ip_preferred(client):
    import asyncio
    gate = asyncio.Event()
    c = await client(runner=FakeRunner(gate=gate), trust_proxy=True)
    same_client = {"CF-Connecting-IP": "7.7.7.7"}
    assert (await c.post("/api/build", json=BODY, headers={**same_client, "X-Forwarded-For": "1.1.1.1"})).status_code == 202
    r = await c.post("/api/build", json=BODY, headers={**same_client, "X-Forwarded-For": "2.2.2.2"})
    assert r.status_code == 429
    gate.set()


async def test_sse_heartbeat_while_queued(settings, registry):
    # NOTE: deviates from a plain `client` fixture call. httpx.ASGITransport
    # runs the whole ASGI app to completion inside a single `await
    # self.app(...)` before handing any bytes back to the caller (see
    # httpx/_transports/asgi.py: `send()` just appends to `body_parts`, and
    # the Response is built only after `self.app(...)` returns). A gated job
    # never reaches a terminal event, so a still-open SSE stream can never be
    # read incrementally through ASGITransport -- reading it hangs forever,
    # confirmed with a minimal repro (plain StreamingResponse yielding once
    # then awaiting a never-set Event: the `async with client.stream(...)`
    # call itself never returns). A real server, reached over a real socket,
    # streams incrementally like production does, so this test spins up
    # uvicorn on an ephemeral loopback port instead.
    import asyncio

    gate = asyncio.Event()
    s = dataclasses.replace(settings, sse_ping_s=0)
    manager = JobManager(s, run_step=FakeRunner(gate=gate), chipdb=FakeChipdb())
    app = create_app(s, registry, manager, RateLimiter(100, 600))
    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
    server = uvicorn.Server(config)
    server.install_signal_handlers = lambda: None  # don't touch pytest's handlers
    server_task = asyncio.create_task(server.serve())

    async def run() -> None:
        while not server.started:
            if server_task.done():
                server_task.result()  # re-raise a startup failure instead of spinning forever
            await asyncio.sleep(0.01)
        port = server.servers[0].sockets[0].getsockname()[1]
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as c:
            job_id = (await c.post("/api/build", json=BODY)).json()["job_id"]
            async with c.stream("GET", f"/api/jobs/{job_id}/events") as r:
                chunks = []
                async for chunk in r.aiter_text():
                    chunks.append(chunk)
                    if any(ch.startswith(": ping") for ch in chunks):
                        break
            assert any(ch.startswith(": ping") for ch in chunks)

    try:
        await asyncio.wait_for(run(), timeout=15)
    finally:
        gate.set()
        server.should_exit = True
        await server_task


async def test_unknown_job_404(client):
    c = await client()
    assert (await c.get("/api/jobs/nope/events")).status_code == 404
    assert (await c.get("/api/jobs/nope/bitstream")).status_code == 404


async def test_static_spa_served(client, tmp_path):
    (tmp_path / "web").mkdir()
    (tmp_path / "web" / "index.html").write_text("<h1>hi</h1>")
    c = await client(static_dir=tmp_path / "web")
    r = await c.get("/")
    assert r.status_code == 200 and "hi" in r.text


async def test_cross_origin_isolation_headers(client, tmp_path):
    # Required so the browser considers the page cross-origin isolated
    # (crossOriginIsolated === true), which @yowasp/openfpgaloader's shared
    # WebAssembly.Memory needs -- must be present on the static SPA shell
    # (the top-level document) as well as on API responses.
    (tmp_path / "web").mkdir()
    (tmp_path / "web" / "index.html").write_text("<h1>hi</h1>")
    c = await client(static_dir=tmp_path / "web")
    for path in ("/", "/api/boards"):
        r = await c.get(path)
        assert r.headers["cross-origin-opener-policy"] == "same-origin"
        assert r.headers["cross-origin-embedder-policy"] == "require-corp"


# --- Controller ruling: bitstream endpoint must not serve a symlink ---


async def test_bitstream_symlink_not_served(settings, registry, tmp_path):
    outside = tmp_path / "outside.bin"
    outside.write_bytes(b"\x7e\xaa\x99\x7e")

    manager = JobManager(settings, run_step=FakeRunner(), chipdb=FakeChipdb())
    app = create_app(settings, registry, manager, RateLimiter(100, 600))
    await manager.start()
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://t") as c:
            r = await c.post("/api/build", json=BODY)
            job_id = r.json()["job_id"]
            await c.get(f"/api/jobs/{job_id}/events")  # drain to completion

            job = manager.get(job_id)
            assert job.bitstream is not None
            job.bitstream.unlink()
            job.bitstream.symlink_to(outside)

            r = await c.get(f"/api/jobs/{job_id}/bitstream")
            assert r.status_code == 404
    finally:
        await manager.stop()
