from pathlib import Path

import pytest

from fpgaweb.boards import BoardRegistry
from fpgaweb.config import Settings

DATA_DIR = Path(__file__).resolve().parents[1] / "fpgaweb" / "data"


@pytest.fixture(scope="session")
def registry() -> BoardRegistry:
    return BoardRegistry(DATA_DIR)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        work_dir=tmp_path / "jobs",
        chipdb_dir=tmp_path / "chipdb",
        sandbox="none",
        tool_path="/usr/bin:/bin",
        ro_binds=(),
    )
