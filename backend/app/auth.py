"""Signed-cookie authentication and persistent login throttling for one organizer."""

import math
import secrets
from datetime import timedelta

from fastapi import HTTPException, Request
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from app.config import settings
from app.database import session_factory
from app.models import OrganizerLogin

COOKIE_NAME = "organizer_session"
MAX_LOGIN_FAILURES = 5
LOGIN_LOCK_SECONDS = 900
serializer = URLSafeTimedSerializer(settings.session_secret, salt="organizer-session")


def require_login_enabled() -> None:
    """Reject every organizer session until independent secrets are configured."""
    if not settings.organizer_password:
        raise HTTPException(503, "Вход организатора не настроен")


def require_same_origin(request: Request) -> None:
    """Reject browser mutations originating from another host or port."""
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    origin = request.headers.get("origin")
    host = request.headers.get("host", "")
    if origin is not None and origin not in {f"http://{host}", f"https://{host}"}:
        raise HTTPException(403, "Запрос должен быть отправлен из кабинета организатора")


async def authenticate_organizer(password: str) -> None:
    """Serialize password checks and commit failures before returning an error."""
    require_login_enabled()
    error = None
    async with session_factory() as session, session.begin():
        await session.execute(
            insert(OrganizerLogin).values(id=1, failed_attempts=0).on_conflict_do_nothing()
        )
        state = await session.scalar(
            select(OrganizerLogin).where(OrganizerLogin.id == 1).with_for_update()
        )
        now = await session.scalar(select(func.clock_timestamp()))
        if state.locked_until is not None and state.locked_until <= now:
            state.failed_attempts = 0
            state.locked_until = None
        if state.locked_until is None:
            if secrets.compare_digest(password.encode(), settings.organizer_password.encode()):
                state.failed_attempts = 0
            else:
                state.failed_attempts += 1
                error = HTTPException(401, "Неверный пароль")
                if state.failed_attempts >= MAX_LOGIN_FAILURES:
                    state.locked_until = now + timedelta(seconds=LOGIN_LOCK_SECONDS)
        if state.locked_until is not None:
            retry_after = max(1, math.ceil((state.locked_until - now).total_seconds()))
            error = HTTPException(
                429,
                f"Слишком много попыток. Повторите вход через {math.ceil(retry_after / 60)} мин.",
                headers={"Retry-After": str(retry_after)},
            )
    if error is not None:
        raise error


def require_organizer(request: Request) -> None:
    """Reject missing, expired, or invalid organizer sessions."""
    require_login_enabled()
    try:
        payload = serializer.loads(
            request.cookies.get(COOKIE_NAME, ""), max_age=settings.session_max_age
        )
    except BadSignature as error:
        raise HTTPException(401, "Войдите как организатор") from error
    if payload != {"role": "organizer"}:
        raise HTTPException(401, "Войдите как организатор")
