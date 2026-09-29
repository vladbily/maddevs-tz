"""Typed request and response objects for the HTTP API."""

from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, EmailStr, Field, field_validator

RegistrationStatus = Literal["confirmed", "waitlisted", "cancelled"]


class EventInput(BaseModel):
    """Editable event fields supplied by the organizer."""

    title: str = Field(min_length=1, max_length=160)
    description: str = Field(min_length=1, max_length=5000)
    starts_at: AwareDatetime
    capacity: int = Field(gt=0, le=100_000, strict=True)

    @field_validator("title", "description", mode="before")
    @classmethod
    def strip_text(cls, value: object) -> object:
        """Trim text before checking that required content is present."""
        return value.strip() if isinstance(value, str) else value

    @field_validator("starts_at")
    @classmethod
    def normalize_date(cls, value: datetime) -> datetime:
        """Normalize an explicitly zoned timestamp to UTC."""
        return value.astimezone(UTC)


class EventUpdate(EventInput):
    """Require the version read by an editor before replacing event details."""

    revision: int = Field(ge=1, strict=True)


class Statistics(BaseModel):
    """Live totals calculated from registration rows."""

    confirmed: int
    waitlisted: int
    checked_in: int


class EventOut(EventInput, Statistics):
    """Public event details and aggregate seat counts."""

    id: int
    revision: int
    participants_revision: int


class RegistrationInput(BaseModel):
    """An email address used to reserve one place."""

    email: EmailStr = Field(max_length=254)
    idempotency_key: UUID | None = None

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value: object) -> object:
        """Use the same trimmed lowercase email for every request."""
        return value.strip().lower() if isinstance(value, str) else value


class RegistrationResult(BaseModel):
    """Return a management link for a new registration or an authenticated retry."""

    status: RegistrationStatus
    created: bool
    manage_url: str | None = None


class ParticipantOut(BaseModel):
    """Organizer-visible participant details without management credentials."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    status: RegistrationStatus
    queued_at: datetime
    checked_in_at: datetime | None


class TicketOut(ParticipantOut):
    """Current registration details visible through a secret link."""

    event: EventOut
    ticket_code: str | None


class LoginInput(BaseModel):
    """The single organizer's configured password."""

    password: str = Field(min_length=1, max_length=256)


class CheckinInput(BaseModel):
    """A manually entered ticket code."""

    code: str = Field(min_length=1, max_length=64)

    @field_validator("code", mode="before")
    @classmethod
    def normalize_code(cls, value: object) -> object:
        """Accept pasted ticket codes with spaces and hyphens."""
        if isinstance(value, str):
            return value.replace(" ", "").replace("-", "").strip().upper()
        return value
