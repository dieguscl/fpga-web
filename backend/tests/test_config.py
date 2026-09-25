from pathlib import Path

from fpgaweb.config import Settings, from_env


def test_defaults_are_container_paths():
    s = Settings()
    assert s.work_dir == Path("/var/lib/fpgaweb/jobs")
    assert s.workers == 2 and s.queue_max == 20
    assert s.sandbox == "bwrap"


def test_from_env_parses_types():
    s = from_env({
        "FPGAWEB_WORKERS": "3",
        "FPGAWEB_WORK_DIR": "/tmp/j",
        "FPGAWEB_RO_BINDS": "/a:/b",
        "FPGAWEB_TRUST_PROXY": "true",
        "FPGAWEB_STATIC_DIR": "/srv/web",
        "UNRELATED": "x",
    })
    assert s.workers == 3
    assert s.work_dir == Path("/tmp/j")
    assert s.ro_binds == ("/a", "/b")
    assert s.trust_proxy is True
    assert s.static_dir == Path("/srv/web")
