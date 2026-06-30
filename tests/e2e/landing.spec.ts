import { expect, test, type Page } from "@playwright/test";

const connectedCookieName = "whoareyou_entry_connected";
const imageSrc =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const payloadUrl = "http://localhost:3000/api/wechat/callback?fake=1";

type QrStatus =
  | "waiting_to_scan"
  | "scan_confirming"
  | "confirmed"
  | "verification_required"
  | "expired"
  | "provider_error";

function qrFixture({
  expiresAt = new Date(Date.now() + 5 * 60_000).toISOString(),
  mode = "fake",
  sessionId = "qr-ready",
  status = "waiting_to_scan",
}: {
  expiresAt?: string;
  mode?: "fake" | "openclaw";
  sessionId?: string;
  status?: QrStatus;
} = {}) {
  return {
    provider: "openclaw-weixin",
    mode,
    sessionId,
    status,
    expiresAt,
    qr: {
      imageSrc,
      payloadUrl,
    },
    statusUrl: `/api/qr/status?sessionId=${sessionId}&expiresAt=${encodeURIComponent(expiresAt)}`,
  };
}

async function routeQrStatus(page: Page, status: QrStatus) {
  await page.route("**/api/qr/status?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "qr-ready",
        status,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    });
  });
}

async function expectRejectedCopyAbsent(page: Page) {
  const body = page.locator("body");
  await expect(body).not.toContainText("入口后面不是 AI");
  await expect(body).not.toContainText("不是 AI，不是客服");
  await expect(body).not.toContainText("AI 入口");
  await expect(body).not.toContainText("真人相遇");
  await expect(body).not.toContainText("微信回应慢了一点");
  await expect(body).not.toContainText("二维码仍可使用");
  await expect(body).not.toContainText("二维码没有生成成功");
  await expect(body).not.toContainText("等待验证");
}

test("landing page shows a ready QR entry", async ({ page }) => {
  const expiresAt = new Date(Date.now() + 299_000).toISOString();

  await routeQrStatus(page, "waiting_to_scan");
  await page.route("**/api/qr", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(qrFixture({ expiresAt })),
    });
  });

  await page.goto("/");

  await expect(page.getByTestId("hero-main-visual")).toBeVisible();
  await expect(page.getByRole("heading", { name: "UNKNOWN" })).toBeVisible();
  await expect(page.locator("body")).toContainText("一个 AI 爱好者的小玩具");
  await expect(page.locator("body")).toContainText("你以为又要接入一个 agent。");
  await expect(page.locator("body")).toContainText("这一次，入口后面只是一个人。");
  await expect(page.locator("body")).toContainText("把这个微信入口留给一个也停下来的人");
  await expect(page.locator("body")).toContainText("不是匿名社交，也不是一个新社区。");
  await expect(page.locator("body")).toContainText("五小时窗口、week 窗口、token 焦虑");
  await expect(page.locator("body")).toContainText("成了给它们做回归测试的人");
  await expect(page.locator("body")).toContainText("开源，不保存昵称、头像、手机号或明文聊天记录。");
  await expect(page.locator("body")).toContainText("12191628@qq.com");
  await expectRejectedCopyAbsent(page);

  await page.getByRole("button", { name: "进入" }).click();

  await expect(page.getByTestId("wechat-entry-dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "入口预演" })).toBeVisible();
  await expect(page.getByText("本地预演入口")).toBeVisible();
  await expect(page.getByText("这不是微信服务器二维码，只用于本地模拟扫码。")).toBeVisible();
  await expect(page.getByText("用微信扫一扫")).toHaveCount(0);
  await expect(page.getByTestId("wechat-qr-image")).toBeVisible();
  await expect(page.getByText("等你靠近 · 04:59")).toBeVisible();
  await expectRejectedCopyAbsent(page);
  await expect(page.getByText("/api/wechat/callback?fake=1")).toHaveCount(0);
});

test("landing page can switch between Chinese and English", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Switch to English" }).click();

  await expect(page.getByRole("heading", { name: "UNKNOWN" })).toBeVisible();
  await expect(page.locator("body")).toContainText("a small toy by an AI hobbyist");
  await expect(page.locator("body")).toContainText("This time, there is only a person behind it.");
  await expect(page.locator("body")).toContainText("Open source. No nicknames, avatars, phone numbers");
  await expect(page.getByRole("button", { name: "Enter" })).toBeVisible();

  await page.getByRole("button", { name: "切换到中文" }).click();

  await expect(page.locator("body")).toContainText("一个 AI 爱好者的小玩具");
  await expect(page.getByRole("button", { name: "进入" })).toBeVisible();
});

