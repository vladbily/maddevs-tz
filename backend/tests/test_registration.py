"""Transactional API scenarios using independent concurrent database sessions."""

import asyncio
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from app import reminders, services
from app.database import session_factory
from app.main import app
from app.models import Event, Notification, Registration
from app.reminders import run_reminders
from app.schemas import EventInput


async def create_event(client: AsyncClient, capacity: int = 1, hours: int = 48) -> dict:
    """Create a future event through the organizer API."""
    response = await client.post(
        "/api/organizer/events",
        json={
            "title": "Встреча разработчиков",
            "description": "Обсудим интересные проекты.",
            "starts_at": (datetime.now(UTC) + timedelta(hours=hours)).isoformat(),
            "capacity": capacity,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


async def register(client: AsyncClient, event_id: int, email: str) -> dict:
    """Register a participant and return the API result."""
    response = await client.post(f"/api/events/{event_id}/registrations", json={"email": email})
    assert response.status_code == 200, response.text
    return response.json()


async def ticket(client: AsyncClient, registration: dict) -> dict:
    """Read current registration details through its private link."""
    response = await client.get(f"/api{registration['manage_url']}")
    assert response.status_code == 200, response.text
    return response.json()


async def notifications(kind: str) -> list[Notification]:
    """Read recorded messages of one type from the isolated test database."""
    async with session_factory() as session:
        return list(await session.scalars(select(Notification).where(Notification.kind == kind)))


async def simultaneous_registrations(event_id: int, emails: list[str]) -> list[dict]:
    """Release independent HTTP clients together to exercise PostgreSQL locks."""
    barrier = asyncio.Barrier(len(emails))

    async def attempt(email: str) -> dict:
        """Send one registration after all competing requests are ready."""
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as browser:
            await barrier.wait()
            return await register(browser, event_id, email)

    return await asyncio.gather(*(attempt(email) for email in emails))


async def test_registration_and_email_duplicates(organizer: AsyncClient) -> None:
    """Normalize email and keep one place, ticket, and notification for retries."""
    event = await create_event(organizer, capacity=2)
    first = await register(organizer, event["id"], "  ALICE@Example.com  ")
    duplicate = await register(organizer, event["id"], "alice@example.com")
    assert first["status"] == "confirmed"
    assert duplicate == {"status": "confirmed", "created": False, "manage_url": None}
    messages = await notifications("ticket")
    assert len(messages) == 1
    assert messages[0].email == "alice@example.com"
    assert messages[0].code == (await ticket(organizer, first))["ticket_code"]
    assert messages[0].payload["manage_url"] == first["manage_url"]


async def test_concurrent_duplicate_email(organizer: AsyncClient) -> None:
    """Concurrent retries cannot reserve a second place for the same email."""
    event = await create_event(organizer, capacity=2)
    results = await simultaneous_registrations(event["id"], ["a@example.com", "A@example.com"])
    assert sum(result["created"] for result in results) == 1
    assert len(await notifications("ticket")) == 1


async def test_last_seat(organizer: AsyncClient) -> None:
    """Exactly one concurrent participant wins the last available seat."""
    event = await create_event(organizer)
    results = await simultaneous_registrations(event["id"], ["a@example.com", "b@example.com"])
    assert sorted(result["status"] for result in results) == ["confirmed", "waitlisted"]
    stats = (await organizer.get(f"/api/organizer/events/{event['id']}/stats")).json()
    assert stats == {"confirmed": 1, "waitlisted": 1, "checked_in": 0}


async def test_cancellation_promotes_fifo_once(organizer: AsyncClient) -> None:
    """Cancel once, promote the oldest waiter, and keep repeated cancellation harmless."""
    event = await create_event(organizer)
    a = await register(organizer, event["id"], "a@example.com")
    b = await register(organizer, event["id"], "b@example.com")
    c = await register(organizer, event["id"], "c@example.com")
    for _ in range(2):
        response = await organizer.post(f"/api{a['manage_url']}/cancel")
        assert response.status_code == 200
    assert (await ticket(organizer, b))["status"] == "confirmed"
    assert (await ticket(organizer, c))["status"] == "waitlisted"
    assert len(await notifications("ticket")) == 2
    assert (await organizer.post(f"/api{c['manage_url']}/cancel")).status_code == 200
    assert (await ticket(organizer, b))["status"] == "confirmed"


async def test_new_registration_cannot_jump_queue(organizer: AsyncClient) -> None:
    """A concurrent newcomer cannot take the seat owed to an existing waiter."""
    event = await create_event(organizer)
    a = await register(organizer, event["id"], "a@example.com")
    b = await register(organizer, event["id"], "b@example.com")
    await asyncio.gather(
        organizer.post(f"/api{a['manage_url']}/cancel"),
        register(organizer, event["id"], "c@example.com"),
    )
    assert (await ticket(organizer, b))["status"] == "confirmed"
    stats = (await organizer.get(f"/api/organizer/events/{event['id']}/stats")).json()
    assert stats == {"confirmed": 1, "waitlisted": 1, "checked_in": 0}


async def test_reregistration_invalidates_old_secrets(organizer: AsyncClient) -> None:
    """Reusing a cancelled registration rotates secrets and preserves reminder history."""
    event = await create_event(organizer, capacity=2, hours=12)
    old = await register(organizer, event["id"], "a@example.com")
    old_ticket = await ticket(organizer, old)
    await run_reminders()
    await organizer.post(f"/api{old['manage_url']}/cancel")
    new = await register(organizer, event["id"], "a@example.com")
    new_ticket = await ticket(organizer, new)
    assert new_ticket["id"] == old_ticket["id"]
    assert new_ticket["ticket_code"] != old_ticket["ticket_code"]
    assert (await organizer.get(f"/api{old['manage_url']}")).status_code == 404
    assert (await organizer.post(f"/api{old['manage_url']}/cancel")).status_code == 404
    assert (
        await organizer.post(
            f"/api/organizer/events/{event['id']}/checkin", json={"code": old_ticket["ticket_code"]}
        )
    ).status_code == 404
    await run_reminders()
    assert len(await notifications("reminder")) == 1
    assert len(await notifications("ticket")) == 2


async def test_checkin_once_and_no_cancellation(organizer: AsyncClient) -> None:
    """Concurrent checkins increment attendance once and prevent later cancellation."""
    event = await create_event(organizer)
    registration = await register(organizer, event["id"], "a@example.com")
    code = (await ticket(organizer, registration))["ticket_code"]
    results = await asyncio.gather(
        *(
            organizer.post(f"/api/organizer/events/{event['id']}/checkin", json={"code": code})
            for _ in range(2)
        )
    )
    assert sorted(response.status_code for response in results) == [200, 409]
    assert (await organizer.post(f"/api{registration['manage_url']}/cancel")).status_code == 409
    stats = (await organizer.get(f"/api/organizer/events/{event['id']}/stats")).json()
    assert stats["checked_in"] == 1


@pytest.mark.parametrize("seconds,expected", [(86401, 0), (86400, 1), (1, 1), (0, 0)])
async def test_reminder_boundary(organizer: AsyncClient, seconds: int, expected: int) -> None:
    """Create reminders exactly inside the open-start and inclusive-24-hour window."""
    event = await create_event(organizer)
    await register(organizer, event["id"], "a@example.com")
    await register(organizer, event["id"], "waiting@example.com")
    now = datetime.fromisoformat(event["starts_at"]) - timedelta(seconds=seconds)
    await run_reminders(now=now)
    await run_reminders(now=now)
    messages = await notifications("reminder")
    assert len(messages) == expected
    assert all(message.email == "a@example.com" for message in messages)


async def test_reminder_reschedule_and_late_promotion(organizer: AsyncClient) -> None:
    """Moving dates defers unsent reminders and never duplicates an existing one."""
    event = await create_event(organizer, hours=12)
    a = await register(organizer, event["id"], "a@example.com")
    await register(organizer, event["id"], "b@example.com")
    event["starts_at"] = (datetime.now(UTC) + timedelta(days=3)).isoformat()
    assert (
        await organizer.put(f"/api/organizer/events/{event['id']}", json=event)
    ).status_code == 200
    await run_reminders()
    assert len(await notifications("reminder")) == 0
    event["starts_at"] = (datetime.now(UTC) + timedelta(hours=10)).isoformat()
    await organizer.put(f"/api/organizer/events/{event['id']}", json=event)
    await run_reminders()
    assert len(await notifications("reminder")) == 1
    await organizer.post(f"/api{a['manage_url']}/cancel")
    await run_reminders()
    assert len(await notifications("reminder")) == 2
    event["starts_at"] = (datetime.now(UTC) + timedelta(hours=20)).isoformat()
    await organizer.put(f"/api/organizer/events/{event['id']}", json=event)
    await run_reminders()
    assert len(await notifications("reminder")) == 2


async def test_reminder_pass_skips_existing_messages(
    organizer: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Avoid attempted notification writes after all due participants were notified."""
    event = await create_event(organizer, hours=12)
    await register(organizer, event["id"], "a@example.com")
    recorder = AsyncMock(wraps=reminders.notify)
    monkeypatch.setattr(reminders, "notify", recorder)
    await run_reminders()
    await run_reminders()
    assert recorder.await_count == 1


async def test_reschedule_notifications(organizer: AsyncClient) -> None:
    """Notify confirmed and waiting participants only when the date actually changes."""
    event = await create_event(organizer)
    await register(organizer, event["id"], "a@example.com")
    await register(organizer, event["id"], "b@example.com")
    cancelled = await register(organizer, event["id"], "c@example.com")
    await organizer.post(f"/api{cancelled['manage_url']}/cancel")
    original_date = event["starts_at"]
    event["starts_at"] = (datetime.now(UTC) + timedelta(days=4)).isoformat()
    for _ in range(2):
        assert (
            await organizer.put(f"/api/organizer/events/{event['id']}", json=event)
        ).status_code == 200
    messages = await notifications("reschedule")
    assert sorted(message.email for message in messages) == ["a@example.com", "b@example.com"]
    assert datetime.fromisoformat(messages[0].payload["starts_at"]) == datetime.fromisoformat(
        event["starts_at"]
    )
    assert next(message for message in messages if message.email == "b@example.com").code is None
    event["starts_at"] = original_date
    await organizer.put(f"/api/organizer/events/{event['id']}", json=event)
    assert len(await notifications("reschedule")) == 4


async def test_capacity_and_validation(organizer: AsyncClient) -> None:
    """Reject overfull limits and promote waiting participants after a capacity increase."""
    event = await create_event(organizer)
    await register(organizer, event["id"], "a@example.com")
    b = await register(organizer, event["id"], "b@example.com")
    event["capacity"] = 2
    assert (
        await organizer.put(f"/api/organizer/events/{event['id']}", json=event)
    ).status_code == 200
    assert (await ticket(organizer, b))["status"] == "confirmed"
    event["capacity"] = 1
    assert (
        await organizer.put(f"/api/organizer/events/{event['id']}", json=event)
    ).status_code == 409
    event["capacity"] = 0
    assert (await organizer.post("/api/organizer/events", json=event)).status_code == 422
    event["capacity"] = 1
    event["starts_at"] = "2030-01-01T12:00:00"
    assert (await organizer.post("/api/organizer/events", json=event)).status_code == 422


async def test_rollbacks_leave_no_partial_registration(
    organizer: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Roll back a new registration when recording its notification fails."""
    event = await create_event(organizer)
    monkeypatch.setattr(
        services, "notify", AsyncMock(side_effect=RuntimeError("simulated failure"))
    )
    with pytest.raises(RuntimeError):
        await register(organizer, event["id"], "a@example.com")
    async with session_factory() as session:
        assert await session.scalar(select(func.count()).select_from(Registration)) == 0
        assert await session.scalar(select(func.count()).select_from(Notification)) == 0


async def test_rollbacks_restore_promotion_and_schedule(
    organizer: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep registrations and schedule intact when promotion or reschedule recording fails."""
    event = await create_event(organizer)
    a = await register(organizer, event["id"], "a@example.com")
    b = await register(organizer, event["id"], "b@example.com")
    monkeypatch.setattr(
        services, "notify", AsyncMock(side_effect=RuntimeError("simulated failure"))
    )
    with pytest.raises(RuntimeError):
        await organizer.post(f"/api{a['manage_url']}/cancel")
    assert (await ticket(organizer, a))["status"] == "confirmed"
    assert (await ticket(organizer, b))["status"] == "waitlisted"
    data = EventInput.model_validate({**event, "starts_at": datetime.now(UTC) + timedelta(days=5)})
    with pytest.raises(RuntimeError):
        async with session_factory() as session:
            await services.update_event(session, event["id"], data)
    async with session_factory() as session:
        saved = await session.get(Event, event["id"])
        assert saved is not None
        assert saved.starts_at == datetime.fromisoformat(event["starts_at"])
        assert saved.revision == 1


async def test_organizer_access(client: AsyncClient) -> None:
    """Require an organizer cookie for private endpoints and reject wrong passwords."""
    assert (await client.post("/api/auth/login", json={"password": "wrong"})).status_code == 401
    for path in [
        "/api/auth/session",
        "/api/organizer/events/1/stats",
        "/api/organizer/events/1/participants",
        "/api/organizer/events/1/stream",
    ]:
        assert (await client.get(path)).status_code == 401
    assert (
        await client.post("/api/organizer/events/1/checkin", json={"code": "unknown"})
    ).status_code == 401
    assert (await client.get("/api/events")).status_code == 200


async def test_registration_closes_at_start(organizer: AsyncClient) -> None:
    """Prevent registration and cancellation once an event has started."""
    event = await create_event(organizer)
    a = await register(organizer, event["id"], "a@example.com")
    async with session_factory() as session, session.begin():
        saved = await session.get(Event, event["id"])
        assert saved is not None
        saved.starts_at = datetime.now(UTC) - timedelta(seconds=1)
    assert (
        await organizer.post(
            f"/api/events/{event['id']}/registrations", json={"email": "b@example.com"}
        )
    ).status_code == 409
    assert (await organizer.post(f"/api{a['manage_url']}/cancel")).status_code == 409
