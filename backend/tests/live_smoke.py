"""Exercise the real scheduler and SSE through the running Nginx container."""

import asyncio
import json
import sys
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import select, text

from app.auth import MAX_LOGIN_FAILURES
from app.config import settings
from app.database import engine, session_factory
from app.models import Notification

EMAIL = "live-worker@example.com"


async def reminder_count() -> int:
    """Read real reminder records created by the running backend process."""
    async with session_factory() as session:
        rows = await session.scalars(
            select(Notification.id).where(
                Notification.email == EMAIL, Notification.kind == "reminder"
            )
        )
        return len(list(rows))


async def next_snapshot(lines: AsyncIterator[str]) -> dict:
    """Read the next data frame from the HTTP event stream."""
    async for line in lines:
        if line.startswith("data: "):
            return json.loads(line[6:])
    raise AssertionError("SSE closed before a statistics snapshot arrived")


async def main() -> None:
    """Verify actual reminder execution, checkin updates, and stream reconnection."""
    if not settings.database_url.rsplit("/", 1)[-1].endswith("_test"):
        raise RuntimeError("Live smoke checks require an isolated _test database")
    try:
        if "--after-restart" in sys.argv:
            assert await reminder_count() == 1, "Restart duplicated or lost the reminder"
            async with AsyncClient(base_url="http://frontend:8081", timeout=10) as client:
                response = await client.post(
                    "/api/auth/login", json={"password": settings.organizer_password}
                )
                assert response.status_code == 429, "Restart reset the login throttle"
            async with session_factory() as session, session.begin():
                await session.execute(text("DELETE FROM organizer_login"))
            print("Reminder survives backend restart without duplication: PASS")
            print("Organizer lockout survives backend restart: PASS")
            return
        async with AsyncClient(base_url="http://frontend:8081", timeout=10) as client:
            response = await client.post(
                "/api/auth/login", json={"password": settings.organizer_password}
            )
            response.raise_for_status()
            response = await client.post(
                "/api/organizer/events",
                json={
                    "title": "Live smoke",
                    "description": "Real scheduler and SSE check",
                    "starts_at": (datetime.now(UTC) + timedelta(hours=12)).isoformat(),
                    "capacity": 1,
                },
            )
            response.raise_for_status()
            event_id = response.json()["id"]
            response = await client.post(
                f"/api/events/{event_id}/registrations", json={"email": EMAIL}
            )
            response.raise_for_status()
            private_url = response.json()["manage_url"]
            response = await client.get(f"/api{private_url}")
            response.raise_for_status()
            code = response.json()["ticket_code"]
            async with asyncio.timeout(15):
                while await reminder_count() != 1:
                    await asyncio.sleep(0.1)
            async with client.stream("GET", f"/api/organizer/events/{event_id}/stream") as stream:
                assert stream.status_code == 200
                lines = stream.aiter_lines()
                first = await next_snapshot(lines)
                assert first["id"] == event_id
                assert first["capacity"] == 1
                assert {key: first[key] for key in ("confirmed", "waitlisted", "checked_in")} == {
                    "confirmed": 1,
                    "waitlisted": 0,
                    "checked_in": 0,
                }
                response = await client.post(
                    f"/api/organizer/events/{event_id}/checkin", json={"code": code}
                )
                response.raise_for_status()
                async with asyncio.timeout(5):
                    assert (await next_snapshot(lines))["checked_in"] == 1
            async with client.stream("GET", f"/api/organizer/events/{event_id}/stream") as stream:
                assert (await next_snapshot(stream.aiter_lines()))["checked_in"] == 1
            print("Real reminder worker, SSE through Nginx, and reconnect: PASS")
            for _ in range(MAX_LOGIN_FAILURES):
                response = await client.post("/api/auth/login", json={"password": "incorrect"})
            assert response.status_code == 429
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
