import { test, expect, type Page } from "@playwright/test";

/** Keep organizer screens and APIs unreachable from the public listener. */
test("public site has no organizer entry or private API", async function isolation({
  page,
}) {
  const publicURL = process.env.PUBLIC_BASE_URL ?? "http://localhost:8080";
  await page.goto(publicURL);
  await expect(page.getByRole("navigation")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Организатору|Кабинет/ }),
  ).toHaveCount(0);
  await expect(
    page.locator('a[href*="/organizer"], a[href*="/login"]'),
  ).toHaveCount(0);
  const login = await page.request.post("/api/auth/login", {
    data: {
      password: process.env.ORGANIZER_PASSWORD ?? "organizer-test-password",
    },
  });
  expect(login.status()).toBe(200);
  for (const path of [
    "/login",
    "/organizer",
    "/organizer/new",
    "/api/auth/session",
    "/api/organizer/events/1/participants",
    "/api/organizer/events/1/stream",
    "/api/docs",
    "/api/openapi.json",
    "/api/%61uth/session",
  ]) {
    const response = await page.request.get(`${publicURL}${path}`);
    expect(response.status(), path).toBe(404);
  }
  for (const path of ["/api/auth/login", "/api/organizer/events"]) {
    const response = await page.request.post(`${publicURL}${path}`, {
      headers: { Host: "organizer.example.com" },
      data: {
        password: process.env.ORGANIZER_PASSWORD ?? "organizer-test-password",
      },
    });
    expect(response.status(), path).toBe(404);
  }
  const session = await page.request.get("/api/auth/session");
  expect(session.status()).toBe(200);
  const logout = await page.request.post("/api/auth/logout", {
    headers: { Origin: publicURL },
  });
  expect(logout.status()).toBe(403);
  expect((await page.request.get("/api/auth/session")).status()).toBe(200);
});

/** Keep the empty landing page focused on participants without a private entry. */
test("empty public landing has no organizer links", async function emptyLanding({
  page,
}) {
  await page.route(
    "**/api/events",
    /** Return an empty event list without modifying the isolated database. */
    async function noEvents(route) {
      await route.fulfill({ json: [] });
    },
  );
  await page.goto(process.env.PUBLIC_BASE_URL ?? "http://localhost:8080");
  await expect(
    page.getByRole("heading", { name: "Здесь скоро появятся встречи" }),
  ).toBeVisible();
  await expect(
    page.locator('a[href*="/organizer"], a[href*="/login"]'),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /Создать событие|Организатору|Кабинет/ }),
  ).toHaveCount(0);
});

