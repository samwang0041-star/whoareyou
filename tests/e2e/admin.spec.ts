import { expect, test } from "@playwright/test";
import { prisma } from "../../src/storage/prisma";

async function cleanDatabase() {
  await prisma.metricSnapshot.deleteMany();
  await prisma.workerHeartbeat.deleteMany();
  await prisma.appError.deleteMany();
  await prisma.rateLimitEvent.deleteMany();
  await prisma.inboundDedupe.deleteMany();
  await prisma.echo.deleteMany();
  await prisma.report.deleteMany();
  await prisma.scheduledJob.deleteMany();
  await prisma.messageOutbox.deleteMany();
  await prisma.pairBlock.deleteMany();
  await prisma.connection.deleteMany();
  await prisma.user.deleteMany();
}

test("admin overview opens anonymous connection detail without chat text", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "DB-backed admin flow only needs one browser project");
  test.skip(!process.env.ADMIN_TOKEN, "ADMIN_TOKEN is required for admin E2E");

  await cleanDatabase();

  const userA = await prisma.user.create({
    data: {
      providerUserHash: `admin-e2e-a-${Date.now()}`,
      state: "matched",
      matchingEnabled: true,
      reachableUntil: new Date("2026-06-30T12:00:00.000Z"),
    },
  });
  const userB = await prisma.user.create({
    data: {
      providerUserHash: `admin-e2e-b-${Date.now()}`,
      state: "matched",
      matchingEnabled: true,
      reachableUntil: new Date("2026-06-30T12:00:00.000Z"),
    },
  });
  const connection = await prisma.connection.create({
    data: {
      userAId: userA.id,
      userBId: userB.id,
      state: "active",
      startedAt: new Date("2026-06-30T10:00:00.000Z"),
    },
  });
  await prisma.messageOutbox.create({
    data: {
      connectionId: connection.id,
      recipientUserId: userB.id,
      idempotencyKey: "admin-e2e-secret-message",
      bodyCiphertextOrBody: "chat text should not appear",
      nextAttemptAt: new Date("2026-06-30T10:00:00.000Z"),
    },
  });

  await page.goto("/admin");
  await page.getByLabel("Admin token").fill(process.env.ADMIN_TOKEN ?? "");
  await page.getByRole("button", { name: "连接" }).click();

  await expect(page.getByRole("heading", { name: "运营监控" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "连接列表" })).toBeVisible();
  await expect(page.getByRole("link", { name: connection.id })).toBeVisible();

  await page.getByRole("link", { name: connection.id }).click();
  await expect(page.getByRole("heading", { name: `连接 ${connection.id}` })).toBeVisible();

  await page.getByLabel("Admin token").fill(process.env.ADMIN_TOKEN ?? "");
  await page.getByRole("button", { name: "连接" }).click();

  await expect(page.getByRole("heading", { name: "Participants" })).toBeVisible();
  await expect(page.getByText("Outbox summary")).toBeVisible();
  await expect(page.getByText("chat text should not appear")).toHaveCount(0);
});
