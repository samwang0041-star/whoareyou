import { expect, test, type Page } from "@playwright/test";

const imageSrc =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function qrFixture(sessionId: string, payloadUrl = `http://localhost:3000/api/wechat/callback?fake=1&qr_session=${sessionId}`) {
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  return {
    provider: "openclaw-weixin",
    mode: "fake",
    sessionId,
    status: "waiting_to_scan",
    expiresAt,
    qr: {
      imageSrc,
      payloadUrl,
    },
    statusUrl: `/api/qr/status?sessionId=${sessionId}&expiresAt=${encodeURIComponent(expiresAt)}`,
  };
}

async function routeRelayHappyPath(page: Page) {
  let statusCalls = 0;
  let peerQrIssued = false;

  await page.route("**/api/relay/invites", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        inviteId: "invite-1",
        state: "a_qr_issued",
        aQr: qrFixture("a-session"),
      }),
    });
  });

  await page.route("**/api/relay/invites/invite-1/status", async (route) => {
    statusCalls += 1;
    const state = peerQrIssued
      ? statusCalls >= 5
        ? "connected"
        : "waiting_for_b_scan"
      : statusCalls >= 2
        ? "a_bound"
        : "a_waiting_to_scan";

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        state,
        canIssuePeerQr: state === "a_bound",
      }),
    });
  });

  await page.route("**/api/relay/invites/invite-1/peer-qr", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    peerQrIssued = true;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        state: "waiting_for_b_scan",
        bQr: qrFixture("b-session"),
      }),
    });
  });
}

test("landing page guides A scan, then gives A a B QR image to hand off", async ({ page }) => {
  await routeRelayHappyPath(page);

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "UNKNOWN RELAY" })).toBeVisible();
  await expect(page.locator("body")).toContainText("生成一张入口图");
  await expect(page.locator("body")).toContainText("发 /断开，关系会消失");
  await expect(page.locator("body")).not.toContainText("匿名社交");

  await page.getByRole("button", { name: "生成入口" }).click();

  await expect(page.getByTestId("relay-a-qr")).toBeVisible();
  await expect(page.getByRole("heading", { name: "先让 A 扫这张入口图" })).toBeVisible();
  await expect(page.getByTestId("relay-b-qr")).toHaveCount(0);

  await expect(page.getByTestId("relay-b-qr")).toBeVisible({ timeout: 7000 });
  await expect(page.getByRole("heading", { name: "把这张图交给 B" })).toBeVisible();
  await expect(page.getByText("不是分享按钮，是一张只属于这次连接的入口图。").first()).toBeVisible();
  await expect(page.getByText("等 B 扫进来")).toBeVisible();

  await expect(page.getByRole("heading", { name: "已经接通" })).toBeVisible({ timeout: 7000 });
  await expect(page.getByText("回到微信说话。发 /断开，关系会消失。").first()).toBeVisible();
});

test("real fake relay QR flow reaches connected state", async ({ page, request }) => {
  await page.goto("/");

  const createResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/relay/invites") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "生成入口" }).click();
  const createResponse = await createResponsePromise;
  const created = await createResponse.json();

  await expect(page.getByTestId("relay-a-qr")).toBeVisible();
  expect((await request.get(created.aQr.qr.payloadUrl)).ok()).toBe(true);

  const peerResponsePromise = page.waitForResponse((response) =>
    response.url().includes("/api/relay/invites/") &&
    response.url().endsWith("/peer-qr") &&
    response.request().method() === "POST",
  );
  await expect(page.getByTestId("relay-b-qr")).toBeVisible({ timeout: 7000 });

  const peerResponse = await peerResponsePromise;
  const peer = await peerResponse.json();
  expect((await request.get(peer.bQr.qr.payloadUrl)).ok()).toBe(true);

  await expect(page.getByRole("heading", { name: "已经接通" })).toBeVisible({ timeout: 7000 });
});

test("mobile copy asks B to long-press the handoff image", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await routeRelayHappyPath(page);

  await page.goto("/");
  await page.getByRole("button", { name: "生成入口" }).click();

  await expect(page.getByTestId("relay-b-qr")).toBeVisible({ timeout: 7000 });
  await expect(page.getByText("让 B 长按识别这张入口图")).toBeVisible();
});
