import { test, expect, type Page } from "@playwright/test";
import type { Event, RegistrationResult } from "../src/api";

/** Create each regression's own event in the isolated Compose database. */
async function createEvent(
  page: Page,
  startsInMs = 172_800_000,
): Promise<Event> {
  const login = await page.request.post("/api/auth/login", {
    data: {
      password: process.env.ORGANIZER_PASSWORD ?? "organizer-test-password",
    },
  });
  expect(login.status()).toBe(200);
  const response = await page.request.post("/api/organizer/events", {
    data: {
      title: "QA regression event",
      description: "Isolated regression data",
      starts_at: new Date(Date.now() + startsInMs).toISOString(),
      capacity: 1,
    },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

/** Reserve a place through the real API without opening another screen. */
async function register(
  page: Page,
  id: number,
  email: string,
): Promise<RegistrationResult> {
  const response = await page.request.post(`/api/events/${id}/registrations`, {
    data: { email },
  });
  expect(response.status()).toBe(200);
  return response.json();
}

/** Keep an open public screen current and close its form when the event starts. */
test("F1 public seats refresh and registration closes at start", async function publicRefresh({
  page,
}) {
  const event = await createEvent(page, 8_000);
  await page.goto(`/events/${event.id}`);
  await page.getByLabel("Ваш email").fill("unfinished@example.com");
  await register(page, event.id, "first@example.com");
  await expect(page.locator(".availability")).toContainText("0 свободных мест");
  await expect(page.locator(".availability strong")).toHaveText("1 / 1");
  await expect(
    page.getByRole("button", { name: "Встать в лист ожидания ↗" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Событие началось", exact: true }),
  ).toBeVisible({ timeout: 12_000 });
  await expect(page.getByLabel("Ваш email")).toHaveCount(0);
});

/** Apply full live metadata and refresh participants even when their totals are unchanged. */
test("F2 F3 live dashboard updates metadata and equal-count replacements", async function liveSnapshots({
  page,
}) {
  const event = await createEvent(page);
  const old = await register(page, event.id, "swap-old@example.com");
  await register(page, event.id, "waiting@example.com");
  await page.goto(`/organizer/events/${event.id}`);
  await expect(
    page.getByText("LIVE · обновляется автоматически"),
  ).toBeVisible();
  await expect(page.getByTestId("waitlisted-count")).toHaveText("1");
  const startsAt = new Date(Date.now() + 345_600_000).toISOString();
  const response = await page.request.put(`/api/organizer/events/${event.id}`, {
    data: {
      ...event,
      capacity: 2,
      title: "Updated live event",
      starts_at: startsAt,
    },
  });
  expect(response.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Updated live event", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("confirmed-count")).toHaveText("2 / 2");
  await expect(page.getByTestId("waitlisted-count")).toHaveText("0");
  const displayedDate = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: "UTC",
  }).format(new Date(startsAt));
  await expect(page.locator(".dashboard-heading")).toContainText(displayedDate);
  expect(
    (await page.request.post(`/api${old.manage_url}/cancel`)).status(),
  ).toBe(200);
  await register(page, event.id, "swap-new@example.com");
  await expect(
    page.getByRole("row").filter({ hasText: "swap-new@example.com" }),
  ).toContainText("Место подтверждено");
  await expect(
    page.getByRole("row").filter({ hasText: "swap-old@example.com" }),
  ).toContainText("Участие отменено");
  await expect(page.getByTestId("confirmed-count")).toHaveText("2 / 2");
});

/** Reject the second stale editor while retaining its unsaved text and the first save. */
test("F4 two editor tabs cannot silently overwrite each other", async function editorConflict({
  page,
  context,
}) {
  const event = await createEvent(page);
  const second = await context.newPage();
  await page.goto(`/organizer/events/${event.id}/edit`);
  await second.goto(`/organizer/events/${event.id}/edit`);
  await second.getByLabel("Описание", { exact: true }).fill("Second tab draft");
  await page.getByLabel("Название события").fill("First tab saved title");
  await page.getByRole("button", { name: "Сохранить изменения" }).click();
  await expect(page).toHaveURL(new RegExp(`/organizer/events/${event.id}$`));
  await second.getByRole("button", { name: "Сохранить изменения" }).click();
  await expect(second.getByRole("alert")).toContainText(/измен|обнов/i);
  await expect(second).toHaveURL(
    new RegExp(`/organizer/events/${event.id}/edit$`),
  );
  await expect(second.getByLabel("Описание", { exact: true })).toHaveValue(
    "Second tab draft",
  );
  const saved = await (
    await page.request.get(`/api/events/${event.id}`)
  ).json();
  expect(saved.title).toBe("First tab saved title");
  expect(saved.description).toBe(event.description);
  await second.close();
});

/** Allow a response slower than the poll interval to finish without cancellation. */
test("F5 ticket loads with responses delayed beyond three seconds", async function slowTicket({
  page,
}) {
  const event = await createEvent(page);
  const registration = await register(page, event.id, "slow@example.com");
  let requests = 0;
  let failures = 0;
  page.on(
    "requestfailed",
    /** Count aborted or failed ticket requests. */ function failed(request) {
      if (request.url().includes("/api/tickets/")) failures += 1;
    },
  );
  await page.route(
    "**/api/tickets/*",
    /** Delay actual successful ticket responses. */ async function slowResponse(
      route,
    ) {
      requests += 1;
      const response = await route.fetch();
      await new Promise(
        /** Hold delivery longer than the previous polling interval. */ function delay(
          resolve,
        ) {
          setTimeout(resolve, 4_200);
        },
      );
      await route.fulfill({ response });
    },
  );
  await page.goto(registration.manage_url!);
  await expect(page.getByTestId("ticket-code")).toBeVisible({ timeout: 9_000 });
  expect(requests).toBe(1);
  expect(failures).toBe(0);
});

for (const recoverAfterStart of [false, true]) {
  /** Persist a lost-response recovery key across reload, including after the event starts. */
  test(`F6 lost response can be retried ${recoverAfterStart ? "after start" : "before start"}`, async function lostResponse({
    page,
  }) {
    const event = await createEvent(
      page,
      recoverAfterStart ? 4_000 : undefined,
    );
    const keys: string[] = [];
    let loseResponse = true;
    await page.route(
      `**/api/events/${event.id}/registrations`,
      /** Drop only delivery of the first real registration result. */ async function registrationResponse(
        route,
      ) {
        keys.push(route.request().postDataJSON().idempotency_key);
        if (loseResponse) {
          loseResponse = false;
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          await route.abort("failed");
        } else await route.continue();
      },
    );
    await page.goto(`/events/${event.id}`);
    await page.getByLabel("Ваш email").fill("recover@example.com");
    await page.getByRole("button", { name: "Зарегистрироваться ↗" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("alert")).not.toContainText("Failed to fetch");
    if (recoverAfterStart) {
      await expect(
        page.getByRole("heading", { name: "Событие началось", exact: true }),
      ).toBeVisible();
    }
    await page.reload();
    await expect(page.getByLabel("Ваш email")).toHaveValue(
      "recover@example.com",
    );
    await page.getByLabel("Ваш email").fill("RECOVER@example.com");
    await page
      .getByRole("button", {
        name: recoverAfterStart
          ? "Восстановить билет ↗"
          : /Встать в лист ожидания|Зарегистрироваться/,
      })
      .click();
    await expect(page.getByTestId("ticket-code")).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i,
    );
    expect(keys[1]).toBe(keys[0]);
    const participants = await (
      await page.request.get(`/api/organizer/events/${event.id}/participants`)
    ).json();
    expect(participants).toHaveLength(1);
  });
}

/** Let the organizer recover a stale participant list after a failed live refresh. */
test("F7 participant list can retry without another SSE mutation", async function participantsRetry({
  page,
}) {
  const event = await createEvent(page);
  await register(page, event.id, "visible@example.com");
  let unavailable = false;
  await page.route(
    `**/api/organizer/events/${event.id}/participants`,
    /** Fail only participant refreshes while the simulated gateway is unavailable. */ async function participantResponse(
      route,
    ) {
      if (unavailable)
        await route.fulfill({
          status: 502,
          contentType: "text/html",
          body: "<h1>Bad Gateway</h1>",
        });
      else await route.continue();
    },
  );
  await page.goto(`/organizer/events/${event.id}`);
  await expect(
    page.getByText("LIVE · обновляется автоматически"),
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "visible@example.com" }),
  ).toBeVisible();
  unavailable = true;
  await register(page, event.id, "waiting-for-retry@example.com");
  await expect(page.getByRole("alert")).toContainText(/последн|устар/i);
  await expect(
    page.getByRole("row").filter({ hasText: "visible@example.com" }),
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "waiting-for-retry@example.com" }),
  ).toHaveCount(0);
  unavailable = false;
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "waiting-for-retry@example.com" }),
  ).toContainText("В листе ожидания");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

