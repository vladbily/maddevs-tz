"""Regression coverage for concurrent edits, live snapshots, and safe registration retries."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import Request
from httpx import AsyncClient

from app.auth import COOKIE_NAME, serializer
from app.database import session_factory
from app.models import Event
from app.routes import statistics_stream
from tests.test_registration import create_event, notifications, register


@pytest.mark.parametrize("field", ["title", "description", "capacity", "starts_at"])
async def test_edit_revision_and_stale_save(organizer: AsyncClient, field: str) -> None:
    """Version every editable change and reject a stale form without losing either field."""
    event = await create_event(organizer)
    path = f"/api/organizer/events/{event['id']}"
    changes = {
        "title": "Новое название",
        "description": "Новое описание",
        "capacity": 2,
        "starts_at": (datetime.now(UTC) + timedelta(days=4)).isoformat(),
    }
    response = await organizer.put(path, json={**event, field: changes[field]})
    assert response.status_code == 200
    saved = response.json()
    assert saved["revision"] == event["revision"] + 1
    stale = await organizer.put(path, json={**event, "description": "Устаревшая вкладка"})
    assert stale.status_code == 409
    assert (await organizer.get(f"/api/events/{event['id']}")).json() == saved
    unchanged = await organizer.put(path, json=saved)
    assert unchanged.status_code == 200
    assert unchanged.json()["revision"] == saved["revision"]
    missing_revision = {key: value for key, value in saved.items() if key != "revision"}
    assert (await organizer.put(path, json=missing_revision)).status_code == 422


async def test_competing_edits_have_one_winner(organizer: AsyncClient) -> None:
    """Serialize two saves of the same revision and preserve exactly the winning edit."""
    event = await create_event(organizer)
    path = f"/api/organizer/events/{event['id']}"
    results = await asyncio.gather(
        organizer.put(path, json={**event, "title": "First editor"}),
        organizer.put(path, json={**event, "description": "Second editor"}),
    )
    assert sorted(response.status_code for response in results) == [200, 409]
    winner = next(response.json() for response in results if response.status_code == 200)
    assert (await organizer.get(f"/api/events/{event['id']}")).json() == winner


async def test_live_snapshot_detects_equal_count_swap(organizer: AsyncClient) -> None:
    """Emit a complete snapshot after equal-count participant replacement and metadata edits."""
    event = await create_event(organizer)
    old = await register(organizer, event["id"], "swap-old@example.com")
    cookie = f"{COOKIE_NAME}={serializer.dumps({'role': 'organizer'})}"
    request = Request(
        {"type": "http", "headers": [(b"cookie", cookie.encode())]},
        receive=AsyncMock(return_value={"type": "http.request"}),
    )
    stream = statistics_stream(request, event["id"])
    try:
        first = json.loads((await anext(stream)).removeprefix("data: "))
        assert (await organizer.post(f"/api{old['manage_url']}/cancel")).status_code == 200
        await register(organizer, event["id"], "swap-new@example.com")
        replaced = json.loads((await asyncio.wait_for(anext(stream), 3)).removeprefix("data: "))
        for key in ("confirmed", "waitlisted", "checked_in"):
            assert replaced[key] == first[key]
        assert replaced["participants_revision"] > first["participants_revision"]
        response = await organizer.put(
            f"/api/organizer/events/{event['id']}",
            json={**event, "title": "Updated live title", "capacity": 3},
        )
        assert response.status_code == 200
        updated = json.loads((await asyncio.wait_for(anext(stream), 3)).removeprefix("data: "))
        assert updated == response.json()
    finally:
        await stream.aclose()


async def test_registration_replay_is_safe_and_atomic(organizer: AsyncClient) -> None:
    """Return one secret to concurrent owners of a key while keeping email duplicates private."""
    event = await create_event(organizer)
    path = f"/api/events/{event['id']}/registrations"
    key = str(uuid4())
    results = await asyncio.gather(
        *(
            organizer.post(path, json={"email": email, "idempotency_key": key})
            for email in (" Owner@Example.com ", "owner@example.com", "OWNER@example.com")
        )
    )
    assert all(response.status_code == 200 for response in results)
    private_url = results[0].json()["manage_url"]
    assert private_url and all(response.json()["manage_url"] == private_url for response in results)
    assert len(await notifications("ticket")) == 1
    duplicate = await organizer.post(
        path, json={"email": "owner@example.com", "idempotency_key": str(uuid4())}
    )
    assert duplicate.status_code == 200
    assert duplicate.json()["manage_url"] is None
    mismatch = await organizer.post(
        path, json={"email": "other@example.com", "idempotency_key": key}
    )
    assert mismatch.status_code == 409
    async with session_factory() as session, session.begin():
        saved = await session.get(Event, event["id"])
        assert saved is not None
        saved.starts_at = datetime.now(UTC) - timedelta(seconds=1)
    replay = await organizer.post(path, json={"email": "owner@example.com", "idempotency_key": key})
    assert replay.status_code == 200
    assert replay.json()["manage_url"] == private_url
    assert len(await notifications("ticket")) == 1


async def test_cancelled_request_cannot_reactivate_or_steal_replacement(
    organizer: AsyncClient,
) -> None:
    """Keep cancelled retries inert and never give an old request a replacement ticket."""
    event = await create_event(organizer)
    path = f"/api/events/{event['id']}/registrations"
    original = {"email": "owner@example.com", "idempotency_key": str(uuid4())}
    first = await organizer.post(path, json=original)
    assert first.status_code == 200
    old_url = first.json()["manage_url"]
    assert (await organizer.post(f"/api{old_url}/cancel")).status_code == 200
    cancelled = await organizer.post(path, json=original)
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    assert not cancelled.json()["created"]
    assert len(await notifications("ticket")) == 1
    replacement = await organizer.post(path, json={**original, "idempotency_key": str(uuid4())})
    assert replacement.status_code == 200
    new_url = replacement.json()["manage_url"]
    assert new_url and new_url != old_url
    stale = await organizer.post(path, json=original)
    assert stale.status_code == 409
    assert (await organizer.get(f"/api{old_url}")).status_code == 404
    assert len(await notifications("ticket")) == 2
    assert (await organizer.post(f"/api{new_url}/cancel")).status_code == 200
    delayed = await organizer.post(path, json=original)
    assert delayed.status_code == 409
    assert len(await notifications("ticket")) == 2
    counts = (await organizer.get(f"/api/organizer/events/{event['id']}/stats")).json()
    assert counts == {"confirmed": 0, "waitlisted": 0, "checked_in": 0}
