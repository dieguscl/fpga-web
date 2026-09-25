import json

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
