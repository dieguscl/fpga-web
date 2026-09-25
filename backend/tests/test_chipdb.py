import asyncio
import dataclasses
import hashlib
import io
import tarfile
from pathlib import Path

import pytest

from fpgaweb.chipdb import ChipdbError, ChipdbStore

CHIPDB = b"CHIPDB-CONTENT" * 100


def make_asset(name: str, content: bytes) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        info = tarfile.TarInfo(name)
        info.size = len(content)
        tf.addfile(info, io.BytesIO(content))
    return buf.getvalue()


ASSET = make_asset("xc7a35tcpg236.bin", CHIPDB)


def index(asset_sha=None, chip_sha=None):
    return {
        "release-tag": "2026-09-24",
        "parts": [["xc7a35tcpg236-1", {
            "chipdb": "xc7a35tcpg236.bin",
            "chipdb-size": len(CHIPDB),
            "chipdb-sha256": chip_sha or hashlib.sha256(CHIPDB).hexdigest(),
            "asset": "apio-xilinx-chipdb-xc7a35tcpg236-20260924.bin.tgz",
            "asset-sha256": asset_sha or hashlib.sha256(ASSET).hexdigest(),
        }]],
    }


class FakeFetch:
    def __init__(self, payload=ASSET, delay=0.0):
        self.urls: list[str] = []
        self.payload, self.delay = payload, delay

    async def __call__(self, url: str, dest: Path) -> None:
        self.urls.append(url)
        await asyncio.sleep(self.delay)
        dest.write_bytes(self.payload)


async def test_downloads_verifies_and_caches(settings):
    fetch = FakeFetch()
    store = ChipdbStore(settings, index(), fetch)
    p = await store.ensure("xc7a35tcpg236-1")
    assert p == settings.chipdb_dir / "xc7a35tcpg236.bin"
    assert p.read_bytes() == CHIPDB
    assert fetch.urls == ["https://github.com/fpgawars/tools-openxc7/releases/download/2026-09-24/"
                          "apio-xilinx-chipdb-xc7a35tcpg236-20260924.bin.tgz"]
    await store.ensure("xc7a35tcpg236-1")
    assert len(fetch.urls) == 1


async def test_concurrent_ensure_downloads_once(settings):
    fetch = FakeFetch(delay=0.05)
    store = ChipdbStore(settings, index(), fetch)
    a, b = await asyncio.gather(store.ensure("xc7a35tcpg236-1"), store.ensure("xc7a35tcpg236-1"))
    assert a == b and len(fetch.urls) == 1


async def test_existing_file_with_right_size_is_reused(settings):
    settings.chipdb_dir.mkdir(parents=True)
    (settings.chipdb_dir / "xc7a35tcpg236.bin").write_bytes(CHIPDB)
    fetch = FakeFetch()
    await ChipdbStore(settings, index(), fetch).ensure("xc7a35tcpg236-1")
    assert fetch.urls == []


async def test_bad_asset_hash_rejected(settings):
    store = ChipdbStore(settings, index(asset_sha="0" * 64), FakeFetch())
    with pytest.raises(ChipdbError, match="checksum"):
        await store.ensure("xc7a35tcpg236-1")
    assert not (settings.chipdb_dir / "xc7a35tcpg236.bin").exists()


async def test_bad_chipdb_hash_rejected(settings):
    store = ChipdbStore(settings, index(chip_sha="0" * 64), FakeFetch())
    with pytest.raises(ChipdbError, match="checksum"):
        await store.ensure("xc7a35tcpg236-1")


async def test_unknown_part(settings):
    with pytest.raises(ChipdbError, match="not supported"):
        await ChipdbStore(settings, index(), FakeFetch()).ensure("xc7z999")


async def test_archive_missing_member(settings):
    # Asset contains "wrong-name.bin", but index expects "xc7a35tcpg236.bin"
    wrong_asset = make_asset("wrong-name.bin", CHIPDB)
    wrong_asset_sha = hashlib.sha256(wrong_asset).hexdigest()
    wrong_chip_sha = hashlib.sha256(CHIPDB).hexdigest()
    store = ChipdbStore(settings, index(asset_sha=wrong_asset_sha, chip_sha=wrong_chip_sha), FakeFetch(wrong_asset))
    with pytest.raises(ChipdbError, match="malformed"):
        await store.ensure("xc7a35tcpg236-1")
    assert not (settings.chipdb_dir / "xc7a35tcpg236.bin").exists()


def test_default_index_is_vendored_file(settings):
    s = dataclasses.replace(settings, data_dir=Path(__file__).resolve().parents[1] / "fpgaweb" / "data")
    store = ChipdbStore(s)
    assert "xc7a35tcpg236-1" in store.parts
