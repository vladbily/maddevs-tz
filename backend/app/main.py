"""FastAPI application entrypoint."""

from fastapi import FastAPI
from sqlalchemy import text

from app.database import session_factory

app = FastAPI(
    title="Место — регистрация на мероприятия",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    redoc_url=None,
)


@app.get("/api/health")
async def health() -> dict[str, str]:
    """Check that the application can reach PostgreSQL."""
    async with session_factory() as session:
        await session.execute(text("SELECT 1"))
    return {"status": "ok"}
