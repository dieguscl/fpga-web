"""Sliding-window rate limiter keyed by client IP."""

import math
import time
from collections import deque
from typing import Callable


class RateLimiter:
    def __init__(self, limit: int, window_s: float, clock: Callable[[], float] = time.monotonic):
        self._limit, self._window, self._clock = limit, window_s, clock
        self._hits: dict[str, deque[float]] = {}

    def _prune(self, now: float) -> None:
        cutoff = now - self._window
        for key in list(self._hits):
            q = self._hits[key]
            while q and q[0] <= cutoff:
                q.popleft()
            if not q:
                del self._hits[key]

    def allow(self, key: str) -> bool:
        now = self._clock()
        self._prune(now)
        q = self._hits.setdefault(key, deque())
        if len(q) >= self._limit:
            return False
        q.append(now)
        return True

    def retry_after(self, key: str) -> int:
        q = self._hits.get(key)
        if not q:
            return 1
        return max(1, math.ceil(q[0] + self._window - self._clock()))
