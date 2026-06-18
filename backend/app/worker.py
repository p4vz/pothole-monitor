"""Production worker entrypoint (RQ). Dev runs the pipeline in-process via queue.py.

    ROADSENSE_USE_RQ=1 ROADSENSE_REDIS_URL=redis://... python -m app.worker
"""
from __future__ import annotations

import os


def main() -> None:
    from redis import Redis  # type: ignore
    from rq import Connection, Worker  # type: ignore

    redis = Redis.from_url(os.environ.get("ROADSENSE_REDIS_URL", "redis://localhost:6379"))
    with Connection(redis):
        Worker(["roadsense"]).work()


if __name__ == "__main__":
    main()