/** Translate a non-JSON gateway failure and offer a working retry on initial load. */
test("F7 event 502 has readable feedback and retry", async function initialGatewayError({
  page,
}) {
  const event = await createEvent(page);
  let unavailable = true;
  await page.route(
    `**/api/events/${event.id}`,
    /** Simulate the gateway until the user retries. */ async function gateway(
      route,
    ) {
      if (unavailable)
        await route.fulfill({
          status: 502,
          contentType: "text/html",
          body: "<h1>Bad Gateway</h1>",
        });
      else await route.continue();
    },
  );
  await page.goto(`/events/${event.id}`);
  await expect(page.getByRole("alert")).toContainText(
    /сервер|сервис|временно|недоступ|соедин/i,
  );
  await expect(page.getByRole("alert")).not.toContainText(
    /JSON|Unexpected token|Bad Gateway/,
  );
  unavailable = false;
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: event.title, exact: true }),
  ).toBeVisible();
});

/** Retain the last ticket during a transient error, recover, and discard an invalid ticket. */
test("F7 ticket survives temporary errors but clears a permanent 404", async function staleTicket({
  page,
}) {
  const event = await createEvent(page);
  const registration = await register(page, event.id, "stale@example.com");
  let status = 200;
  await page.route(
    "**/api/tickets/*",
    /** Change subsequent polling responses without touching the database. */ async function ticketResponse(
      route,
    ) {
      if (status === 200) await route.continue();
      else if (status === 502)
        await route.fulfill({
          status,
          contentType: "text/html",
          body: "<h1>Bad Gateway</h1>",
        });
      else
        await route.fulfill({
          status,
          json: { detail: "Регистрация не найдена" },
        });
    },
  );
  await page.goto(registration.manage_url!);
  await expect(page.getByTestId("ticket-code")).toBeVisible();
  const code = await page.getByTestId("ticket-code").textContent();
  status = 502;
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("alert")).not.toContainText(
    /JSON|Unexpected token/,
  );
  await expect(page.getByTestId("ticket-code")).toHaveText(code!);
  await expect(page.getByText(/устар|последн|не обнов/i).first()).toBeVisible();
  status = 200;
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("ticket-code")).toHaveText(code!);
  status = 404;
  await expect(page.getByTestId("ticket-code")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("Регистрация не найдена");
});
