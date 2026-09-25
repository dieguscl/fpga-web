import json
import os
from concurrent.futures import ThreadPoolExecutor

from fpgaweb.summary import read_summary


def test_parses_utilization_and_fmax(tmp_path):
    p = tmp_path / "report.json"
    p.write_text(json.dumps({
        "utilization": {"LUT": {"used": 30, "available": 20800}, "DSP": {"used": 0, "available": 90}},
        "fmax": {"clk$SB_IO_IN_$glb_clk": {"achieved": 71.234, "constraint": 12.0}},
    }))
    assert read_summary(p) == {
        "utilization": {"LUT": {"used": 30, "available": 20800}},
        "fmax": {"clk$SB_IO_IN_$glb_clk": 71.23},
    }


def test_missing_or_bad_file(tmp_path):
    empty = {"utilization": {}, "fmax": {}}
    assert read_summary(tmp_path / "nope.json") == empty
    (tmp_path / "bad.json").write_text("{not json")
    assert read_summary(tmp_path / "bad.json") == empty


def test_non_object_json_is_ignored(tmp_path):
    empty = {"utilization": {}, "fmax": {}}
    # JSON array at top level
    (tmp_path / "array.json").write_text(json.dumps([1, 2, 3]))
    assert read_summary(tmp_path / "array.json") == empty
    # utilization and fmax not dicts
    (tmp_path / "bad_types.json").write_text(json.dumps({"utilization": "oops", "fmax": 3}))
    assert read_summary(tmp_path / "bad_types.json") == empty


def test_non_numeric_used_value_is_skipped(tmp_path):
    p = tmp_path / "report.json"
    p.write_text(json.dumps({"utilization": {"LC": {"used": "5"}}}))
    assert read_summary(p) == {"utilization": {}, "fmax": {}}


def test_non_numeric_achieved_value_is_skipped(tmp_path):
    p = tmp_path / "report.json"
    p.write_text(json.dumps({"fmax": {"c": {"achieved": "n/a"}}}))
    assert read_summary(p) == {"utilization": {}, "fmax": {}}


def test_fifo_report_does_not_hang_and_yields_empty_summary(tmp_path):
    # A sandboxed step could plant a FIFO at report.json instead of a regular
    # file; opening it must not block the caller. Run it in a worker thread
    # with a hard timeout so the test itself fails loudly instead of hanging
    # if the safety check regresses.
    p = tmp_path / "report.json"
    os.mkfifo(p)
    with ThreadPoolExecutor(1) as ex:
        result = ex.submit(read_summary, p).result(timeout=5)
    assert result == {"utilization": {}, "fmax": {}}


def test_oversized_report_is_ignored(tmp_path):
    p = tmp_path / "report.json"
    p.write_text("x" * (2 * 1024 * 1024))
    assert read_summary(p) == {"utilization": {}, "fmax": {}}


def test_one_bad_entry_does_not_drop_the_rest(tmp_path):
    p = tmp_path / "report.json"
    p.write_text(json.dumps({
        "utilization": {"LC": {"used": "5"}, "BRAM": {"used": 2, "available": 8}},
        "fmax": {"bad": {"achieved": "n/a"}, "good": {"achieved": 12.5}},
    }))
    assert read_summary(p) == {
        "utilization": {"BRAM": {"used": 2, "available": 8}},
        "fmax": {"good": 12.5},
    }
