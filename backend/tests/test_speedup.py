from fpgaweb.speedup import scale_bits, scale_netlist


def bits(v, w):
    return [str((v >> i) & 1) for i in range(w)]


def test_scales_large_constants_only():
    assert scale_bits(bits(49_999_999, 26), 1000) == bits(50_000, 26)
    assert scale_bits(bits(868, 10), 10) is None  # below MIN_VALUE: e.g. a baud divider
    assert scale_bits(bits(5_000, 13), 1000) is None  # would become < 10
    assert scale_bits(["1", "x"], 10) is None  # not a pure constant


def test_scale_netlist_touches_comparisons():
    net = {"modules": {"top": {"cells": {
        "c1": {"type": "$eq", "connections": {"A": [2, 3], "B": bits(100_000, 17)}},
        "c2": {"type": "$add", "connections": {"A": [2], "B": bits(100_000, 17)}},
    }}}}
    assert scale_netlist(net, 100) == 1
    cells = net["modules"]["top"]["cells"]
    assert cells["c1"]["connections"]["B"] == bits(1000, 17)
    assert cells["c2"]["connections"]["B"] == bits(100_000, 17)
