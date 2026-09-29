"""Application configuration with local development defaults."""

from typing import Self

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Read service settings from the environment."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", hide_input_in_errors=True)

    database_url: str = "postgresql+asyncpg://events:events@postgres:5432/events"
    organizer_password: str = Field(default="", repr=False)
    session_secret: str = Field(default="", repr=False)
    cookie_secure: bool = False
    session_max_age: int = 28_800
    reminder_interval: float = 10.0

    @model_validator(mode="after")
    def validate_organizer_secrets(self) -> Self:
        """Disable unconfigured login and reject weak or previously published secrets."""
        if self.organizer_password:
            if not 16 <= len(self.organizer_password) <= 256:
                raise ValueError("ORGANIZER_PASSWORD must contain 16 to 256 characters")
            if (
                len(self.session_secret) < 32
                or self.session_secret == "local-development-session-secret-change-me"
            ):
                raise ValueError("SESSION_SECRET must be an independent random value of 32+ chars")
            if self.session_secret == self.organizer_password:
                raise ValueError("ORGANIZER_PASSWORD and SESSION_SECRET must differ")
        return self


settings = Settings()
