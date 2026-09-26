"""Session telemetry: target vs measured joints at 10 Hz, for /web/replay.html.

Always kept in memory. If TIGER_DATABASE_URL is set (Tiger Data / TimescaleDB), rows are
also batched into a hypertable from a background task, so the 30 Hz robot loop never waits.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections import deque
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS telemetry (
  t TIMESTAMPTZ NOT NULL, session TEXT NOT NULL, mode TEXT, joint TEXT NOT NULL,
  target DOUBLE PRECISION, measured DOUBLE PRECISION);
SELECT create_hypertable('telemetry', 't', if_not_exists => TRUE);
"""


class Telemetry:
    def __init__(self, keep_s: float = 600, hz: float = 10):
        self.rows: deque = deque(maxlen=int(keep_s * hz))
        self.sessions: dict[str, dict] = {}
        self.session: str | None = None
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=5000)
        self.db = None

    def start_session(self, why: str) -> None:
        self.session = time.strftime("%H%M%S")
        self.sessions[self.session] = {"id": self.session, "start": time.time(), "why": why, "n": 0}

    def end_session(self) -> None:
        self.session = None

    def record(self, mode: str, target: dict, measured: dict) -> None:
        if not self.session:
            return
        row = (time.time(), self.session, mode, dict(target), dict(measured))
        self.rows.append(row)
        self.sessions[self.session]["n"] += 1
        if self.db and not self.queue.full():
            self.queue.put_nowait(row)

    def list(self) -> list[dict]:
        return sorted(self.sessions.values(), key=lambda s: -s["start"])[:20]

    def get(self, session: str) -> list[dict]:
        return [{"t": t, "mode": m, "target": tg, "measured": ms} for t, s, m, tg, ms in self.rows if s == session]

    async def run_writer(self) -> None:
        url = os.environ.get("TIGER_DATABASE_URL")
        if not url:
            return
        try:
            import asyncpg

            self.db = await asyncpg.create_pool(url, min_size=1, max_size=2)
            async with self.db.acquire() as c:
                await c.execute(SCHEMA)
            print("Telemetry: writing to Tiger Data.")
        except Exception as e:
            print(f"Telemetry: Tiger Data off ({e}).")
            self.db = None
            return
        while True:
            batch = [await self.queue.get()]
            while not self.queue.empty() and len(batch) < 500:
                batch.append(self.queue.get_nowait())
            rows = [(datetime.fromtimestamp(t, timezone.utc), s, m, j,
                     tg.get(j), ms.get(j)) for t, s, m, tg, ms in batch for j in set(tg) | set(ms)]
            try:
                async with self.db.acquire() as c:
                    await c.executemany(
                        "INSERT INTO telemetry VALUES ($1, $2, $3, $4, $5, $6)", rows)
            except Exception as e:
                print(f"Telemetry write failed: {e}")
            await asyncio.sleep(1)
