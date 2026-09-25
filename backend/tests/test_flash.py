from fpgaweb.flash import flash_plan


def test_openfpgaloader_board_uses_apio_extra_args(registry):
    p = flash_plan(registry.get("basys3"))
    assert p.mode == "browser"
    assert p.args == ["--board", "basys3"]
    assert p.writes_flash is False


def test_vid_pid_placeholders_are_substituted(registry):
    b = registry.get("colorlight-i5-v7-0")
    p = flash_plan(b)
    assert p.mode == "browser"
    assert f"0x{b.usb['vid']}" in p.args and f"0x{b.usb['pid']}" in p.args
    assert not any("${" in a for a in p.args)
    assert p.writes_flash is True  # --write-flash


def test_iceprog_board_maps_to_ice40_generic(registry):
    p = flash_plan(registry.get("icebreaker"))
    assert p == p.__class__("browser", ["-b", "ice40_generic"], True)


def test_iceprog_with_custom_interface_is_download_only(registry):
    assert flash_plan(registry.get("kefir")).mode == "download"


def test_dfu_board(registry):
    b = registry.get("orangecrab-r02-25f")
    p = flash_plan(b)
    assert p.mode == "browser"
    assert p.args == ["--dfu", "--vid", f"0x{b.usb['vid']}", "--pid", f"0x{b.usb['pid']}"]


def test_fujprog_board(registry):
    assert flash_plan(registry.get("ulx3s-85f")).args == ["-b", "ulx3s"]


def test_unsupported_programmer_is_download_only(registry):
    p = flash_plan(registry.get("tinyfpga-bx"))
    assert p.mode == "download" and p.args == []


def test_most_boards_flash_in_browser(registry):
    modes = [flash_plan(b).mode for b in registry.all()]
    assert modes.count("browser") >= 90
