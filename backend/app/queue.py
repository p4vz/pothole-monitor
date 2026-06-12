"""Job dispatch indirection.

Dev: run the pipeline in a background thread so ingestion stays non-blocking.
Production: set ROADSENSE_USE_RQ and run `python -m app.worker` against Redis;
`enqueue` then pushes the job instead of running it in-process.
"""
from __future__ import annotations

import os
import threading

from .pipeline import process_batch


def enqueue(batch_id: str) -> None:
    if os.environ.get("ROADSENSE_USE_RQ"):
        from redis import Redis  # type: ignore
        from rq import Queue  # type: ignore

        q = Queue("roadsense", connection=Redis.from_url(os.environ["ROADSENSE_REDIS_URL"]))
        q.enqueue(process_batch, batch_id)
        return

    threading.Thread(target=process_batch, args=(batch_id,), daemon=True).start()
