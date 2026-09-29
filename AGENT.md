# Project rules

This is a minimal event registration service.
Participants register by email, wait for seats, cancel, and check in with tickets.
One organizer manages events and watches live attendance.

## Stack and commands
- Use Python 3.12, FastAPI, Pydantic 2, async SQLAlchemy, and PostgreSQL 17.
- Manage Python dependencies with uv and keep uv.lock committed.
- Use React, TypeScript, Vite, and plain CSS for the frontend.
- Start the application with `docker compose up --build`.
- Run the isolated test suite with `./scripts/test.sh`.
- Keep database changes in Alembic migrations.

## Readable code
- Prefer small functions, explicit types, and straightforward control flow.
- Give every Python function a short one-line docstring.
- Give every TypeScript function and component a short JSDoc comment.
- Use async database I/O and a separate session per concurrent operation.
- Lock the event row before changing registrations or capacity.
- Keep business changes and their notifications in one transaction.
- Store aware timestamps in UTC and normalize email consistently.
- Preserve FIFO order, capacity limits, and one reminder per registration.

## Work journal
- Log every user prompt verbatim in WORK_LOG.md before implementing it; never replace it with a summary.
- Include clarification replies and follow-up requests, each with a stable request ID.
- Record when the prompt was logged; record receipt time only if actually available.
- Log each meaningful assistant action with its request ID, actor, start, end, and result.
- Read the clock at the start and end of actions; use ISO 8601 with a timezone.
- Do not invent unknown timestamps; label retrospective entries clearly.
- Never log passwords, tokens, or other secrets.
- The primary agent owns the journal; subagents report their results to it.

## Review and testing
- Ask code_reviewer to review every feature before committing it.
- Fix reported style, syntax, correctness, and concurrency defects.
- After every commit, send its SHA to tester for available smoke tests.
- Use real PostgreSQL for transaction and concurrency tests.
- Preserve user data; tests must use an isolated database and Compose project.

## Keep the scope small
- Do not add brokers, Celery, Redis, SMTP, or third-party email integrations.
- Notifications are rows in PostgreSQL, not delivered email.
- Use one backend process and one lifespan background reminder task.
- Do not add payments, participant accounts, or unnecessary abstractions.
- Do not commit secrets, generated artifacts, or database dumps.
