import dataclasses

import httpx
import pytest

from fpgaweb.api import create_app
from fpgaweb.jobs import JobManager
from fpgaweb.ratelimit import RateLimiter
from fpgaweb.shares import ShareError, ShareStore
from fpgaweb.shares_admin import main as admin
from tests.test_jobs import FakeChipdb, FakeRunner

PROJECT = {"name": "mux", "board": "basys3", "top": "mux",
           "files": {"mux.v": "module mux(input a, output y); assign y = a; endmodule\n",
                     "mux.circ": '{"version":1,"components":[],"wires":[]}', "basys3.xdc": ""}}


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


# ── store ──


def test_create_get_dedupe_delete(tmp_path):
    s = ShareStore(tmp_path / "s.db", quota_bytes=10**6, ttl_days=180)
    a = s.create(PROJECT, "1.2.3.4")
    assert len(a.id) == 10 and a.id.isalnum() and a.delete_key
    assert s.get(a.id) == PROJECT
    again = s.create(PROJECT, "1.2.3.4")
    assert again.id == a.id and again.delete_key is None  # same creator, same content → same link
    other = s.create(PROJECT, "5.6.7.8")
    assert other.id != a.id  # another person's copy can't be deleted by the first
    assert not s.delete(a.id, "wrong") and s.delete(a.id, a.delete_key)
    assert s.get(a.id) is None and s.get(other.id) == PROJECT


def test_expiry_counts_from_last_open(tmp_path):
    clock = Clock()
    s = ShareStore(tmp_path / "s.db", quota_bytes=10**6, ttl_days=180, clock=clock)
    a = s.create(PROJECT, "ip")
    clock.t += 170 * 86400
    assert s.get(a.id) is not None  # opening refreshes the clock
    clock.t += 170 * 86400
    assert s.purge_expired() == 0 and s.get(a.id) is not None
    clock.t += 181 * 86400
    assert s.purge_expired() == 1 and s.get(a.id) is None


def test_quota_ban_report_backup_and_ip_privacy(tmp_path):
    s = ShareStore(tmp_path / "s.db", quota_bytes=150, ttl_days=180)
    a = s.create(PROJECT, "9.9.9.9")
    big = {**PROJECT, "files": {"x.v": "".join(f"wire w{i};\n" for i in range(400))}}
    with pytest.raises(ShareError, match="full"):
        s.create(big, "9.9.9.9")
    assert s.report(a.id) and not s.report("nope")
    assert s.stats()["reported"][0]["id"] == a.id
    assert b"9.9.9.9" not in (tmp_path / "s.db").read_bytes()  # creators are keyed hashes
    assert s.admin_ban(a.id, purge=True) == 1
    with pytest.raises(ShareError, match="disabled"):
        s.create(PROJECT, "9.9.9.9")
    assert s.backup(tmp_path / "bk").exists()


def test_admin_cli(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("FPGAWEB_SHARES_DB", str(tmp_path / "s.db"))
    sid = ShareStore(tmp_path / "s.db", 10**6, 180).create(PROJECT, "ip").id
    assert admin(["show", sid]) == 0 and "mux.v" in capsys.readouterr().out
    assert admin(["delete", sid]) == 0 and admin(["delete", sid]) == 1


# ── API ──


@pytest.fixture
async def api(settings, registry, tmp_path):
    clients = []

    async def _client(**overrides):
        s = dataclasses.replace(settings, **overrides)
        manager = JobManager(s, run_step=FakeRunner(), chipdb=FakeChipdb())
        store = ShareStore(tmp_path / "api.db", s.share_quota_bytes, s.share_ttl_days)
        app = create_app(s, registry, manager, RateLimiter(100, 600), store)
        c = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")
        clients.append(c)
        return c

    yield _client
    for c in clients:
        await c.aclose()


async def test_api_share_roundtrip(api, tmp_path):
    (tmp_path / "web").mkdir()
    (tmp_path / "web" / "index.html").write_text("<h1>ide</h1>")
    c = await api(static_dir=tmp_path / "web")
    assert (await c.get("/api/config")).json() == {"shares": True, "turnstile_sitekey": ""}
    r = await c.post("/api/shares", json={"project": PROJECT})
    assert r.status_code == 201
    sid, key = r.json()["id"], r.json()["delete_key"]
    g = await c.get(f"/api/shares/{sid}")
    assert g.json() == PROJECT and g.headers["x-robots-tag"].startswith("noindex")
    page = await c.get(f"/s/{sid}")
    assert "ide" in page.text and page.headers["x-robots-tag"].startswith("noindex")
    assert (await c.post(f"/api/shares/{sid}/report")).status_code == 204
    assert (await c.delete(f"/api/shares/{sid}", headers={"X-Delete-Key": "bad"})).status_code == 404
    assert (await c.delete(f"/api/shares/{sid}", headers={"X-Delete-Key": key})).status_code == 204
    assert (await c.get(f"/api/shares/{sid}")).status_code == 404


@pytest.mark.parametrize("bad", [
    {**PROJECT, "board": "nope"},
    {**PROJECT, "name": "../x"},
    {**PROJECT, "files": {"evil.html": "<script>"}},
    {**PROJECT, "files": {"x.circ": "not json"}},
    {**PROJECT, "files": {"x.v": "a" * 200_001}},
])
async def test_api_rejects_non_project_content(api, bad):
    c = await api()
    assert (await c.post("/api/shares", json={"project": bad})).status_code == 400


async def test_api_share_rate_limit(api):
    c = await api(share_rate_hour=2)
    for i in range(2):
        p = {**PROJECT, "top": f"m{i}"}
        assert (await c.post("/api/shares", json={"project": p})).status_code == 201
    r = await c.post("/api/shares", json={"project": {**PROJECT, "top": "m9"}})
    assert r.status_code == 429 and "hour" in r.json()["detail"]
