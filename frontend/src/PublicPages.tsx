import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  api,
  errorMessage,
  formatDate,
  type Event,
  type RegistrationResult,
  type Ticket,
} from "./api";
import { DateTile, EventCard, Loading, Notice, Status } from "./components";
import { useHasStarted, useResource } from "./hooks";

/** Persist an unguessable retry key before a registration can reach the server. */
function registrationKey(storageKey: string): string {
  const saved = sessionStorage.getItem(storageKey);
  if (saved) return saved;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(
    bytes,
    /** Encode each random byte. */ function encode(byte) {
      return byte.toString(16).padStart(2, "0");
    },
  ).join("");
  const key = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  sessionStorage.setItem(storageKey, key);
  return key;
}

/** Find an unfinished request so its owner can recover a ticket even after event start. */
function pendingEmail(eventId: string): string {
  const prefix = `registration:${eventId}:`;
  try {
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(prefix)) return key.slice(prefix.length);
    }
  } catch {
    return "";
  }
  return "";
}

/** Show upcoming events and a welcoming empty state on a new installation. */
export function EventsPage() {
  const { data, loading, error, reload } = useResource<Event[]>("/events");
  const [showPast, setShowPast] = useState(false);
  const events = (data ?? []).filter(
    /** Apply the selected date filter. */ function visible(event) {
      return showPast || new Date(event.starts_at).getTime() > Date.now();
    },
  );
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="status-dot" /> ДЛЯ ТЕХ, КОМУ ИНТЕРЕСНО
          </p>
          <h1>
            Новые встречи.
            <br />
            Ваше <em>место.</em>
          </h1>
          <p className="hero-description">
            Находите интересные события и будьте их частью.
            <br className="desktop-only" /> Мы позаботимся о регистрации — вам
            остаётся прийти.
          </p>
          <a className="button" href="#events">
            Выбрать событие <span aria-hidden="true">↓</span>
          </a>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <span className="art-spark">✳</span>
          <div className="art-ticket">
            <span>ПЛАНЫ НА ВЕЧЕР</span>
            <strong>
              Быть
              <br />
              среди своих.
            </strong>
            <div className="art-ticket-line" />
            <span>
              ВАШЕ МЕСТО УЖЕ ЖДЁТ <b>↗</b>
            </span>
          </div>
          <span className="art-note">Живые встречи важны</span>
        </div>
      </section>
      <section id="events" className="section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">НЕ ПРОПУСТИТЕ</p>
            <h2>
              Ближайшие события{" "}
              <span className="count-pill">{events.length}</span>
            </h2>
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={showPast}
              onChange={
                /** Toggle past events. */ function toggle(event) {
                  setShowPast(event.target.checked);
                }
              }
            />
            Показать прошедшие
          </label>
        </div>
        {loading && <Loading />}
        {error && (
          <>
            <Notice>{error}</Notice>
            <button className="button secondary" onClick={reload}>
              Повторить
            </button>
          </>
        )}
        {!loading && !error && events.length === 0 && (
          <div className="empty-state">
            <span className="empty-symbol" aria-hidden="true">
              ↗
            </span>
            <h3>Здесь скоро появятся встречи</h3>
            <p>
              Мы готовим новые события.
              <br />
              Загляните позже, чтобы выбрать свою встречу.
            </p>
          </div>
        )}
        <div className="event-grid">
          {events.map(
            /** Render each event with a stable key. */ function card(event) {
              return <EventCard key={event.id} event={event} />;
            },
          )}
        </div>
      </section>
      <section className="how-it-works">
        <div>
          <span>01 / ВЫБЕРИТЕ</span>
          <h3>Найдите свой повод.</h3>
          <p>Все детали и свободные места — на странице события.</p>
        </div>
        <div>
          <span>02 / ЗАПИШИТЕСЬ</span>
          <h3>Оставьте только email.</h3>
          <p>
            Без аккаунта и лишних вопросов. Если мест нет — встаньте в очередь.
          </p>
        </div>
        <div>
          <span>03 / ПРИХОДИТЕ</span>
          <h3>Билет уже с вами.</h3>
          <p>Сохраните ссылку на билет и покажите код на входе.</p>
        </div>
      </section>
    </>
  );
}

