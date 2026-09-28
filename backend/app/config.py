"""Application configuration with local development defaults."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Read service settings from the environment."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://events:events@postgres:5432/events"
    organizer_password: str = "organizer-local"
    session_secret: str = "local-development-session-secret-change-me"
    cookie_secure: bool = False
    session_max_age: int = 28_800
    reminder_interval: float = 10.0


settings = Settings()
