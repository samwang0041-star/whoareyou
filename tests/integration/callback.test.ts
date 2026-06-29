import { createHash } from "crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { GET as getQr } from "../../app/api/qr/route";
import { POST as postCallback } from "../../app/api/wechat/callback/route";
import { fakeOpenClaw, handleFakeInbound } from "../../src/adapters/fake-openclaw";
import { voice } from "../../src/domain/voice";
import { prisma } from "../../src/storage/prisma";

const now = new Date("2026-06-30T10:00:00.000Z");

type FakeInboundInput = {
  providerMessageKey: string;
  providerUserId: string;
  text: string;
  receivedAt?: Date;
};

async function cleanDatabase() {
  await prisma.inboundDedupe.deleteMany();
  await prisma.echo.deleteMany();
  await prisma.report.deleteMany();
  await prisma.scheduledJob.deleteMany();
  await prisma.messageOutbox.deleteMany();
  await prisma.pairBlock.deleteMany();
  await prisma.connection.deleteMany();
  await prisma.user.deleteMany();
}

function fakeInbound(input: FakeInboundInput) {
  return {
    providerMessageKey: input.providerMessageKey,
    providerUserId: input.providerUserId,
    text: input.text,
    receivedAt: input.receivedAt ?? now,
  };
}

async function sendFake(input: FakeInboundInput) {
  return handleFakeInbound(fakeInbound(input));
}

async function openUser(providerMessageKey: string, providerUserId: string) {
  return sendFake({ providerMessageKey, providerUserId, text: "打开" });
}

async function createOpenMatch(userAProviderId = "callback-user-a", userBProviderId = "callback-user-b") {
  await openUser("match-open-a", userAProviderId);
  await openUser("match-open-b", userBProviderId);

  return prisma.connection.findFirstOrThrow({
    where: { state: "active" },
    orderBy: { startedAt: "asc" },
  });
}

function hashProviderUserId(providerUserId: string) {
  return createHash("sha256").update(providerUserId).digest("hex");
}