/** Keep failed login and logout feedback usable on the private listener. */
test("private login errors and logout", async function privateLogin({ page }) {
  await page.goto("/organizer");
  await page.getByLabel("Пароль", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Войти →" }).click();
  await expect(page.getByRole("alert")).toContainText("Неверный пароль");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill(process.env.ORGANIZER_PASSWORD ?? "organizer-test-password");
  await page.getByRole("button", { name: "Войти →" }).click();
  await expect(page).toHaveURL(/\/organizer$/);
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/auth/session")).status()).toBe(401);
});

/** Fill the public registration form and wait for a private ticket page. */
async function register(page: Page, eventId: string, email: string) {
  await page.goto(`/events/${eventId}`);
  await page.getByLabel("Ваш email").fill(email);
  await page
    .getByRole("button", { name: /Зарегистрироваться|Встать в лист ожидания/ })
    .click();
  await expect(page).toHaveURL(/\/tickets\//);
}

/** Cover the complete organizer and participant journey in separate browser contexts. */
test("FIFO promotion, check-in, live counters and rescheduling", async function journey({
  page,
  browser,
}) {
  const baseURL = process.env.PUBLIC_BASE_URL ?? "http://localhost:8080";
  const errors: string[] = [];
  /** Record uncaught browser errors for the acceptance check. */
  page.on("pageerror", function record(error) {
    errors.push(error.message);
  });
  await page.goto("/organizer");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill(process.env.ORGANIZER_PASSWORD ?? "organizer-test-password");
  await page.getByRole("button", { name: "Войти →" }).click();
  await page
    .getByRole("link", { name: /Создать событие/ })
    .first()
    .click();
  const name = `Вечер интересных разговоров ${Date.now()}`;
  const date = new Date(Date.now() + 48 * 3_600_000).toISOString().slice(0, 16);
  await page.getByLabel("Название события").fill(name);
  await page
    .getByLabel("Описание", { exact: true })
    .fill("Знакомимся, обсуждаем проекты и делимся идеями.");
  await page.getByLabel("Дата и время").fill(date);
  await page.getByLabel("Количество мест").fill("1");
  await page.getByRole("button", { name: "Создать событие ↗" }).click();
  await expect(page).toHaveURL(/\/organizer\/events\/\d+$/);
  const eventId = page.url().split("/").at(-1)!;
  const publicEventURL = `${baseURL}/events/${eventId}`;
  await expect(
    page.getByRole("link", { name: "Страница события ↗" }),
  ).toHaveAttribute("href", publicEventURL);
  /** Capture copied text on the isolated HTTP origin where Clipboard API may be unavailable. */
  await page.evaluate(function captureClipboard() {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        /** Record the exact invitation produced by the dashboard handler. */
        async writeText(value: string) {
          document.body.dataset.copiedEventUrl = value;
        },
      },
    });
  });
  await page.getByRole("button", { name: "Копировать ссылку" }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-copied-event-url",
    publicEventURL,
  );
  const monitor = await page.context().newPage();
  await monitor.goto(`/organizer/events/${eventId}`);
  await expect(monitor.getByTestId("checked-in-count")).toHaveText("0");
  const aContext = await browser.newContext({ baseURL, timezoneId: "UTC" });
  const bContext = await browser.newContext({ baseURL, timezoneId: "UTC" });
  const a = await aContext.newPage();
  const b = await bContext.newPage();
  await register(a, eventId, "alice@example.com");
  await expect(a.getByTestId("ticket-code")).toBeVisible();
  await register(b, eventId, "bob@example.com");
  await expect(b.getByRole("heading", { name: "Вы в очереди." })).toBeVisible();
  await expect(monitor.getByTestId("waitlisted-count")).toHaveText("1");
  await a
    .getByRole("button", { name: "Отменить участие", exact: true })
    .click();
  await a.getByRole("button", { name: "Да, отменить участие" }).click();
  await expect(
    a.getByText("Регистрация отменена", { exact: true }),
  ).toBeVisible();
  await expect(b.getByTestId("ticket-code")).toBeVisible();
  const code = (await b.getByTestId("ticket-code").textContent())!;
  await expect(monitor.getByTestId("waitlisted-count")).toHaveText("0");
  await page.getByLabel("Код билета", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Отметить участника →" }).click();
  await expect(page.getByRole("status")).toContainText("вход подтверждён");
  await expect(monitor.getByTestId("checked-in-count")).toHaveText("1");
  await page.getByLabel("Код билета", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Отметить участника →" }).click();
  await expect(page.getByRole("alert")).toContainText("Билет уже использован");
  await expect(monitor.getByTestId("checked-in-count")).toHaveText("1");
  await monitor.screenshot({
    path: "test-results/dashboard.png",
    fullPage: true,
  });
  await b.screenshot({ path: "test-results/ticket.png", fullPage: true });
  await page.getByRole("link", { name: "Редактировать ↗" }).click();
  const newDate = new Date(Date.now() + 96 * 3_600_000)
    .toISOString()
    .slice(0, 16);
  await page.getByLabel("Дата и время").fill(newDate);
  await page.getByRole("button", { name: "Сохранить изменения" }).click();
  await expect(page).toHaveURL(/\/organizer\/events\/\d+$/);
  const updated = await page.request.get(`/api/events/${eventId}`);
  expect(
    new Date((await updated.json()).starts_at).toISOString().slice(0, 16),
  ).toBe(newDate);
  await page.goto(baseURL);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.screenshot({
    path: "test-results/events-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name })).toBeVisible();
  /** Ensure the narrow layout does not overflow horizontally. */
  const overflow = await page.evaluate(function measureOverflow() {
    return document.documentElement.scrollWidth > window.innerWidth;
  });
  expect(overflow).toBe(false);
  await page.screenshot({
    path: "test-results/events-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  await aContext.close();
  await bContext.close();
  await monitor.close();
});

/** Redirect to login when a session disappears during navigation or form submission. */
test("missing organizer session returns to login", async function expiredSession({
  page,
  context,
}) {
  const password = process.env.ORGANIZER_PASSWORD ?? "organizer-test-password";
  await page.request.post("/api/auth/login", { data: { password } });
  await page.goto("/organizer");
  await expect(
    page.getByRole("heading", { name: "Ваши события." }),
  ).toBeVisible();
  await context.clearCookies();
  await page
    .getByRole("link", { name: /Создать событие/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти →" }).click();
  await expect(page).toHaveURL(/\/organizer\/new$/);
  await page.getByLabel("Название события").fill("Проверка истёкшей сессии");
  await page
    .getByLabel("Описание", { exact: true })
    .fill("Сессия удаляется перед сохранением.");
  await page
    .getByLabel("Дата и время")
    .fill(new Date(Date.now() + 48 * 3_600_000).toISOString().slice(0, 16));
  await context.clearCookies();
  await page.getByRole("button", { name: "Создать событие ↗" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

/** Keep sub-minute timestamp precision when saving an unchanged date from the UI. */
test("editing a description does not reschedule the event", async function unchangedDate({
  page,
}) {
  await page.request.post("/api/auth/login", {
    data: {
      password: process.env.ORGANIZER_PASSWORD ?? "organizer-test-password",
    },
  });
  const startsAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
  const response = await page.request.post("/api/organizer/events", {
    data: {
      title: "Встреча без переноса",
      description: "Первоначальное описание",
      starts_at: startsAt,
      capacity: 5,
    },
  });
  expect(response.ok()).toBe(true);
  const event = await response.json();
  await page.goto(`/organizer/events/${event.id}/edit`);
  await page
    .getByLabel("Описание", { exact: true })
    .fill("Уточнённое описание");
  await page.getByRole("button", { name: "Сохранить изменения" }).click();
  await expect(page).toHaveURL(new RegExp(`/organizer/events/${event.id}$`));
  const result = await (
    await page.request.get(`/api/events/${event.id}`)
  ).json();
  expect(result.revision).toBe(event.revision + 1);
  expect(new Date(result.starts_at).toISOString()).toBe(startsAt);
});
