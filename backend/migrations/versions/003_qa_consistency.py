"""Track participant changes and safely replay registration requests."""

import sqlalchemy as sa
from alembic import op

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add change tracking and optional request hashes without altering registrations."""
    op.add_column(
        "events",
        sa.Column("participants_revision", sa.Integer(), nullable=False, server_default="0"),
    )
    op.alter_column("events", "participants_revision", server_default=None)
    op.create_table(
        "registration_requests",
        sa.Column("event_id", sa.Integer(), sa.ForeignKey("events.id"), primary_key=True),
        sa.Column("key_hash", sa.String(64), primary_key=True),
        sa.Column(
            "registration_id", sa.Integer(), sa.ForeignKey("registrations.id"), nullable=False
        ),
        sa.Column("manage_token", sa.String(64), nullable=False),
    )


def downgrade() -> None:
    """Remove request recovery and change tracking columns."""
    op.drop_table("registration_requests")
    op.drop_column("events", "participants_revision")
