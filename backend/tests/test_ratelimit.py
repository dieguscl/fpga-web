from fpgaweb.ratelimit import RateLimiter


def test_sliding_window():
    now = [0.0]
    rl = RateLimiter(2, 10, clock=lambda: now[0])
    assert rl.allow("a") and rl.allow("a")
    assert not rl.allow("a")
    assert rl.allow("b")
    now[0] = 9.9
    assert not rl.allow("a")
    assert rl.retry_after("a") == 1
    now[0] = 10.1
    assert rl.allow("a")


def test_rejected_hits_are_not_recorded():
    now = [0.0]
    rl = RateLimiter(1, 10, clock=lambda: now[0])
    assert rl.allow("a")
    for _ in range(5):
        assert not rl.allow("a")
    now[0] = 10.5
    assert rl.allow("a")


def test_idle_keys_are_pruned():
    now = [0.0]
    rl = RateLimiter(1, 10, clock=lambda: now[0])
    rl.allow("a")
    now[0] = 100
    rl.allow("b")
    assert "a" not in rl._hits
