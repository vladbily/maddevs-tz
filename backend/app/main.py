"""FastAPI application entrypoint."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from sqlalchemy import text

from app.database import engine, session_factory
from app.reminders import reminder_loop
from app.routes import router


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Own exactly one reminder task and release resources on shutdown."""
    task = asyncio.create_task(reminder_loop(), name="reminders")
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        await engine.dispose()


app = FastAPI(
    title="Место — регистрация на мероприятия",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    redoc_url=None,
    lifespan=lifespan,
)
app.include_router(router)


@app.get("/api/health")
async def health() -> dict[str, str]:
    """Check that the application can reach PostgreSQL."""
    async with session_factory() as session:
        await session.execute(text("SELECT 1"))
    return {"status": "ok"}
