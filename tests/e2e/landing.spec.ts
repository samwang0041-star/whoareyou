import { expect, test } from "@playwright/test";

test("landing page shows ritual entry and fetches QR", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "你是谁" })).toBeVisible();
  await expect(page.getByText("扫码，遇见一个陌生人。")).toBeVisible();
  await expect(page.getByText("这一次，入口后面不是 AI。")).toBeVisible();

  const enterButton = page.getByRole("button", { name: "进入" });
  await expect(enterButton).toBeEnabled();
  await enterButton.click();

  await expect(page.getByText("入口已经亮起。")).toBeVisible();
  await expect(page.getByText("/api/wechat/callback?fake=1")).toBeVisible();
});