test("openclaw QR entry keeps the WeChat scan copy", async ({ page }) => {
  const expiresAt = new Date(Date.now() + 299_000).toISOString();

  await routeQrStatus(page, "waiting_to_scan");
  await page.route("**/api/qr", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(qrFixture({ expiresAt, mode: "openclaw" })),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "进入" }).click();

  await expect(page.getByTestId("wechat-entry-dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "微信里见" })).toBeVisible();
  await expect(page.getByText("用微信扫一扫")).toBeVisible();
  await expect(page.getByText("扫完，回到微信发「打开」。")).toBeVisible();
  await expect(page.getByText("本地预演入口")).toHaveCount(0);
});

test("QR code stays square on a narrow phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await routeQrStatus(page, "waiting_to_scan");
  await page.route("**/api/qr", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(qrFixture()),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "进入" }).click();
  const box = await page.getByTestId("wechat-qr-image").boundingBox();

  expect(box).not.toBeNull();
  expect(Math.round(box?.width ?? 0)).toBe(Math.round(box?.height ?? 0));
});

test("scan_confirming waits for WeChat confirmation without writing cookie", async ({
  context,
  page,
}) => {
  await routeQrStatus(page, "scan_confirming");
  await page.route("**/api/qr", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(qrFixture({ sessionId: "qr-confirming" })),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "进入" }).click();

  await expect(page.getByText("回到微信，发「打开」")).toBeVisible();
  await expect(page.getByText("等你开口")).toBeVisible();
  await expect(page.getByText("已经靠近。")).toHaveCount(0);
  await expectRejectedCopyAbsent(page);

  const cookies = await context.cookies();
  expect(cookies.some((cookie) => cookie.name === connectedCookieName)).toBe(false);
});

test("confirmed scan is remembered locally and skips QR after reload", async ({
  context,
  page,
}) => {
  let qrRequestCount = 0;
  let statusRequestCount = 0;

  await page.route("**/api/qr/status?**", async (route) => {
    statusRequestCount += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "scan-success",
        status: "confirmed",
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    });
  });

  await page.route("**/api/qr", async (route) => {
    qrRequestCount += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(qrFixture({ sessionId: "scan-success" })),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "进入" }).click();

  const dialog = page.getByTestId("wechat-entry-dialog");
  await expect(page.getByRole("heading", { name: "微信里见" })).toBeVisible();
  await expect(page.getByText("已经靠近。", { exact: true })).toBeVisible();
  await expect(dialog.getByText("回到微信，发「打开」。")).toBeVisible();
  await expect(page.getByRole("button", { name: "我知道了" })).toBeVisible();
  await expectRejectedCopyAbsent(page);

  const cookies = await context.cookies();
  const connectedCookie = cookies.find((cookie) => cookie.name === connectedCookieName);
  expect(connectedCookie).toBeDefined();

  const connectedEntry = JSON.parse(decodeURIComponent(connectedCookie?.value ?? ""));
  expect(Object.keys(connectedEntry).sort()).toEqual([
    "connectedAt",
    "expiresAt",
    "mode",
    "provider",
  ]);
  expect(connectedEntry).toMatchObject({
    mode: "fake",
    provider: "openclaw-weixin",
  });
  expect(Date.parse(connectedEntry.expiresAt) - Date.parse(connectedEntry.connectedAt)).toBe(
    24 * 60 * 60 * 1_000,
  );
  expect((connectedCookie?.expires ?? 0) * 1_000 - Date.now()).toBeGreaterThan(
    23 * 60 * 60 * 1_000,
  );
  expect(qrRequestCount).toBe(1);
  expect(statusRequestCount).toBeGreaterThan(0);

  await page.reload();

  await expect(page.getByRole("button", { name: "入口已亮" })).toBeVisible();
  await expect(page.getByText("回到微信，发「打开」。")).toBeVisible();

  await page.getByRole("button", { name: "入口已亮" }).click();

  await expect(page.getByRole("heading", { name: "微信里见" })).toBeVisible();
  await expect(page.getByText("已经靠近。", { exact: true })).toBeVisible();
  expect(qrRequestCount).toBe(1);
});