/** Show an event and register a participant using only an email address. */
export function EventPage() {
  const { id } = useParams();
  const {
    data: event,
    loading,
    error,
    reload,
  } = useResource<Event>(`/events/${id}`, 3000);
  const past = useHasStarted(event?.starts_at);
  const [email, setEmail] = useState(pendingEmail(id ?? ""));
  const canRecover = Boolean(pendingEmail(id ?? ""));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [duplicate, setDuplicate] = useState(false);
  const navigate = useNavigate();

  /** Submit a new registration or securely recover the same request's management link. */
  async function submit(form: FormEvent) {
    form.preventDefault();
    setBusy(true);
    setFeedback("");
    setDuplicate(false);
    try {
      const storageKey = `registration:${id}:${email.trim().toLowerCase()}`;
      const idempotencyKey = past
        ? sessionStorage.getItem(storageKey)
        : registrationKey(storageKey);
      if (!idempotencyKey)
        throw new Error(
          "Укажите email незавершённой регистрации для восстановления билета.",
        );
      const result = await api<RegistrationResult>(
        `/events/${id}/registrations`,
        {
          method: "POST",
          body: JSON.stringify({ email, idempotency_key: idempotencyKey }),
        },
      );
      sessionStorage.removeItem(storageKey);
      if (result.manage_url) navigate(result.manage_url);
      else {
        setDuplicate(true);
        setFeedback(
          "На этот email уже есть регистрация. Откройте ранее сохранённую ссылку на билет.",
        );
      }
    } catch (failure) {
      setFeedback(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <Loading />;
  if (!event)
    return (
      <>
        <Notice>{error || "Событие не найдено"}</Notice>
        <button className="button secondary" onClick={reload}>
          Повторить
        </button>
      </>
    );
  const available = Math.max(event.capacity - event.confirmed, 0);
  return (
    <>
      <Link className="back-link" to="/">
        ← Все события
      </Link>
      {error && (
        <>
          <Notice>{error} Показаны последние полученные данные.</Notice>
          <button className="button secondary" onClick={reload}>
            Повторить
          </button>
        </>
      )}
      <div className="detail-layout">
        <article className="event-detail">
          <p className="eyebrow">ХОРОШИЙ ПОВОД ВСТРЕТИТЬСЯ</p>
          <h1>{event.title}</h1>
          <div className="date-row">
            <DateTile value={event.starts_at} />
            <div>
              <strong>{formatDate(event.starts_at)}</strong>
              <p>{event.capacity} мест · участие по регистрации</p>
            </div>
          </div>
          <hr />
          <h2>О событии</h2>
          <p className="description">{event.description}</p>
        </article>
        <aside className="registration-panel">
          <span className="eyebrow">ВАШ СЛЕДУЮЩИЙ ПЛАН</span>
          <h2>
            {past
              ? "Событие началось"
              : available
                ? "Будете с нами?"
                : "Освободится — ваше."}
          </h2>
          <p>
            {past
              ? "Регистрация на это событие завершена."
              : available
                ? "Оставьте email, чтобы получить место и свой билет."
                : "Присоединитесь к листу ожидания. Первое свободное место автоматически достанется первому в очереди."}
          </p>
          <div className="availability">
            <span>{available} свободных мест</span>
            <strong>
              {event.confirmed} / {event.capacity}
            </strong>
          </div>
          <div className="capacity-track">
            <span
              style={{
                width: `${Math.min((event.confirmed / event.capacity) * 100, 100)}%`,
              }}
            />
          </div>
          {(!past || canRecover) && (
            <form onSubmit={submit}>
              {past && (
                <p>
                  Повторите незавершённый запрос с тем же email, чтобы
                  восстановить билет.
                </p>
              )}
              <label htmlFor="participant-email">Ваш email</label>
              <input
                id="participant-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
                maxLength={254}
                value={email}
                onChange={
                  /** Keep the email input current. */ function changeEmail(
                    change,
                  ) {
                    setEmail(change.target.value);
                  }
                }
              />
              <button className="button full-width" disabled={busy}>
                {busy
                  ? "Сохраняем…"
                  : past
                    ? "Восстановить билет ↗"
                    : available
                      ? "Зарегистрироваться ↗"
                      : "Встать в лист ожидания ↗"}
              </button>
              <p className="form-note">
                Планы поменялись? Отменить участие можно по ссылке на вашу
                регистрацию.
              </p>
            </form>
          )}
          {feedback && <Notice success={duplicate}>{feedback}</Notice>}
        </aside>
      </div>
    </>
  );
}

/** Keep a private ticket current and let its owner cancel participation. */
export function TicketPage() {
  const { token } = useParams();
  const {
    data: ticket,
    error,
    loading,
    reload,
  } = useResource<Ticket>(`/tickets/${token}`, 3000);
  const past = useHasStarted(ticket?.event.starts_at);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  /** Cancel after an explicit confirmation in the ticket screen. */
  async function cancel() {
    setBusy(true);
    setFeedback("");
    try {
      await api(`/tickets/${token}/cancel`, { method: "POST" });
      setConfirmCancel(false);
      reload();
    } catch (failure) {
      setFeedback(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  /** Copy the private management link for later use. */
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      setFeedback("Скопируйте ссылку из адресной строки браузера.");
    }
  }
  if (loading) return <Loading />;
  if (!ticket)
    return (
      <>
        <Notice>{error || "Регистрация не найдена"}</Notice>
        <button className="button secondary" onClick={reload}>
          Повторить
        </button>
      </>
    );
  const active = ticket.status !== "cancelled";
  const canCancel = active && !ticket.checked_in_at && !past;
  return (
    <>
      <Link className="back-link" to="/">
        ← Все события
      </Link>
      <div className="ticket-page">
        <div className="ticket-intro">
          <p className="eyebrow">ВАША РЕГИСТРАЦИЯ</p>
          <h1>
            {ticket.status === "confirmed"
              ? "Встреча состоится."
              : ticket.status === "waitlisted"
                ? "Вы в очереди."
                : "До следующей встречи."}
          </h1>
          <p>
            {ticket.status === "confirmed"
              ? "Сохраните билет. На входе понадобится только его код."
              : ticket.status === "waitlisted"
                ? "Как только появится место, здесь автоматически появится ваш билет."
                : "Место освобождено. Вы всегда можете выбрать другое событие."}
          </p>
        </div>
        <article className="ticket-card">
          <div className="ticket-top">
            <span className="brand">место.</span>
            <Status
              status={ticket.status}
              checkedIn={Boolean(ticket.checked_in_at)}
            />
          </div>
          <h2>{ticket.event.title}</h2>
          <p>{formatDate(ticket.event.starts_at)}</p>
          <p className="ticket-email">{ticket.email}</p>
          <div className="ticket-perforation" />
          <div className="ticket-code-area">
            <span className="eyebrow">
              {ticket.ticket_code ? "КОД ДЛЯ ВХОДА" : "СТАТУС РЕГИСТРАЦИИ"}
            </span>
            {ticket.ticket_code ? (
              <>
                <strong className="ticket-code" data-testid="ticket-code">
                  {ticket.ticket_code}
                </strong>
                <div className="decorative-barcode" aria-hidden="true" />
                <small>
                  {ticket.checked_in_at
                    ? "Чекин пройден. Хорошей встречи!"
                    : "Один билет — один вход"}
                </small>
              </>
            ) : (
              <p>
                {active ? "Ожидаем свободное место" : "Регистрация отменена"}
              </p>
            )}
          </div>
        </article>
        {active && (
          <>
            <button className="button secondary" onClick={copyLink}>
              {copied
                ? "Ссылка скопирована ✓"
                : "Скопировать ссылку на регистрацию"}
            </button>
            <p className="form-note">
              Ссылка личная: по ней можно посмотреть билет или отменить участие.
            </p>
          </>
        )}
        {feedback && <Notice>{feedback}</Notice>}
        {error && (
          <>
            <Notice>{error} Показаны последние полученные данные.</Notice>
            <button className="button secondary" onClick={reload}>
              Повторить
            </button>
          </>
        )}
        {canCancel && (
          <div className="cancel-area">
            {confirmCancel ? (
              <>
                <p>Освободить ваше место?</p>
                <div className="button-row">
                  <button
                    className="button danger"
                    onClick={cancel}
                    disabled={busy}
                  >
                    {busy ? "Отменяем…" : "Да, отменить участие"}
                  </button>
                  <button
                    className="button secondary"
                    onClick={
                      /** Keep the existing registration. */ function keep() {
                        setConfirmCancel(false);
                      }
                    }
                  >
                    Остаться
                  </button>
                </div>
              </>
            ) : (
              <button
                className="text-button"
                onClick={
                  /** Ask for cancellation confirmation. */ function askCancel() {
                    setConfirmCancel(true);
                  }
                }
              >
                Отменить участие
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
