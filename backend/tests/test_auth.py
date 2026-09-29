"""Verify persistent throttling, browser boundaries, and safe organizer configuration."""

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
from sqlalchemy import select

from app.auth import COOKIE_NAME, LOGIN_LOCK_SECONDS, MAX_LOGIN_FAILURES, serializer
from app.config import Settings, settings
from app.database import session_factory
from app.main import app
from app.models import OrganizerLogin


async def test_concurrent_login_attempts(client: AsyncClient) -> None:
    """Serialize concurrent failures and ignore spoofed IP headers for the global limit."""
    responses = await asyncio.gather(
        *(
            client.post(
                "/api/auth/login",
                json={"password": "wrong"},
                headers={"X-Forwarded-For": f"192.0.2.{index}"},
            )
            for index in range(12)
        )
    )
    assert sum(response.status_code == 401 for response in responses) == MAX_LOGIN_FAILURES - 1
    assert sum(response.status_code == 429 for response in responses) == 13 - MAX_LOGIN_FAILURES
    async with session_factory() as session:
        state = await session.get(OrganizerLogin, 1)
        assert state.failed_attempts == MAX_LOGIN_FAILURES
        locked_until = state.locked_until
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as fresh:
        response = await fresh.post(
            "/api/auth/login", json={"password": settings.organizer_password}
        )
    assert response.status_code == 429
    assert 1 <= int(response.headers["Retry-After"]) <= LOGIN_LOCK_SECONDS
    assert "set-cookie" not in response.headers
    async with session_factory() as session:
        assert (await session.get(OrganizerLogin, 1)).locked_until == locked_until


async def test_expired_lock_allows_login(client: AsyncClient) -> None:
    """Permit login after the cooldown and clear both failure fields."""
    async with session_factory() as session, session.begin():
        session.add(
            OrganizerLogin(
                id=1,
                failed_attempts=MAX_LOGIN_FAILURES,
                locked_until=datetime.now(UTC) - timedelta(seconds=1),
            )
        )
    response = await client.post("/api/auth/login", json={"password": settings.organizer_password})
    assert response.status_code == 200
    async with session_factory() as session:
        state = await session.get(OrganizerLogin, 1)
        assert state.failed_attempts == 0
        assert state.locked_until is None


async def test_success_resets_failure_count(client: AsyncClient) -> None:
    """Reset consecutive failures after a valid login without blocking active sessions."""
    for _ in range(MAX_LOGIN_FAILURES - 1):
        assert (await client.post("/api/auth/login", json={"password": "wrong"})).status_code == 401
    response = await client.post("/api/auth/login", json={"password": settings.organizer_password})
    assert response.status_code == 200
    for _ in range(MAX_LOGIN_FAILURES - 1):
        assert (await client.post("/api/auth/login", json={"password": "wrong"})).status_code == 401
    assert (await client.post("/api/auth/login", json={"password": "wrong"})).status_code == 429
    assert (await client.get("/api/auth/session")).status_code == 200


async def test_cookie_flags_and_logout(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Issue host-only API cookies and clear exactly the same cookie on logout."""
    monkeypatch.setattr(settings, "cookie_secure", True)
    response = await client.post("/api/auth/login", json={"password": settings.organizer_password})
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie and "Secure" in cookie
    assert "Path=/api" in cookie and "Domain=" not in cookie
    monkeypatch.setattr(settings, "cookie_secure", False)
    await client.post("/api/auth/login", json={"password": settings.organizer_password})
    assert (await client.get("/api/auth/session")).status_code == 200
    response = await client.post("/api/auth/logout")
    assert "Path=/api" in response.headers["set-cookie"]
    assert (await client.get("/api/auth/session")).status_code == 401


async def test_forged_session_is_rejected(client: AsyncClient) -> None:
    """Reject modified signatures and signed payloads without the organizer role."""
    for value in ("forged", serializer.dumps({"role": "participant"})):
        response = await client.get(
            "/api/auth/session", headers={"Cookie": f"{COOKIE_NAME}={value}"}
        )
        assert response.status_code == 401


@pytest.mark.parametrize("action", ["login", "logout"])
async def test_legacy_root_cookie_is_removed(action: str) -> None:
    """Remove pre-upgrade cookies so logout cannot fall back to an old valid session."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test.example"
    ) as client:
        client.cookies.set(
            COOKIE_NAME, serializer.dumps({"role": "organizer"}), domain="test.example", path="/"
        )
        assert (await client.get("/api/auth/session")).status_code == 200
        response = await client.post(
            f"/api/auth/{action}", json={"password": settings.organizer_password}
        )
        assert response.status_code == 200
        assert not any(cookie.path == "/" for cookie in client.cookies.jar)
        assert (await client.get("/api/auth/session")).status_code == (
            200 if action == "login" else 401
        )


async def test_unconfigured_organizer_is_disabled(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Keep events public while rejecting passwords and cookies when login is disabled."""
    monkeypatch.setattr(settings, "organizer_password", "")
    assert (await client.post("/api/auth/login", json={"password": "anything"})).status_code == 503
    cookie = serializer.dumps({"role": "organizer"})
    response = await client.get("/api/auth/session", headers={"Cookie": f"{COOKIE_NAME}={cookie}"})
    assert response.status_code == 503
    assert (await client.get("/api/events")).status_code == 200


async def test_browser_origin_boundary(organizer: AsyncClient) -> None:
    """Reject mutations from the public port even if its browser sends an organizer cookie."""
    for path, body in (
        ("/api/auth/login", {"password": settings.organizer_password}),
        ("/api/auth/logout", {}),
        ("/api/organizer/events/1/checkin", {"code": "unknown"}),
    ):
        response = await organizer.post(path, json=body, headers={"Origin": "http://test:8080"})
        assert response.status_code == 403
    assert (await organizer.get("/api/auth/session")).status_code == 200
    response = await organizer.post("/api/auth/logout", headers={"Origin": "http://test"})
    assert response.status_code == 200


async def test_rejected_origin_does_not_consume_attempts(client: AsyncClient) -> None:
    """Keep cross-origin requests from locking out the private organizer login."""
    response = await client.post(
        "/api/auth/login", json={"password": "wrong"}, headers={"Origin": "null"}
    )
    assert response.status_code == 403
    async with session_factory() as session:
        assert await session.scalar(select(OrganizerLogin)) is None


@pytest.mark.parametrize(
    ("password", "secret"),
    [
        ("organizer-local", "s" * 48),
        ("p" * 257, "s" * 48),
        ("p" * 24, ""),
        ("p" * 24, "short"),
        ("p" * 24, "local-development-session-secret-change-me"),
        ("s" * 48, "s" * 48),
    ],
)
def test_unsafe_configuration_rejected(password: str, secret: str) -> None:
    """Fail startup with known or inadequate credentials without echoing their values."""
    with pytest.raises(ValidationError) as failure:
        Settings(_env_file=None, organizer_password=password, session_secret=secret)
    assert "input_value" not in str(failure.value)


def test_empty_configuration_is_public_only() -> None:
    """Allow a fresh one-command startup with organizer access disabled."""
    config = Settings(_env_file=None, organizer_password="", session_secret="")
    assert not config.organizer_password
