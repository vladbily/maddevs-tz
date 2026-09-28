"""Small signed-cookie authentication for one organizer."""

from fastapi import HTTPException, Request
from itsdangerous import BadSignature, URLSafeTimedSerializer

from app.config import settings

COOKIE_NAME = "organizer_session"
serializer = URLSafeTimedSerializer(settings.session_secret, salt="organizer-session")


def require_organizer(request: Request) -> None:
    """Reject missing, expired, or invalid organizer sessions."""
    try:
        payload = serializer.loads(
            request.cookies.get(COOKIE_NAME, ""), max_age=settings.session_max_age
        )
    except BadSignature as error:
        raise HTTPException(401, "Войдите как организатор") from error
    if payload != {"role": "organizer"}:
        raise HTTPException(401, "Войдите как организатор")
