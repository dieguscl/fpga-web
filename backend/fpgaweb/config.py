"""Runtime settings, overridable with FPGAWEB_<FIELD> environment variables."""

import os
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Mapping

PACKAGE_DATA = Path(__file__).resolve().parent / "data"


@dataclass(frozen=True)
class Settings:
    data_dir: Path = PACKAGE_DATA
    work_dir: Path = Path("/var/lib/fpgaweb/jobs")
    chipdb_dir: Path = Path("/var/lib/fpgaweb/chipdb")
    chipdb_url: str = "https://github.com/fpgawars/tools-openxc7/releases/download/{tag}/{asset}"
    prjxray_db: Path = Path("/opt/fpga/prjxray-db")
    trellis_db: Path = Path("/opt/fpga/oss-cad-suite/share/trellis/database")
    yosys_share: Path = Path("/opt/fpga/oss-cad-suite/share/yosys")
    tool_path: str = "/opt/fpga/bin:/opt/fpga/oss-cad-suite/bin:/usr/bin:/bin"
    ro_binds: tuple[str, ...] = ("/opt/fpga", "/nix/store", "/var/lib/fpgaweb/chipdb")
    sandbox: str = "bwrap"  # "bwrap" | "none"
    static_dir: Path | None = None
    trust_proxy: bool = False
    workers: int = 2
    queue_max: int = 20
    job_ttl_s: int = 600
    wall_s: int = 120
    cpu_s: int = 90
    mem_bytes: int = 4 * 1024**3
    fsize_bytes: int = 200 * 1024**2
    max_job_dir_bytes: int = 300 * 1024**2
    max_log_lines: int = 5000
    max_line_chars: int = 2000
    rate_n: int = 10
    rate_window_s: int = 600
    sse_ping_s: int = 15
    max_vcd_bytes: int = 20 * 1024**2
    # Share links (see shares.py)
    shares_db: Path = Path("/var/lib/fpgaweb/shares/shares.db")
    shares_backup_dir: Path = Path("/var/lib/fpgaweb/shares/backups")
    share_max_bytes: int = 200_000  # uncompressed project text
    share_quota_bytes: int = 500 * 1024**2  # all stored shares (compressed)
    share_ttl_days: int = 180  # deleted after this long without being opened
    share_rate_hour: int = 10
    share_rate_day: int = 30
    share_open_rate_n: int = 120  # opens per 10 minutes per IP
    turnstile_sitekey: str = ""  # Cloudflare Turnstile; both set = required when creating links
    turnstile_secret: str = ""


def _coerce(name: str, raw: str):
    default = getattr(Settings, name, None)
    if name == "ro_binds":
        return tuple(p for p in raw.split(":") if p)
    if name == "static_dir":
        return Path(raw) if raw else None
    if isinstance(default, bool):
        return raw.strip().lower() in ("1", "true", "yes")
    if isinstance(default, int):
        return int(raw)
    if isinstance(default, Path):
        return Path(raw)
    return raw


def from_env(env: Mapping[str, str] = os.environ) -> Settings:
    kwargs = {}
    for f in fields(Settings):
        key = "FPGAWEB_" + f.name.upper()
        if key in env:
            kwargs[f.name] = _coerce(f.name, env[key])
    return Settings(**kwargs)
