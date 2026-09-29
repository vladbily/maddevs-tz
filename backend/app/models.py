"""Events, registrations, and locally recorded notifications."""

from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class OrganizerLogin(Base):
    """Persist the single organizer's failed attempts across backend restarts."""

    __tablename__ = "organizer_login"
    __table_args__ = (
        CheckConstraint("id = 1", name="single_organizer_login"),
        CheckConstraint("failed_attempts >= 0", name="nonnegative_login_failures"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    failed_attempts: Mapped[int] = mapped_column(default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Event(Base):
    """An event with a fixed number of available places."""

    __tablename__ = "events"
    __table_args__ = (CheckConstraint("capacity > 0", name="positive_capacity"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(String(5000))
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    capacity: Mapped[int]
    revision: Mapped[int] = mapped_column(default=1)
    participants_revision: Mapped[int] = mapped_column(default=0)


class Registration(Base):
    """One reusable registration per normalized email and event."""

    __tablename__ = "registrations"
    __table_args__ = (
        UniqueConstraint("event_id", "email", name="unique_event_email"),
        CheckConstraint("status IN ('confirmed', 'waitlisted', 'cancelled')", name="valid_status"),
        CheckConstraint("email = lower(btrim(email))", name="normalized_email"),
        CheckConstraint("checked_in_at IS NULL OR status = 'confirmed'", name="checkin_confirmed"),
        CheckConstraint(
            "status != 'confirmed' OR ticket_code IS NOT NULL", name="confirmed_ticket"
        ),
        Index("registration_queue", "event_id", "status", "queued_at", "id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"))
    email: Mapped[str] = mapped_column(String(254))
    status: Mapped[str] = mapped_column(String(16))
    queued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ticket_code: Mapped[str | None] = mapped_column(String(32), unique=True)
    manage_token: Mapped[str] = mapped_column(String(64), unique=True)
    checked_in_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RegistrationRequest(Base):
    """Remember request keys across cancellation and replacement registrations."""

    __tablename__ = "registration_requests"

    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"), primary_key=True)
    key_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    registration_id: Mapped[int] = mapped_column(ForeignKey("registrations.id"))
    manage_token: Mapped[str] = mapped_column(String(64))


class Notification(Base):
    """A notification recorded in PostgreSQL instead of sending email."""

    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(primary_key=True)
    registration_id: Mapped[int] = mapped_column(ForeignKey("registrations.id"), index=True)
    email: Mapped[str] = mapped_column(String(254))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    kind: Mapped[str] = mapped_column(String(24))
    code: Mapped[str | None] = mapped_column(String(32))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    dedupe_key: Mapped[str] = mapped_column(String(160), unique=True)
