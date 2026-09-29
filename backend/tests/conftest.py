"""Isolated real-PostgreSQL fixtures for API and race-condition tests."""

import os
from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

test_url = os.environ.get("TEST_DATABASE_URL", "")
if not test_url.rsplit("/", 1)[-1].endswith("_test"):
    raise RuntimeError("TEST_DATABASE_URL must point to an isolated database ending in _test")
os.environ["DATABASE_URL"] = test_url

from app.config import settings  # noqa: E402
from app.database import engine, session_factory  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(autouse=True)
async def clean_database() -> AsyncIterator[None]:
    """Clear only the explicitly configured test database around every test."""
    async with session_factory() as session, session.begin():
        await session.execute(
            text(
                "TRUNCATE organizer_login, notifications, registration_requests, "
                "registrations, events RESTART IDENTITY"
            )
        )
    yield
    async with session_factory() as session, session.begin():
        await session.execute(
            text(
                "TRUNCATE organizer_login, notifications, registration_requests, "
                "registrations, events RESTART IDENTITY"
            )
        )
    await engine.dispose()


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    """Serve API requests without starting the real background scheduler."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as browser:
        yield browser


@pytest.fixture
async def organizer(client: AsyncClient) -> AsyncClient:
    """Authenticate a client using the test organizer password."""
    response = await client.post("/api/auth/login", json={"password": settings.organizer_password})
    assert response.status_code == 200
    return client