describe("fake OpenClaw callback", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("parses fake inbound and exposes a fake QR entry URL", async () => {
    const receivedAt = "2026-06-30T10:01:00.000Z";

    expect(
      fakeOpenClaw.parseInbound({
        providerMessageKey: "parse-message",
        providerUserId: "parse-user",
        text: "帮助",
        receivedAt,
      }),
    ).toEqual({
      providerMessageKey: "parse-message",
      providerUserId: "parse-user",
      text: "帮助",
      receivedAt: new Date(receivedAt),
    });

    const response = await getQr();
    await expect(response.json()).resolves.toEqual({ url: "/api/wechat/callback?fake=1" });
  });

  it("dedupes inbound messages and stores only the hashed provider identity", async () => {
    const input = fakeInbound({
      providerMessageKey: "dedupe-message",
      providerUserId: "raw-provider-user",
      text: "帮助",
    });

    await expect(handleFakeInbound(input)).resolves.toEqual({ status: "processed" });
    await expect(handleFakeInbound(input)).resolves.toEqual({ status: "duplicate" });

    await expect(prisma.inboundDedupe.count()).resolves.toBe(1);
    await expect(prisma.messageOutbox.count()).resolves.toBe(1);
    await expect(prisma.user.findFirstOrThrow()).resolves.toMatchObject({
      providerUserHash: hashProviderUserId("raw-provider-user"),
    });
    const user = await prisma.user.findFirstOrThrow();
    expect(user.providerUserHash).not.toContain("raw-provider-user");
  });

  it("matches two users through the callback POST route when both open", async () => {
    const first = await postCallback(
      new Request("http://local.test/api/wechat/callback", {
        method: "POST",
        body: JSON.stringify(fakeInbound({ providerMessageKey: "route-open-a", providerUserId: "route-user-a", text: "打开" })),
      }),
    );
    const second = await postCallback(
      new Request("http://local.test/api/wechat/callback", {
        method: "POST",
        body: JSON.stringify(fakeInbound({ providerMessageKey: "route-open-b", providerUserId: "route-user-b", text: "打开" })),
      }),
    );

    await expect(first.json()).resolves.toEqual({ status: "processed" });
    await expect(second.json()).resolves.toEqual({ status: "processed" });

    const connection = await prisma.connection.findFirstOrThrow();
    expect(connection).toMatchObject({ state: "active" });
    await expect(prisma.user.count()).resolves.toBe(2);

    const outbox = await prisma.messageOutbox.findMany({ orderBy: { idempotencyKey: "asc" } });
    expect(outbox.map((message) => message.bodyCiphertextOrBody)).toEqual([
      voice.matchStarted(),
      voice.matchStarted(),
      voice.waitingFull(),
    ]);
  });

  it("relays matched human messages to the other active participant", async () => {
    const connection = await createOpenMatch();
    const sender = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("callback-user-a") },
    });
    const recipientId = connection.userAId === sender.id ? connection.userBId : connection.userAId;

    await sendFake({
      providerMessageKey: "relay-message",
      providerUserId: "callback-user-a",
      text: "今晚的风很安静",
    });

    await expect(
      prisma.messageOutbox.findUniqueOrThrow({
        where: { idempotencyKey: "relay-message:relay" },
      }),
    ).resolves.toMatchObject({
      connectionId: connection.id,
      recipientUserId: recipientId,
      bodyCiphertextOrBody: "今晚的风很安静",
    });
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: sender.id },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: "matched" });
  });

  it("refreshes reachability for an existing matched user without rewriting match state", async () => {
    const connection = await createOpenMatch("state-user-a", "state-user-b");
    const sender = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("state-user-a") },
    });

    await sendFake({
      providerMessageKey: "state-preserving-message",
      providerUserId: "state-user-a",
      text: "我还在这里",
      receivedAt: new Date("2026-06-30T10:05:00.000Z"),
    });

    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: sender.id },
        select: { state: true, matchingEnabled: true, reachableUntil: true },
      }),
    ).resolves.toEqual({
      state: "matched",
      matchingEnabled: true,
      reachableUntil: new Date("2026-07-01T10:05:00.000Z"),
    });
    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "active",
    });
  });

  it("answers ordinary unmatched messages with product copy instead of relaying", async () => {
    await sendFake({
      providerMessageKey: "unmatched-message",
      providerUserId: "unmatched-user",
      text: "有人在吗",
    });

    await expect(prisma.connection.count()).resolves.toBe(0);
    await expect(
      prisma.messageOutbox.findUniqueOrThrow({
        where: { idempotencyKey: "unmatched-message:no-match" },
      }),
    ).resolves.toMatchObject({
      bodyCiphertextOrBody: voice.unknown(),
    });
  });

  it("pauses matching and can open again to match later", async () => {
    await openUser("pause-open-a", "pause-user-a");
    await sendFake({ providerMessageKey: "pause-a", providerUserId: "pause-user-a", text: "暂停" });

    await expect(
      prisma.user.findUniqueOrThrow({
        where: { providerUserHash: hashProviderUserId("pause-user-a") },
        select: { state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual({ state: "paused", matchingEnabled: false });

    await openUser("pause-open-b", "pause-user-b");
    await expect(prisma.connection.count()).resolves.toBe(0);

    await openUser("pause-reopen-a", "pause-user-a");

    await expect(prisma.connection.count()).resolves.toBe(1);
    await expect(prisma.connection.findFirstOrThrow()).resolves.toMatchObject({ state: "active" });
  });

  it("handles leave without blocking future matches from an awaiting echo connection", async () => {
    const firstConnection = await createOpenMatch("leave-user-a", "leave-user-b");

    await sendFake({ providerMessageKey: "leave-a", providerUserId: "leave-user-a", text: "离开" });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: firstConnection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "left",
    });
    await expect(prisma.pairBlock.count()).resolves.toBe(1);

    await openUser("leave-open-c", "leave-user-c");
    await openUser("leave-reopen-a", "leave-user-a");

    const activeConnection = await prisma.connection.findFirstOrThrow({
      where: { state: "active" },
      orderBy: { startedAt: "desc" },
    });
    const reopenedUser = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("leave-user-a") },
    });
    expect([activeConnection.userAId, activeConnection.userBId]).toContain(reopenedUser.id);
  });

  it("handles report by recording the report and closing the active connection", async () => {
    const connection = await createOpenMatch("report-user-a", "report-user-b");

    await sendFake({ providerMessageKey: "report-a", providerUserId: "report-user-a", text: "举报" });

    await expect(prisma.report.count()).resolves.toBe(1);
    await expect(prisma.pairBlock.count()).resolves.toBe(1);
    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "reported",
    });
  });

  it("retries failed inbound callbacks with the same provider message key", async () => {
    const input = fakeInbound({
      providerMessageKey: "retry-failed-inbound",
      providerUserId: "retry-user",
      text: "帮助",
    });
    await prisma.inboundDedupe.create({
      data: {
        providerMessageKey: input.providerMessageKey,
        receivedAt: input.receivedAt,
        status: "failed",
        processedAt: input.receivedAt,
      },
    });

    await expect(handleFakeInbound(input)).resolves.toEqual({ status: "processed" });

    await expect(prisma.inboundDedupe.findUniqueOrThrow({ where: { providerMessageKey: input.providerMessageKey } })).resolves.toMatchObject({
      status: "processed",
      processedAt: input.receivedAt,
    });
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "retry-failed-inbound:help" } })).resolves.toMatchObject({
      bodyCiphertextOrBody: voice.help(),
    });
  });

  it("treats retry-created duplicate outbox rows as idempotent", async () => {
    const input = fakeInbound({
      providerMessageKey: "retry-partial-outbox",
      providerUserId: "retry-partial-user",
      text: "帮助",
    });
    const user = await prisma.user.create({
      data: {
        providerUserHash: hashProviderUserId(input.providerUserId),
        state: "available",
        matchingEnabled: true,
      },
    });
    await prisma.inboundDedupe.create({
      data: {
        providerMessageKey: input.providerMessageKey,
        receivedAt: input.receivedAt,
        status: "failed",
        processedAt: input.receivedAt,
      },
    });
    await prisma.messageOutbox.create({
      data: {
        recipientUserId: user.id,
        idempotencyKey: "retry-partial-outbox:help",
        bodyCiphertextOrBody: voice.help(),
      },
    });

    await expect(handleFakeInbound(input)).resolves.toEqual({ status: "processed" });

    await expect(prisma.messageOutbox.count({ where: { idempotencyKey: "retry-partial-outbox:help" } })).resolves.toBe(1);
    await expect(prisma.inboundDedupe.findUniqueOrThrow({ where: { providerMessageKey: input.providerMessageKey } })).resolves.toMatchObject({
      status: "processed",
    });
  });

  it("retries stale processing inbound callbacks with the same provider message key", async () => {
    const input = fakeInbound({
      providerMessageKey: "retry-stale-processing",
      providerUserId: "retry-stale-user",
      text: "帮助",
      receivedAt: new Date("2026-01-01T10:00:00.000Z"),
    });
    await prisma.inboundDedupe.create({
      data: {
        providerMessageKey: input.providerMessageKey,
        receivedAt: input.receivedAt,
        status: "processing",
      },
    });

    await expect(handleFakeInbound(input)).resolves.toEqual({ status: "processed" });
    await expect(prisma.inboundDedupe.findUniqueOrThrow({ where: { providerMessageKey: input.providerMessageKey } })).resolves.toMatchObject({
      status: "processed",
      receivedAt: input.receivedAt,
      processedAt: input.receivedAt,
    });
  });

  it("returns 400 for invalid callback payloads", async () => {
    const response = await postCallback(
      new Request("http://local.test/api/wechat/callback", {
        method: "POST",
        body: JSON.stringify({ providerMessageKey: "bad-payload" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_payload" });
  });
});
