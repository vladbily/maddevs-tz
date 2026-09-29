/** Build participant links using the public site even inside the private cabinet. */
export function publicUrl(path: string): string {
  return new URL(
    path,
    import.meta.env.VITE_PUBLIC_URL ?? "http://localhost:8080",
  ).href;
}

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
  participants_revision: number;
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
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...options.headers },
    });
  } catch {
    throw new ApiError(
      "Не удалось связаться с сервером. Проверьте соединение и повторите попытку.",
      0,
    );
  }
  const unavailable = "Сервис временно недоступен. Попробуйте ещё раз.";
  let body;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(unavailable, response.ok ? 503 : response.status);
  }
  if (!response.ok) {
    const message =
      response.status >= 500
        ? unavailable
        : typeof body?.detail === "string"
          ? body.detail
          : response.status === 422
            ? "Проверьте заполненные поля: email, дату и количество мест."
            : "Не удалось выполнить запрос. Попробуйте ещё раз.";
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
