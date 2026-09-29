"""Transactional event operations, FIFO promotion, and recorded notifications."""

import secrets
from datetime import UTC, datetime
from hashlib import sha256
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Event, Notification, Registration, RegistrationRequest
from app.schemas import EventInput, EventOut, EventUpdate, RegistrationResult, Statistics, TicketOut


def utcnow() -> datetime:
    """Return the current timezone-aware UTC time."""
    return datetime.now(UTC)


def require_future(starts_at: datetime) -> None:
    """Reject operations that require an event which has not started."""
    if starts_at <= utcnow():
        raise HTTPException(409, "Событие уже началось; выберите будущую дату")


async def get_event(session: AsyncSession, event_id: int, lock: bool = False) -> Event:
    """Find an event and optionally serialize its state changes."""
    query = select(Event).where(Event.id == event_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    event = await session.scalar(query)
    if event is None:
        raise HTTPException(404, "Событие не найдено")
    return event


async def statistics(session: AsyncSession, event_id: int) -> Statistics:
    """Read all attendance counters from one database snapshot."""
    row = (
        await session.execute(
            select(
                func.count().filter(Registration.status == "confirmed"),
                func.count().filter(Registration.status == "waitlisted"),
                func.count().filter(Registration.checked_in_at.is_not(None)),
            ).where(Registration.event_id == event_id)
        )
    ).one()
    return Statistics(confirmed=row[0], waitlisted=row[1], checked_in=row[2])


async def event_out(session: AsyncSession, event: Event) -> EventOut:
    """Read event details, versions, and counts in one database snapshot."""
    row = (
        (
            await session.execute(
                select(
                    *Event.__table__.columns,
                    func.count(Registration.id)
                    .filter(Registration.status == "confirmed")
                    .label("confirmed"),
                    func.count(Registration.id)
                    .filter(Registration.status == "waitlisted")
                    .label("waitlisted"),
                    func.count(Registration.id)
                    .filter(Registration.checked_in_at.is_not(None))
                    .label("checked_in"),
                )
                .outerjoin(Registration, Registration.event_id == Event.id)
                .where(Event.id == event.id)
                .group_by(Event.id)
            )
        )
        .mappings()
        .one()
    )
    return EventOut(**row)


async def notify(
    session: AsyncSession,
    event: Event,
    registration: Registration,
    kind: str,
    key: str,
    created_at: datetime | None = None,
) -> None:
    """Record one notification atomically with its business operation."""
    await session.execute(
        insert(Notification)
        .values(
            registration_id=registration.id,
            email=registration.email,
            created_at=created_at or utcnow(),
            kind=kind,
            code=registration.ticket_code,
            payload={
                "event_id": event.id,
                "title": event.title,
                "starts_at": event.starts_at.isoformat(),
                "status": registration.status,
                "manage_url": f"/tickets/{registration.manage_token}",
            },
            dedupe_key=key,
        )
        .on_conflict_do_nothing(index_elements=[Notification.dedupe_key])
    )


async def promote_waitlist(session: AsyncSession, event: Event) -> None:
    """Fill available places in FIFO order while the event is locked."""
    counts = await statistics(session, event.id)
    available = event.capacity - counts.confirmed
    if available <= 0:
        return
    waiting = await session.scalars(
        select(Registration)
        .where(Registration.event_id == event.id, Registration.status == "waitlisted")
        .order_by(Registration.queued_at, Registration.id)
        .limit(available)
    )
    for registration in waiting:
        registration.status = "confirmed"
        registration.ticket_code = secrets.token_hex(8).upper()
        event.participants_revision += 1
        await session.flush()
        await notify(
            session,
            event,
            registration,
            "ticket",
            f"ticket:{registration.id}:{registration.ticket_code}",
        )


async def create_event(session: AsyncSession, data: EventInput) -> EventOut:
    """Create a future event with positive capacity."""
    async with session.begin():
        require_future(data.starts_at)
        event = Event(**data.model_dump())
        session.add(event)
        await session.flush()
        result = await event_out(session, event)
    return result


async def update_event(session: AsyncSession, event_id: int, data: EventUpdate) -> EventOut:
    """Update an event and record date changes for active participants."""
    async with session.begin():
        event = await get_event(session, event_id, lock=True)
        if data.revision != event.revision:
            raise HTTPException(
                409, "Событие изменено в другой вкладке. Обновите страницу и повторите правки."
            )
        changed = any(
            getattr(event, field) != getattr(data, field)
            for field in ("title", "description", "starts_at", "capacity")
        )
        changed_date = event.starts_at != data.starts_at
        if changed_date:
            require_future(data.starts_at)
        counts = await statistics(session, event_id)
        if data.capacity < counts.confirmed:
            raise HTTPException(409, "Лимит не может быть меньше числа занятых мест")
        if data.capacity != event.capacity:
            require_future(event.starts_at)
        event.title = data.title
        event.description = data.description
        event.starts_at = data.starts_at
        event.capacity = data.capacity
        if changed:
            event.revision += 1
        await session.flush()
        if event.starts_at > utcnow():
            await promote_waitlist(session, event)
        if changed_date:
            active = await session.scalars(
                select(Registration).where(
                    Registration.event_id == event_id,
                    Registration.status != "cancelled",
                )
            )
            for registration in active:
                await notify(
                    session,
                    event,
                    registration,
                    "reschedule",
                    f"reschedule:{event.id}:{event.revision}:{registration.id}",
                )
        result = await event_out(session, event)
    return result


async def register(
    session: AsyncSession, event_id: int, email: str, idempotency_key: UUID | None = None
) -> RegistrationResult:
    """Reserve one place or append to the waiting list without duplicates."""
    async with session.begin():
        event = await get_event(session, event_id, lock=True)
        key_hash = sha256(str(idempotency_key).encode()).hexdigest() if idempotency_key else None
        if key_hash:
            request = await session.get(RegistrationRequest, (event_id, key_hash))
            if request is not None:
                previous = await session.get(Registration, request.registration_id)
                assert previous is not None
                if previous.email != email:
                    raise HTTPException(409, "Повтор запроса должен использовать тот же email")
                if previous.manage_token != request.manage_token:
                    raise HTTPException(409, "Этот запрос относится к отменённой регистрации")
                return RegistrationResult(
                    status=previous.status,
                    created=False,
                    manage_url=f"/tickets/{previous.manage_token}",
                )
        require_future(event.starts_at)
        registration = await session.scalar(
            select(Registration).where(
                Registration.event_id == event_id, Registration.email == email
            )
        )
        if registration is not None and registration.status != "cancelled":
            return RegistrationResult(status=registration.status, created=False)
        if registration is None:
            registration = Registration(event_id=event_id, email=email)
            session.add(registration)
        registration.status = "waitlisted"
        registration.queued_at = utcnow()
        registration.ticket_code = None
        registration.checked_in_at = None
        registration.manage_token = secrets.token_urlsafe(32)
        event.participants_revision += 1
        await session.flush()
        if key_hash:
            session.add(
                RegistrationRequest(
                    event_id=event_id,
                    key_hash=key_hash,
                    registration_id=registration.id,
                    manage_token=registration.manage_token,
                )
            )
        await promote_waitlist(session, event)
        if registration.status == "waitlisted":
            await notify(
                session,
                event,
                registration,
                "waitlist",
                f"waitlist:{registration.id}:{registration.manage_token}",
            )
        result = RegistrationResult(
            status=registration.status,
            created=True,
            manage_url=f"/tickets/{registration.manage_token}",
        )
    return result


async def get_ticket(session: AsyncSession, token: str) -> TicketOut:
    """Read a registration only through its current secret management link."""
    registration = await session.scalar(
        select(Registration).where(Registration.manage_token == token)
    )
    if registration is None:
        raise HTTPException(404, "Ссылка на регистрацию недействительна")
    event = await get_event(session, registration.event_id)
    return TicketOut(
        id=registration.id,
        email=registration.email,
        status=registration.status,
        queued_at=registration.queued_at,
        checked_in_at=registration.checked_in_at,
        ticket_code=registration.ticket_code,
        event=await event_out(session, event),
    )


async def cancel(session: AsyncSession, token: str) -> dict[str, str]:
    """Cancel once and give the released place to the first waiting person."""
    async with session.begin():
        event_id = await session.scalar(
            select(Registration.event_id).where(Registration.manage_token == token)
        )
        if event_id is None:
            raise HTTPException(404, "Ссылка на регистрацию недействительна")
        event = await get_event(session, event_id, lock=True)
        registration = await session.scalar(
            select(Registration).where(Registration.manage_token == token)
        )
        if registration is None:
            raise HTTPException(404, "Ссылка на регистрацию недействительна")
        if registration.status == "cancelled":
            return {"status": "cancelled"}
        require_future(event.starts_at)
        if registration.checked_in_at is not None:
            raise HTTPException(409, "Нельзя отменить участие после чекина")
        registration.status = "cancelled"
        registration.ticket_code = None
        event.participants_revision += 1
        await session.flush()
        await promote_waitlist(session, event)
    return {"status": "cancelled"}


async def checkin(session: AsyncSession, event_id: int, code: str) -> dict[str, str]:
    """Mark a valid ticket exactly once under the event lock."""
    async with session.begin():
        event = await get_event(session, event_id, lock=True)
        registration = await session.scalar(
            select(Registration).where(
                Registration.event_id == event_id,
                Registration.ticket_code == code,
                Registration.status == "confirmed",
            )
        )
        if registration is None:
            raise HTTPException(404, "Билет не найден или недействителен")
        if registration.checked_in_at is not None:
            raise HTTPException(409, "Билет уже использован")
        registration.checked_in_at = utcnow()
        event.participants_revision += 1
        email = registration.email
    return {"status": "checked_in", "email": email}
