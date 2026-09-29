import { useEffect, useState, type FormEvent } from "react";
import {
  Link,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  ApiError,
  api,
  errorMessage,
  formatDate,
  publicUrl,
  toLocalInput,
  type Event,
  type Participant,
} from "./api";
import { Counters, EventCard, Loading, Notice, Status } from "./components";
import { useResource } from "./hooks";

/** Check the organizer session before rendering any management screens. */
export function OrganizerGate() {
  const [state, setState] = useState<"loading" | "ready" | "login" | "error">(
    "loading",
  );
  const location = useLocation();

  /** Validate the signed session without exposing its cookie to JavaScript. */
  useEffect(
    function checkSession() {
      let active = true;
      setState("loading");
      /** Resolve the initial authentication state. */
      async function check() {
        try {
          await api("/auth/session");
          if (active) setState("ready");
        } catch (error) {
          if (active)
            setState(
              error instanceof ApiError && error.status === 401
                ? "login"
                : "error",
            );
        }
      }
      void check();
      /** Ignore authentication results after navigation. */
      return function stopCheck() {
        active = false;
      };
    },
    [location.pathname],
  );
  if (state === "loading") return <Loading />;
  if (state === "login")
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (state === "error")
    return (
      <Notice>
        Сервис временно недоступен. Обновите страницу, чтобы повторить
        подключение.
      </Notice>
    );
  return <Outlet />;
}

/** Sign in the one configured organizer with a password. */
export function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  /** Exchange a password for a server-managed session cookie. */
  async function submit(form: FormEvent) {
    form.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      const destination = location.state?.from;
      navigate(
        typeof destination === "string" && destination.startsWith("/organizer")
          ? destination
          : "/organizer",
        { replace: true },
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-layout">
      <div className="login-copy">
        <p className="eyebrow">ПО ТУ СТОРОНУ СОБЫТИЯ</p>
        <h1>
          Вы собираете людей.
          <br />
          Мы считаем места.
        </h1>
        <p>
          Регистрация, очередь и вход —<br />в одном спокойном пространстве.
        </p>
        <div className="login-art" aria-hidden="true">
          ✳
        </div>
      </div>
      <section className="login-panel">
        <span className="eyebrow">КАБИНЕТ ОРГАНИЗАТОРА</span>
        <h2>С возвращением.</h2>
        <p>Войдите, чтобы управлять вашими событиями.</p>
        <form onSubmit={submit}>
          <label htmlFor="organizer-password">Пароль</label>
          <input
            id="organizer-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={
              /** Update the password field. */ function changePassword(
                change,
              ) {
                setPassword(change.target.value);
              }
            }
          />
          <button className="button full-width" disabled={busy}>
            {busy ? "Входим…" : "Войти →"}
          </button>
        </form>
        {error && <Notice>{error}</Notice>}
        <a className="back-link" href={publicUrl("/")}>
          ← Вернуться к событиям
        </a>
      </section>
    </div>
  );
}

