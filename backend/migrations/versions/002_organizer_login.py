"""Persist organizer login throttling independently of application processes."""

import sqlalchemy as sa
from alembic import op

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the single organizer's persistent authentication throttle."""
    op.create_table(
        "organizer_login",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("failed_attempts", sa.Integer(), nullable=False),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("id = 1", name="single_organizer_login"),
        sa.CheckConstraint("failed_attempts >= 0", name="nonnegative_login_failures"),
    )


def downgrade() -> None:
    """Remove authentication throttling state without changing event data."""
    op.drop_table("organizer_login")