test("real fake QR scan confirms the entry and writes the local cookie", async ({
  context,
  page,
  request,
}) => {
  await page.goto("/");

  const qrResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/qr") && response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "进入" }).click();
  const qrResponse = await qrResponsePromise;
  const qr = (await qrResponse.json()) as ReturnType<typeof qrFixture>;

  await expect(page.getByText("本地预演入口")).toBeVisible();
  await expect((await request.get(qr.statusUrl)).json()).resolves.toMatchObject({
    sessionId: qr.sessionId,
    status: "waiting_to_scan",
  });

  const scanResponse = await request.get(qr.qr.payloadUrl);
  expect(scanResponse.ok()).toBe(true);

  const dialog = page.getByTestId("wechat-entry-dialog");
  await expect(page.getByText("已经靠近。", { exact: true })).toBeVisible({ timeout: 6_000 });
  await expect(dialog.getByText("回到微信，发「打开」。")).toBeVisible();

  const cookies = await context.cookies();
  expect(cookies.some((cookie) => cookie.name === connectedCookieName)).toBe(true);

  await page.reload();
  await expect(page.getByRole("button", { name: "入口已亮" })).toBeVisible();
});

test("expired QR can reopen the entry", async ({ page }) => {
  let requestCount = 0;

  await routeQrStatus(page, "waiting_to_scan");
  await page.route("**/api/qr", async (route) => {
    requestCount += 1;
    const expiresAt =
      requestCount === 1
        ? new Date(Date.now() - 1_000).toISOString()
        : new Date(Date.now() + 5 * 60_000).toISOString();

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        qrFixture({
          expiresAt,
          sessionId: `qr-${requestCount}`,
          status: requestCount === 1 ? "expired" : "waiting_to_scan",
        }),
      ),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "进入" }).click();

  await expect(page.getByTestId("wechat-qr-image")).toBeVisible();
  await expect(page.getByRole("heading", { name: "入口预演" })).toBeVisible();
  await expect(page.getByText("这一盏已经熄了")).toBeVisible();
  await expect(page.getByRole("button", { name: "换一个二维码" })).toBeVisible();
  await expectRejectedCopyAbsent(page);

  await page.getByRole("button", { name: "换一个二维码" }).click();

  await expect(page.getByRole("button", { name: "换一个二维码" })).toHaveCount(0);
  await expect(page.getByText(/^等你靠近 · \d{2}:\d{2}$/)).toBeVisible();
});

test("provider_error shows retrying WeChat status and can reopen after repeated errors", async ({
  context,
  page,
}) => {
  let statusRequestCount = 0;

  await page.route("**/api/qr/status?**", async (route) => {
    statusRequestCount += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "qr-provider-error",
        status: "provider_error",
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    });
  });

  await page.route("**/api/qr", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        qrFixture({
          sessionId: "qr-provider-error",
          status: "provider_error",
        }),
      ),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "进入" }).click();

  await expect(page.getByText("入口卡住了", { exact: true })).toBeVisible();
  await expect(page.getByText("换一个二维码，再试一次。")).toBeVisible();
  await expect(page.getByRole("button", { name: "换一个二维码" })).toBeVisible();
  await expectRejectedCopyAbsent(page);
  expect(statusRequestCount).toBeGreaterThanOrEqual(1);
  const countAtError = statusRequestCount;
  await page.waitForTimeout(3500);
  expect(statusRequestCount).toBe(countAtError);

  const cookies = await context.cookies();
  expect(cookies.some((cookie) => cookie.name === connectedCookieName)).toBe(false);
});

test("missing QR status session stops polling and asks the user to reopen", async ({ page }) => {
  let statusRequestCount = 0;

  await page.route("**/api/qr/status?**", async (route) => {
    statusRequestCount += 1;
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "qr_session_not_found" }),
    });
  });
  await page.route("**/api/qr", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(qrFixture({ sessionId: "missing-session" })),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "进入" }).click();

  await expect(page.getByText("入口卡住了", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "换一个二维码" })).toBeVisible();
  expect(statusRequestCount).toBe(1);
  await page.waitForTimeout(3500);
  expect(statusRequestCount).toBe(1);
});
