"""ASGI entrypoint: uvicorn fpgaweb.main:app"""

import logging

from fpgaweb.api import create_app
from fpgaweb.boards import BoardRegistry
from fpgaweb.chipdb import ChipdbStore
from fpgaweb.config import from_env
from fpgaweb.jobs import JobManager
from fpgaweb.ratelimit import RateLimiter
from fpgaweb.sandbox import run_step

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

settings = from_env()
registry = BoardRegistry(settings.data_dir)
manager = JobManager(settings, run_step=run_step, chipdb=ChipdbStore(settings))
limiter = RateLimiter(settings.rate_n, settings.rate_window_s)
app = create_app(settings, registry, manager, limiter)
