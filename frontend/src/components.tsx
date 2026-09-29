import type { ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import {
  publicUrl,
  type Event,
  type RegistrationStatus,
  type Statistics,
} from "./api";

/** Render the shared navigation and quiet footer. */
export function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const organizer = pathname === "/login" || pathname.startsWith("/organizer");
  return (
    <>
      <header className="site-header">
        <a
          className="brand"
          href={organizer ? publicUrl("/") : "/"}
          aria-label="Место — главная"
        >
          <span className="brand-mark">м</span>место
          <span className="brand-dot">.</span>
        </a>
        <nav aria-label="Основная навигация">
          {organizer ? (
            <a href={publicUrl("/")}>События</a>
          ) : (
            <NavLink to="/" end>
              События
            </NavLink>
          )}
          {organizer && (
            <NavLink className="organizer-link" to="/organizer">
              Кабинет <span aria-hidden="true">↗</span>
            </NavLink>
          )}
        </nav>
      </header>
      <main className="page">{children}</main>
      <footer className="site-footer">
        <span className="footer-brand">место.</span>
        <span>Меньше формальностей. Больше встреч.</span>
        <span>Увидимся на событии ↗</span>
      </footer>
    </>
  );
}

/** Display actionable feedback using an accessible live region. */
export function Notice({
  children,
  success = false,
}: {
  children: ReactNode;
  success?: boolean;
}) {
  return (
    <div
      className={`notice ${success ? "notice-success" : "notice-error"}`}
      role={success ? "status" : "alert"}
    >
      {children}
    </div>
  );
}

/** Show a small loading state while a screen is fetching its first response. */
export function Loading() {
  return (
    <div className="loading" role="status">
      <span className="loading-dot" />
      Загружаем…
    </div>
  );
}

/** Show a registration's current state without relying on color alone. */
export function Status({
  status,
  checkedIn = false,
}: {
  status: RegistrationStatus;
  checkedIn?: boolean;
}) {
  const labels = {
    confirmed: "Место подтверждено",
    waitlisted: "В листе ожидания",
    cancelled: "Участие отменено",
  };
  return (
    <span className={`badge badge-${checkedIn ? "attended" : status}`}>
      {checkedIn ? "На событии" : labels[status]}
    </span>
  );
}

/** Display organizer counters supplied by the live statistics stream. */
export function Counters({
  stats,
  capacity,
}: {
  stats: Statistics;
  capacity: number;
}) {
  return (
    <div className="counters">
      <div className="counter">
        <span>Зарегистрировано</span>
        <strong data-testid="confirmed-count">
          {stats.confirmed}
          <small> / {capacity}</small>
        </strong>
        <span className="counter-caption">подтверждённых мест</span>
      </div>
      <div className="counter">
        <span>В листе ожидания</span>
        <strong data-testid="waitlisted-count">{stats.waitlisted}</strong>
        <span className="counter-caption">ждут свободное место</span>
      </div>
      <div className="counter counter-highlight">
        <span>Пришло</span>
        <strong data-testid="checked-in-count">{stats.checked_in}</strong>
        <span className="counter-caption">гостей уже на событии</span>
      </div>
    </div>
  );
}

/** Render a calendar tile from an event's local date. */
export function DateTile({ value }: { value: string }) {
  const date = new Date(value);
  return (
    <div className="date-tile">
      <strong>{date.getDate()}</strong>
      <span>
        {date.toLocaleDateString("ru-RU", { month: "short" }).replace(".", "")}
      </span>
    </div>
  );
}

/** Render one event card with clear availability and a detail link. */
export function EventCard({
  event,
  organizer = false,
}: {
  event: Event;
  organizer?: boolean;
}) {
  const past = new Date(event.starts_at).getTime() <= Date.now();
  const available = Math.max(event.capacity - event.confirmed, 0);
  return (
    <Link
      className="event-card"
      to={organizer ? `/organizer/events/${event.id}` : `/events/${event.id}`}
    >
      <div className="event-card-top">
        <DateTile value={event.starts_at} />
        <span
          className={`badge ${past ? "badge-cancelled" : available ? "badge-confirmed" : "badge-waitlisted"}`}
        >
          {past
            ? "Уже началось"
            : available
              ? `${available} свободных мест`
              : "Есть лист ожидания"}
        </span>
      </div>
      <div>
        <p className="eyebrow">
          {new Date(event.starts_at).toLocaleDateString("ru-RU", {
            weekday: "long",
          })}{" "}
          ·{" "}
          {new Date(event.starts_at).toLocaleTimeString("ru-RU", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
        <h3>{event.title}</h3>
        <p className="card-description">{event.description}</p>
      </div>
      <div className="event-card-bottom">
        <span>
          {event.confirmed} из {event.capacity} мест занято
        </span>
        <span className="card-arrow" aria-hidden="true">
          ↗
        </span>
      </div>
    </Link>
  );
}
