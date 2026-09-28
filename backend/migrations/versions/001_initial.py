"""Create events, registrations, and recorded notifications."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the initial schema and its consistency constraints."""
    op.create_table(
        "events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("description", sa.String(5000), nullable=False),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("capacity", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.CheckConstraint("capacity > 0", name="positive_capacity"),
    )
    op.create_index("ix_events_starts_at", "events", ["starts_at"])
    op.create_table(
        "registrations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("event_id", sa.Integer(), sa.ForeignKey("events.id"), nullable=False),
        sa.Column("email", sa.String(254), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("queued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ticket_code", sa.String(32), unique=True),
        sa.Column("manage_token", sa.String(64), nullable=False, unique=True),
        sa.Column("checked_in_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("event_id", "email", name="unique_event_email"),
        sa.CheckConstraint(
            "status IN ('confirmed', 'waitlisted', 'cancelled')", name="valid_status"
        ),
        sa.CheckConstraint("email = lower(btrim(email))", name="normalized_email"),
        sa.CheckConstraint(
            "checked_in_at IS NULL OR status = 'confirmed'", name="checkin_confirmed"
        ),
        sa.CheckConstraint(
            "status != 'confirmed' OR ticket_code IS NOT NULL", name="confirmed_ticket"
        ),
    )
    op.create_index(
        "registration_queue", "registrations", ["event_id", "status", "queued_at", "id"]
    )
    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "registration_id", sa.Integer(), sa.ForeignKey("registrations.id"), nullable=False
        ),
        sa.Column("email", sa.String(254), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("code", sa.String(32)),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("dedupe_key", sa.String(160), nullable=False, unique=True),
    )
    op.create_index("ix_notifications_registration_id", "notifications", ["registration_id"])


def downgrade() -> None:
    """Drop application tables in reverse dependency order."""
    op.drop_table("notifications")
    op.drop_table("registrations")
    op.drop_table("events")
