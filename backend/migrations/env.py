"""Run Alembic migrations through an async PostgreSQL connection."""

import asyncio

from alembic import context
from sqlalchemy import Connection

from app import models  # noqa: F401
from app.config import settings
from app.database import Base, engine


def migrate(connection: Connection) -> None:
    """Apply migrations using the connection managed by SQLAlchemy."""
    context.configure(connection=connection, target_metadata=Base.metadata)
    with context.begin_transaction():
        context.run_migrations()


async def migrate_online() -> None:
    """Open an async connection and run schema changes."""
    async with engine.connect() as connection:
        await connection.run_sync(migrate)
    await engine.dispose()


if context.is_offline_mode():
    context.configure(url=settings.database_url, target_metadata=Base.metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    asyncio.run(migrate_online())
