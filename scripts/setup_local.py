"""Create private local credentials without printing or overwriting secrets."""

import os
import secrets
from pathlib import Path


def main() -> None:
    """Exclusively create a mode-0600 configuration with independent random secrets."""
    destination = Path(__file__).resolve().parents[1] / ".env"
    try:
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise SystemExit(
            ".env already exists; update it manually without overwriting secrets."
        ) from None
    with os.fdopen(descriptor, "w") as config:
        config.write(
            f"ORGANIZER_PASSWORD={secrets.token_urlsafe(24)}\n"
            f"SESSION_SECRET={secrets.token_urlsafe(48)}\n"
            "COOKIE_SECURE=false\nAPP_PORT=8080\nORGANIZER_PORT=8081\n"
        )
    print("Created private .env. Read ORGANIZER_PASSWORD there to sign in.")


if __name__ == "__main__":
    main()
