import pytest

from fpgaweb.validation import ValidationError, is_testbench, validate_files

V = "module main(input clk, output led); assign led = clk; endmodule\n"


@pytest.fixture
def basys3(registry):
    return registry.get("basys3")


def ok(**extra):
    return {"main.v": V, "pins.xdc": "# pins\n", **extra}


def test_valid_request_passes(basys3):
    assert validate_files(basys3, "main", ok()) == ok()


def test_crlf_and_bom_normalised(basys3):
    files = {"main.v": "﻿module main();\r\nendmodule\r\n", "pins.xdc": "# a\rb\n"}
    out = validate_files(basys3, "main", files)
    assert out["main.v"] == "module main();\nendmodule\n"
    assert out["pins.xdc"] == "# a\nb\n"


@pytest.mark.parametrize("name", ["../x.v", "/etc/passwd.v", "a/b.v", ".hidden.v", "x" * 70 + ".v", "a b.v"])
def test_bad_filenames_rejected(basys3, name):
    with pytest.raises(ValidationError, match="file name"):
        validate_files(basys3, "main", ok(**{name: V}))


def test_bad_extension_rejected(basys3):
    with pytest.raises(ValidationError, match="extension"):
        validate_files(basys3, "main", ok(**{"run.sh": "echo"}))


def test_uppercase_extension_rejected(basys3):
    with pytest.raises(ValidationError, match="lower-case"):
        validate_files(basys3, "main", ok(**{"Extra.V": V}))


def test_too_many_files(basys3):
    files = ok(**{f"m{i}.v": "" for i in range(49)})
    with pytest.raises(ValidationError, match="50 files"):
        validate_files(basys3, "main", files)


def test_too_large(basys3):
    with pytest.raises(ValidationError, match="1 MB"):
        validate_files(basys3, "main", ok(**{"big.mem": "0" * 1_000_001}))


def test_nul_byte_rejected(basys3):
    with pytest.raises(ValidationError, match="binary"):
        validate_files(basys3, "main", ok(**{"x.v": "a\x00b"}))


def test_wrong_constraint_type_for_board(basys3):
    with pytest.raises(ValidationError, match=r"\.xdc"):
        validate_files(basys3, "main", {"main.v": V, "pins.pcf": ""})


def test_exactly_one_constraint_file(basys3):
    with pytest.raises(ValidationError, match="exactly one"):
        validate_files(basys3, "main", ok(**{"more.xdc": ""}))


def test_needs_a_design_source(basys3):
    with pytest.raises(ValidationError, match="Verilog"):
        validate_files(basys3, "main", {"main_tb.v": V, "pins.xdc": ""})


@pytest.mark.parametrize("top", ["", "1abc", "a b", "x;rm", "a" * 200])
def test_bad_top_module(basys3, top):
    with pytest.raises(ValidationError, match="top module"):
        validate_files(basys3, top, ok())


def test_is_testbench():
    assert is_testbench("cpu_tb.v") and is_testbench("x_tb.sv")
    assert not is_testbench("tb_helper.v")