/** List managed events and provide a clear starting point for a new event. */
export function OrganizerPage() {
  const { data, loading, error } = useResource<Event[]>("/events");
  const [logoutError, setLogoutError] = useState("");
  const navigate = useNavigate();

  /** Clear the session and return to the private login page. */
  async function logout() {
    try {
      await api("/auth/logout", { method: "POST" });
      navigate("/login", { replace: true });
    } catch (failure) {
      setLogoutError(errorMessage(failure));
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">КАБИНЕТ ОРГАНИЗАТОРА</p>
          <h1>Ваши события.</h1>
          <p>От первого участника до последнего гостя на входе.</p>
        </div>
        <div className="button-row">
          <button className="text-button" onClick={logout}>
            Выйти
          </button>
          <Link className="button" to="/organizer/new">
            + Создать событие
          </Link>
        </div>
      </div>
      {loading && <Loading />}
      {(error || logoutError) && <Notice>{error || logoutError}</Notice>}
      {data?.length === 0 && (
        <div className="empty-state">
          <span className="empty-symbol" aria-hidden="true">
            ＋
          </span>
          <h3>Начнём с первого события</h3>
          <p>
            Добавьте описание, дату и количество мест.
            <br />
            После этого можно приглашать участников.
          </p>
          <Link className="button" to="/organizer/new">
            Создать событие
          </Link>
        </div>
      )}
      <div className="event-grid">
        {data?.map(
          /** Render each managed event. */ function card(event) {
            return <EventCard event={event} organizer key={event.id} />;
          },
        )}
      </div>
    </>
  );
}

/** Create or edit an event with local dates converted to explicit UTC instants. */
function EventForm({ initial }: { initial?: Event }) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [date, setDate] = useState(
    initial ? toLocalInput(initial.starts_at) : "",
  );
  const [capacity, setCapacity] = useState(String(initial?.capacity ?? 30));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  /** Validate browser fields and persist all editable event details. */
  async function submit(form: FormEvent) {
    form.preventDefault();
    setBusy(true);
    setError("");
    try {
      const event = await api<Event>(
        initial ? `/organizer/events/${initial.id}` : "/organizer/events",
        {
          method: initial ? "PUT" : "POST",
          body: JSON.stringify({
            title,
            description,
            starts_at:
              initial && date === toLocalInput(initial.starts_at)
                ? initial.starts_at
                : new Date(date).toISOString(),
            capacity: Number(capacity),
            ...(initial ? { revision: initial.revision } : {}),
          }),
        },
      );
      navigate(`/organizer/events/${event.id}`);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        navigate("/login", {
          state: {
            from: initial
              ? `/organizer/events/${initial.id}/edit`
              : "/organizer/new",
          },
        });
      } else {
        setError(errorMessage(failure));
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link
        className="back-link"
        to={initial ? `/organizer/events/${initial.id}` : "/organizer"}
      >
        ← Назад
      </Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">СОБЕРИТЕ СВОИХ</p>
          <h1>{initial ? "Детали события." : "Новая встреча."}</h1>
          <p>
            {initial
              ? "При переносе даты участники получат уведомление."
              : "Всего несколько деталей — и можно приглашать гостей."}
          </p>
        </div>
      </div>
      <form className="event-form" onSubmit={submit}>
        <label htmlFor="event-title">Название события</label>
        <input
          id="event-title"
          required
          maxLength={160}
          placeholder="Например, вечер коротких докладов"
          value={title}
          onChange={
            /** Update the event title. */ function changeTitle(change) {
              setTitle(change.target.value);
            }
          }
        />
        <label htmlFor="event-description">Описание</label>
        <textarea
          id="event-description"
          required
          maxLength={5000}
          rows={6}
          placeholder="О чём будем говорить, кому будет интересно и где встречаемся?"
          value={description}
          onChange={
            /** Update the event description. */ function changeDescription(
              change,
            ) {
              setDescription(change.target.value);
            }
          }
        />
        <div className="form-grid">
          <div>
            <label htmlFor="event-date">Дата и время</label>
            <input
              id="event-date"
              type="datetime-local"
              required
              value={date}
              onChange={
                /** Update the local event date. */ function changeDate(
                  change,
                ) {
                  setDate(change.target.value);
                }
              }
            />
            <small>Ваш часовой пояс: {timezone}</small>
          </div>
          <div>
            <label htmlFor="event-capacity">Количество мест</label>
            <input
              id="event-capacity"
              type="number"
              min={1}
              max={100000}
              required
              value={capacity}
              onChange={
                /** Update the seat limit. */ function changeCapacity(change) {
                  setCapacity(change.target.value);
                }
              }
            />
            <small>После заполнения откроется лист ожидания</small>
          </div>
        </div>
        {error && <Notice>{error}</Notice>}
        <div className="form-actions">
          <Link
            className="button secondary"
            to={initial ? `/organizer/events/${initial.id}` : "/organizer"}
          >
            Отмена
          </Link>
          <button className="button" disabled={busy}>
            {busy
              ? "Сохраняем…"
              : initial
                ? "Сохранить изменения"
                : "Создать событие ↗"}
          </button>
        </div>
      </form>
    </>
  );
}

/** Open the organizer's event creation form. */
export function NewEventPage() {
  return <EventForm />;
}

/** Load saved event details before mounting the edit form. */
export function EditEventPage() {
  const { id } = useParams();
  const { data, loading, error } = useResource<Event>(`/events/${id}`);
  if (loading) return <Loading />;
  if (!data || error) return <Notice>{error || "Событие не найдено"}</Notice>;
  return <EventForm initial={data} key={data.id} />;
}

/** Manage attendance with live counters, a participant list, and manual ticket entry. */
export function DashboardPage() {
  const { id } = useParams();
  const {
    data: initialEvent,
    loading,
    error,
  } = useResource<Event>(`/events/${id}`);
  const {
    data: participants,
    error: participantsError,
    reload,
  } = useResource<Participant[]>(`/organizer/events/${id}/participants`);
  const [snapshot, setSnapshot] = useState<Event | null>(null);
  const event = snapshot?.id === Number(id) ? snapshot : initialEvent;
  const [connected, setConnected] = useState(false);
  const [code, setCode] = useState("");
  const [feedback, setFeedback] = useState("");
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();

  /** Subscribe to database-derived counters and recover automatically after disconnects. */
  useEffect(
    function connectStream() {
      let active = true;
      setSnapshot(null);
      setConnected(false);
      const stream = new EventSource(`/api/organizer/events/${id}/stream`);
      /** Apply a changed server snapshot and refresh the participant rows. */
      stream.onmessage = function receive(message) {
        if (!active) return;
        setSnapshot(JSON.parse(message.data) as Event);
        setConnected(true);
        reload();
      };
      /** Display the reconnecting state without losing the latest counters. */
      stream.onerror = function disconnect() {
        setConnected(false);
        void checkSession();
      };
      /** Detect an unauthorized SSE handshake and offer a fresh login. */
      async function checkSession() {
        try {
          await api("/auth/session");
        } catch (failure) {
          if (active && failure instanceof ApiError && failure.status === 401)
            expire();
        }
      }
      /** Return to sign-in when the signed session expires. */
      function expire() {
        stream.close();
        navigate("/login", { state: { from: `/organizer/events/${id}` } });
      }
      stream.addEventListener("expired", expire);
      /** Close the stream when moving to another screen. */
      return function closeStream() {
        active = false;
        stream.close();
      };
    },
    [id, navigate, reload],
  );

  /** Submit a ticket once and show the server's precise success or rejection. */
  async function checkin(form: FormEvent) {
    form.preventDefault();
    setBusy(true);
    setFeedback("");
    setSuccess(false);
    try {
      const result = await api<{ email: string }>(
        `/organizer/events/${id}/checkin`,
        { method: "POST", body: JSON.stringify({ code }) },
      );
      setSuccess(true);
      setFeedback(`${result.email} — вход подтверждён. Хорошей встречи!`);
      setCode("");
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        navigate("/login", { state: { from: `/organizer/events/${id}` } });
      } else {
        setFeedback(errorMessage(failure));
      }
    } finally {
      setBusy(false);
    }
  }

  /** Copy the public event link for sharing with prospective participants. */
  async function copyEvent() {
    try {
      await navigator.clipboard.writeText(publicUrl(`/events/${id}`));
      setCopied(true);
    } catch {
      setSuccess(false);
      setFeedback(
        "Откройте страницу события и скопируйте ссылку из адресной строки.",
      );
    }
  }
  if (loading && !event) return <Loading />;
  if (!event) return <Notice>{error || "Событие не найдено"}</Notice>;
  return (
    <>
      <Link className="back-link" to="/organizer">
        ← Мои события
      </Link>
      <div className="page-heading dashboard-heading">
        <div>
          <p className="eyebrow">ПУЛЬТ СОБЫТИЯ</p>
          <h1>{event.title}</h1>
          <p>{formatDate(event.starts_at)}</p>
        </div>
        <Link className="button secondary" to={`/organizer/events/${id}/edit`}>
          Редактировать ↗
        </Link>
      </div>
      <div className="dashboard-toolbar">
        <div className={`live-indicator ${connected ? "is-live" : ""}`}>
          <span className="status-dot" />
          {connected
            ? "LIVE · обновляется автоматически"
            : "Подключение к live-статистике…"}
        </div>
        <div className="button-row">
          <a className="text-button" href={publicUrl(`/events/${id}`)}>
            Страница события ↗
          </a>
          <button className="text-button" onClick={copyEvent}>
            {copied ? "Скопировано ✓" : "Копировать ссылку"}
          </button>
        </div>
      </div>
      <Counters stats={event} capacity={event.capacity} />
      <div className="dashboard-content">
        <section className="participants-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">ЛЮДИ, А НЕ ЦИФРЫ</p>
              <h2>Участники</h2>
            </div>
            <span className="count-pill">{participants?.length ?? 0}</span>
          </div>
          {participantsError && (
            <>
              <Notice>
                {participantsError}
                {participants && " Список участников может быть устаревшим."}
              </Notice>
              <button className="button secondary" onClick={reload}>
                Повторить
              </button>
            </>
          )}
          {participants?.length === 0 ? (
            <div className="small-empty">
              <p>Пока никто не зарегистрировался.</p>
              <p>
                Поделитесь ссылкой на событие — здесь появятся первые участники.
              </p>
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {participants?.map(
                    /** Render the participant's current registration and check-in state. */ function row(
                      participant,
                    ) {
                      return (
                        <tr key={participant.id}>
                          <td>{participant.email}</td>
                          <td>
                            <Status
                              status={participant.status}
                              checkedIn={Boolean(participant.checked_in_at)}
                            />
                          </td>
                        </tr>
                      );
                    },
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="checkin-panel">
          <span className="checkin-icon" aria-hidden="true">
            ⌁
          </span>
          <p className="eyebrow">ВСТРЕЧАЕМ ГОСТЕЙ</p>
          <h2>Чекин на входе</h2>
          <p>
            Введите код с билета участника.
            <br />
            Каждый билет проходит только один раз.
          </p>
          <form onSubmit={checkin}>
            <label htmlFor="ticket-code">Код билета</label>
            <input
              id="ticket-code"
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={64}
              placeholder="Например, A1B2C3D4…"
              value={code}
              onChange={
                /** Keep the entered ticket code current. */ function changeCode(
                  change,
                ) {
                  setCode(change.target.value);
                }
              }
            />
            <button className="button full-width" disabled={busy}>
              {busy ? "Проверяем…" : "Отметить участника →"}
            </button>
          </form>
          {feedback && <Notice success={success}>{feedback}</Notice>}
        </section>
      </div>
    </>
  );
}
