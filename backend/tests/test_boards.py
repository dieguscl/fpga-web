import pytest

from fpgaweb.boards import ARCH_BITSTREAM, ARCH_CONSTRAINT


def test_registry_loads_all_apio_boards(registry):
    boards = registry.all()
    assert len(boards) == 109
    assert {b.arch for b in boards} == {"xilinx", "ice40", "ecp5", "gowin"}


def test_basys3_board(registry):
    b = registry.get("basys3")
    assert b.arch == "xilinx"
    assert b.params["yosys-part"] == "xc7a35tcpg236-1"
    assert b.constraint_ext == ".xdc" and b.bitstream_ext == ".bit"
    assert b.usb == {"vid": "0403", "pid": "6010", "product-regex": "^Digilent USB Device*"}


def test_unknown_board_raises(registry):
    with pytest.raises(KeyError):
        registry.get("nope")


def test_template_from_apio_example(registry):
    t = registry.template("sipeed-tang-nano-9k")
    assert t.top == "blinky"
    assert set(t.files) == {"blinky.v", "blinky.cst"}  # tb, gtkw, apio.ini, info, apio_testing.vh dropped


def test_template_fallback_for_board_without_example(registry):
    t = registry.template("colorlight-i9-v7-2-ft2232h")
    assert t.top == "main"
    assert "main.v" in t.files
    assert "colorlight-i9-v7-2-ft2232h.lpf" in t.files


def test_arch_tables_cover_all_arches():
    assert set(ARCH_CONSTRAINT) == set(ARCH_BITSTREAM) == {"xilinx", "ice40", "ecp5", "gowin"}
