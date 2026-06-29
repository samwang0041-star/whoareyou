import { expect, test } from "@playwright/test";
import { hashProviderUserId } from "../../src/domain/identity";
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

test("fake users can enter, match, and relay one human message", async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "API core flow only needs one browser project");

  await cleanDatabase();

  const suffix = `${Date.now()}-${testInfo.workerIndex}`;
  const userA = `e2e-a-${suffix}`;
  const userB = `e2e-b-${suffix}`;
  const userAHash = hashProviderUserId(userA);
  const userBHash = hashProviderUserId(userB);

  const firstOpen = await request.post("/api/wechat/callback", {
    data: {
      providerMessageKey: `e2e-a-open-${suffix}`,
      providerUserId: userA,
      text: "打开",
      receivedAt: "2026-06-29T10:00:00.000Z",
    },
  });
  expect(firstOpen.ok()).toBeTruthy();

  const secondOpen = await request.post("/api/wechat/callback", {
    data: {
      providerMessageKey: `e2e-b-open-${suffix}`,
      providerUserId: userB,
      text: "打开",
      receivedAt: "2026-06-29T10:00:10.000Z",
    },
  });
  expect(secondOpen.ok()).toBeTruthy();

  const users = await prisma.user.findMany({
    where: { providerUserHash: { in: [userAHash, userBHash] } },
    select: { id: true, providerUserHash: true, state: true },
    orderBy: { providerUserHash: "asc" },
  });
  expect(users).toHaveLength(2);
  expect(users.every((user) => user.state === "matched")).toBe(true);

  const connection = await prisma.connection.findFirstOrThrow({
    where: {
      state: "active",
      OR: [
        { userAId: users[0].id, userBId: users[1].id },
        { userAId: users[1].id, userBId: users[0].id },
      ],
    },
  });

  const message = await request.post("/api/wechat/callback", {
    data: {
      providerMessageKey: `e2e-a-message-${suffix}`,
      providerUserId: userA,
      text: "今天你为什么会扫进来？",
      receivedAt: "2026-06-29T10:01:00.000Z",
    },
  });
  expect(message.ok()).toBeTruthy();

  const sender = users.find((user) => user.providerUserHash === userAHash);
  const recipient = users.find((user) => user.providerUserHash === userBHash);
  expect(sender).toBeDefined();
  expect(recipient).toBeDefined();

  await expect(
    prisma.messageOutbox.findUniqueOrThrow({
      where: { idempotencyKey: `e2e-a-message-${suffix}:relay` },
    }),
  ).resolves.toMatchObject({
    connectionId: connection.id,
    recipientUserId: recipient?.id,
    bodyCiphertextOrBody: "今天你为什么会扫进来？",
  });
});
