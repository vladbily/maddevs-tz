export interface Statistics {
  confirmed: number;
  waitlisted: number;
  checked_in: number;
}

export interface Event extends Statistics {
  id: number;
  title: string;
  description: string;
  starts_at: string;
  capacity: number;
  revision: number;
}

export type RegistrationStatus = "confirmed" | "waitlisted" | "cancelled";

export interface Participant {
  id: number;
  email: string;
  status: RegistrationStatus;
  queued_at: string;
  checked_in_at: string | null;
}

export interface Ticket extends Participant {
  event: Event;
  ticket_code: string | null;
}

export interface RegistrationResult {
  created: boolean;
  status: RegistrationStatus;
  manage_url: string | null;
}

export class ApiError extends Error {
  status: number;

  /** Preserve the HTTP status for authentication and validation handling. */
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Call the same-origin API and translate its errors into readable messages. */
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const body = await response.json();
  if (!response.ok) {
    const message =
      typeof body.detail === "string"
        ? body.detail
        : "Проверьте заполненные поля: email, дату и количество мест.";
    throw new ApiError(message, response.status);
  }
  return body as T;
}

/** Convert unknown failures into a user-facing explanation. */
export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Не удалось выполнить запрос. Попробуйте ещё раз.";
}

/** Format an instant in the browser's local timezone, including its name. */
export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

/** Format a server timestamp for a local datetime input without changing its instant. */
export function toLocalInput(value: string): string {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
