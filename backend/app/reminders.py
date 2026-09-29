"""One restart-safe background loop for due reminder records."""

import asyncio
import logging
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.database import session_factory
from app.models import Event, Notification, Registration
from app.services import get_event, notify, utcnow

logger = logging.getLogger(__name__)


async def run_reminders(
    factory: async_sessionmaker[AsyncSession] = session_factory,
    now: datetime | None = None,
) -> None:
    """Record due reminders once, rechecking each event after acquiring its lock."""
    check_time = now or utcnow()
    async with factory() as session:
        event_ids = list(
            await session.scalars(
                select(Event.id)
                .where(
                    Event.starts_at > check_time,
                    Event.starts_at <= check_time + timedelta(hours=24),
                )
                .order_by(Event.id)
            )
        )
    for event_id in event_ids:
        async with factory() as session, session.begin():
            event = await get_event(session, event_id, lock=True)
            locked_time = now or utcnow()
            if not locked_time < event.starts_at <= locked_time + timedelta(hours=24):
                continue
            participants = await session.scalars(
                select(Registration).where(
                    Registration.event_id == event_id,
                    Registration.status.in_(("confirmed", "waitlisted")),
                    ~select(Notification.id)
                    .where(
                        Notification.registration_id == Registration.id,
                        Notification.kind == "reminder",
                    )
                    .exists(),
                )
            )
            for registration in participants:
                await notify(
                    session,
                    event,
                    registration,
                    "reminder",
                    f"reminder:{registration.id}",
                    created_at=locked_time,
                )


async def reminder_loop() -> None:
    """Run one bounded reminder pass per interval and recover from transient errors."""
    while True:
        try:
            await run_reminders()
        except Exception:
            logger.exception("Reminder pass failed; retrying on the next interval")
        await asyncio.sleep(settings.reminder_interval)
