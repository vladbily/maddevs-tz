# Место

Минимальный сервис регистрации на мероприятия: места и FIFO-лист ожидания,
отмена участия, билеты, однократный чекин и live-статистика организатора.

**Стек:** Python 3.12, FastAPI, Pydantic 2, async SQLAlchemy + asyncpg,
PostgreSQL 17, Alembic, uv; React, TypeScript, Vite, Nginx.

## Запуск

```sh
docker compose up --build
```

Откройте [localhost:8080](http://localhost:8080). Пароль организатора:
`organizer-local`. Локальные настройки работают без `.env`; для изменения
скопируйте `.env.example` в `.env`. Данные сохраняются в Docker volume.
Миграции выполняются автоматически. Остановка: `docker compose down`.

## Уведомления

Почтовых интеграций нет: «отправка» означает запись в `notifications`.
Код билета и ссылку управления можно получить из БД:

```sh
docker compose exec postgres psql -U events -d events -c \
  "SELECT id, email, created_at, kind, code, payload FROM notifications ORDER BY id DESC;"
```

Одна фоновая задача раз в 10 секунд создаёт напоминания владельцам мест.
Каждому email на событии — максимум одно напоминание, даже после переноса.
Поздние регистрации получают его ближайшим проходом. Перенос создаёт
отдельные уведомления подтверждённым и ожидающим участникам.

## Разработка

Все проверки, включая гонки на PostgreSQL и браузерный сценарий:

```sh
./scripts/test.sh
```

Тесты запускаются в отдельном Compose-проекте без открытых портов; его
контейнеры и данные удаляются после проверки. Скриншоты — в
`frontend/test-results/`. Такие же проверки запускаются в GitHub Actions.

Правила — в AGENT.md, запросы и этапы работы — в WORK_LOG.md.
Сервис рассчитан на один backend-процесс и одного организатора.
Все изменения мест транзакционны; даты хранятся в UTC.
API-документация: [localhost:8080/api/docs](http://localhost:8080/api/docs).
Перед внешним размещением задайте свои пароль и SESSION_SECRET, настройте
HTTPS и COOKIE_SECURE=true. Compose по умолчанию доступен только на localhost.
