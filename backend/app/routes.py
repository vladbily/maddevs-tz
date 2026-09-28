"""Public participant routes and protected organizer endpoints."""

import asyncio
import secrets
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import services
from app.auth import COOKIE_NAME, require_organizer, serializer
from app.config import settings
from app.database import get_session, session_factory
from app.models import Event, Registration
from app.schemas import (
    CheckinInput,
    EventInput,
    EventOut,
    LoginInput,
    ParticipantOut,
    RegistrationInput,
    RegistrationResult,
    Statistics,
    TicketOut,
)

router = APIRouter(prefix="/api")
organizer = APIRouter(prefix="/organizer", dependencies=[Depends(require_organizer)])
Session = Annotated[AsyncSession, Depends(get_session)]


@router.post("/auth/login")
async def login(data: LoginInput, response: Response) -> dict[str, bool]:
    """Issue a signed organizer session after verifying the configured password."""
    if not secrets.compare_digest(data.password.encode(), settings.organizer_password.encode()):
        raise HTTPException(401, "Неверный пароль")
    response.set_cookie(
        COOKIE_NAME,
        serializer.dumps({"role": "organizer"}),
        max_age=settings.session_max_age,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
    )
    return {"authenticated": True}


@router.get("/auth/session", dependencies=[Depends(require_organizer)])
async def auth_session() -> dict[str, bool]:
    """Confirm that the browser has an active organizer session."""
    return {"authenticated": True}


@router.post("/auth/logout")
async def logout(response: Response) -> dict[str, bool]:
    """Remove the organizer cookie from the browser."""
    response.delete_cookie(COOKIE_NAME, httponly=True, samesite="strict")
    return {"authenticated": False}


@router.get("/events", response_model=list[EventOut])
async def list_events(session: Session) -> list[EventOut]:
    """List events with public aggregate registration totals."""
    events = await session.scalars(select(Event).order_by(Event.starts_at, Event.id))
    return [await services.event_out(session, event) for event in events]


@router.get("/events/{event_id}", response_model=EventOut)
async def read_event(event_id: int, session: Session) -> EventOut:
    """Show public details for one event."""
    return await services.event_out(session, await services.get_event(session, event_id))


@router.post("/events/{event_id}/registrations", response_model=RegistrationResult)
async def register(event_id: int, data: RegistrationInput, session: Session) -> RegistrationResult:
    """Register an email once and return a new management link when applicable."""
    return await services.register(session, event_id, str(data.email).lower())


@router.get("/tickets/{token}", response_model=TicketOut)
async def ticket(token: str, session: Session) -> TicketOut:
    """Show current ticket or waitlist details through a secret link."""
    return await services.get_ticket(session, token)


@router.post("/tickets/{token}/cancel")
async def cancel(token: str, session: Session) -> dict[str, str]:
    """Cancel participation through a secret management link."""
    return await services.cancel(session, token)


@organizer.post("/events", response_model=EventOut, status_code=201)
async def create_event(data: EventInput, session: Session) -> EventOut:
    """Create an event for the authenticated organizer."""
    return await services.create_event(session, data)


@organizer.put("/events/{event_id}", response_model=EventOut)
async def update_event(event_id: int, data: EventInput, session: Session) -> EventOut:
    """Save event details and notify participants about schedule changes."""
    return await services.update_event(session, event_id, data)


@organizer.get("/events/{event_id}/participants", response_model=list[ParticipantOut])
async def participants(event_id: int, session: Session) -> list[Registration]:
    """List participants without exposing their ticket and management secrets."""
    await services.get_event(session, event_id)
    return list(
        await session.scalars(
            select(Registration)
            .where(Registration.event_id == event_id)
            .order_by(Registration.queued_at, Registration.id)
        )
    )


@organizer.get("/events/{event_id}/stats", response_model=Statistics)
async def stats(event_id: int, session: Session) -> Statistics:
    """Return current registration, waiting, and attendance counts."""
    await services.get_event(session, event_id)
    return await services.statistics(session, event_id)


async def statistics_stream(request: Request, event_id: int) -> AsyncIterator[str]:
    """Emit changed counters while releasing database sessions between checks."""
    previous = ""
    idle_ticks = 0
    while not await request.is_disconnected():
        try:
            require_organizer(request)
        except HTTPException:
            yield "event: expired\ndata: {}\n\n"
            return
        async with session_factory() as session:
            counts = await services.statistics(session, event_id)
        current = counts.model_dump_json()
        if current != previous:
            yield f"data: {current}\n\n"
            previous = current
            idle_ticks = 0
        else:
            idle_ticks += 1
            if idle_ticks >= 15:
                yield ": heartbeat\n\n"
                idle_ticks = 0
        await asyncio.sleep(1)


@organizer.get("/events/{event_id}/stream")
async def stream(event_id: int, request: Request) -> StreamingResponse:
    """Open a reconnectable live statistics stream for the organizer."""
    async with session_factory() as session:
        await services.get_event(session, event_id)
    return StreamingResponse(
        statistics_stream(request, event_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@organizer.post("/events/{event_id}/checkin")
async def checkin(event_id: int, data: CheckinInput, session: Session) -> dict[str, str]:
    """Check in one participant with a manually entered ticket code."""
    return await services.checkin(session, event_id, data.code)


router.include_router(organizer)
