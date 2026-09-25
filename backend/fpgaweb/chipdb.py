"""Download Xilinx chipdb files from Apio's openXC7 release on first use."""

import asyncio
import hashlib
import json
import os
import tarfile
import tempfile
from pathlib import Path
from typing import Awaitable, Callable

import httpx

from fpgaweb.config import Settings

Fetcher = Callable[[str, Path], Awaitable[None]]


class ChipdbError(RuntimeError):
    pass


async def http_fetch(url: str, dest: Path) -> None:
    async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(30, read=300)) as client:
        async with client.stream("GET", url) as r:
            r.raise_for_status()
            with dest.open("wb") as f:
                async for chunk in r.aiter_bytes(1 << 20):
                    f.write(chunk)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class ChipdbStore:
    def __init__(self, settings: Settings, index: dict | None = None, fetch: Fetcher | None = None):
        if index is None:
            index = json.loads((settings.data_dir / "apio" / "XILINX-PARTS-INDEX.json").read_text())
        self._s = settings
        self._tag = index["release-tag"]
        # Handle both list format (from tests) and dict format (from vendored file)
        parts_data = index["parts"]
        if isinstance(parts_data, list):
            self.parts: dict[str, dict] = {name: info for name, info in parts_data}
        else:
            self.parts: dict[str, dict] = parts_data
        self._fetch = fetch or http_fetch
        self._locks: dict[str, asyncio.Lock] = {}

    async def ensure(self, part: str) -> Path:
        info = self.parts.get(part)
        if info is None:
            raise ChipdbError(f"part {part} is not supported by the Xilinx toolchain")
        dest = self._s.chipdb_dir / info["chipdb"]
        lock = self._locks.setdefault(info["chipdb"], asyncio.Lock())
        async with lock:
            if dest.is_file() and dest.stat().st_size == info["chipdb-size"]:
                return dest
            await self._download(info, dest)
        return dest

    async def _download(self, info: dict, dest: Path) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        url = self._s.chipdb_url.format(tag=self._tag, asset=info["asset"])
        with tempfile.TemporaryDirectory(dir=dest.parent) as tmp:
            tgz = Path(tmp) / info["asset"]
            try:
                await self._fetch(url, tgz)
            except Exception as e:  # network errors surface as a build error
                raise ChipdbError(f"could not download chip database: {e}") from e
            if _sha256(tgz) != info["asset-sha256"]:
                raise ChipdbError("chip database download failed checksum verification")
            with tarfile.open(tgz, "r:gz") as tf:
                member = tf.getmember(info["chipdb"])
                src = tf.extractfile(member)
                if src is None:
                    raise ChipdbError("chip database archive is malformed")
                out = Path(tmp) / info["chipdb"]
                with out.open("wb") as f:
                    while chunk := src.read(1 << 20):
                        f.write(chunk)
            if _sha256(out) != info["chipdb-sha256"]:
                raise ChipdbError("chip database failed checksum verification")
            os.replace(out, dest)
