import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getQr } from "../../app/api/qr/route";
import { GET as getQrStatus } from "../../app/api/qr/status/route";
import { GET as getCallback, POST as postCallback } from "../../app/api/wechat/callback/route";
import { fakeOpenClaw, handleFakeInbound, setAfterInboundUserLoadHookForTest } from "../../src/adapters/fake-openclaw";
import { hashProviderUserId } from "../../src/domain/identity";
import { decodeOutboxBody } from "../../src/domain/outbox-body";
import { voice } from "../../src/domain/voice";
import { prisma } from "../../src/storage/prisma";
import { processScheduledJobs } from "../../src/workers/scheduled-jobs";

const now = new Date("2026-06-30T10:00:00.000Z");
const capacityFullBody = voice.capacityFull();
const cooldownActiveBody = voice.cooldownActive();
const partnerLeftBody = voice.partnerLeft();
const reportConfirmedBody = voice.reportConfirmed();
const peerEndedBody = voice.peerEnded();

type FakeInboundInput = {
  providerMessageKey: string;
  providerUserId: string;
  text: string;
  receivedAt?: Date;
};

async function cleanDatabase() {
  await prisma.appError.deleteMany();
  await prisma.inboundDedupe.deleteMany();
  await prisma.rateLimitEvent.deleteMany();
  await prisma.echo.deleteMany();
  await prisma.report.deleteMany();
  await prisma.scheduledJob.deleteMany();
  await prisma.messageOutbox.deleteMany();
  await prisma.pairBlock.deleteMany();
  await prisma.connection.deleteMany();
  await prisma.userProviderRef.deleteMany();
  await prisma.user.deleteMany();
  await prisma.openClawBotSession.deleteMany();
}

async function withEnv<T>(updates: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(updates).map((key) => [key, process.env[key]]));
  Object.assign(process.env, updates);

  try {
    return await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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

async function confirmLeave(providerMessageKey: string, providerUserId: string) {
  await sendFake({ providerMessageKey: `${providerMessageKey}-prompt`, providerUserId, text: "离开" });
  return sendFake({ providerMessageKey, providerUserId, text: "确认离开" });
}

async function createOpenMatch(userAProviderId = "callback-user-a", userBProviderId = "callback-user-b") {
  await openUser("match-open-a", userAProviderId);
  await openUser("match-open-b", userBProviderId);

  return prisma.connection.findFirstOrThrow({
    where: { state: "active" },
    orderBy: { startedAt: "asc" },
  });
}

async function releaseCooldownFor(providerUserId: string, releasedAt = new Date(now.getTime() + 60_000)) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { providerUserHash: hashProviderUserId(providerUserId) },
  });
  await prisma.scheduledJob.updateMany({
    where: { userId: user.id, type: "cooldown_release" },
    data: { runAt: releasedAt },
  });
  await processScheduledJobs({ now: releasedAt, limit: 10, cooldownSeconds: 60 });
  return user;
}

describe("fake OpenClaw callback", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setAfterInboundUserLoadHookForTest(null);
  });

  it("parses fake inbound and exposes a fake QR entry session", async () => {
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

    const response = await getQr(new Request("http://localhost:3000/api/qr"));
    const qr = await response.json();
    expect(qr).toMatchObject({
      provider: "openclaw-weixin",
      mode: "fake",
      status: "waiting_to_scan",
    });
    expect(qr.qr.imageSrc).toMatch(/^data:image\/png;base64,/);
    expect(qr.qr.payloadUrl).toContain("/api/wechat/callback?fake=1");
    expect(qr.statusUrl).toContain("/api/qr/status?sessionId=");
  });

  it("confirms a fake QR session when the payload URL is scanned", async () => {
    const response = await getQr(new Request("http://localhost:3000/api/qr"));
    const qr = await response.json();

    await expect(getQrStatus(new Request(`http://localhost:3000${qr.statusUrl}`)).then((statusResponse) => statusResponse.json())).resolves.toMatchObject({
      sessionId: qr.sessionId,
      status: "waiting_to_scan",
    });

    const scanResponse = await getCallback(new Request(qr.qr.payloadUrl));
    expect(scanResponse.status).toBe(200);
    await expect(scanResponse.text()).resolves.toContain("发「打开」");

    await expect(getQrStatus(new Request(`http://localhost:3000${qr.statusUrl}`)).then((statusResponse) => statusResponse.json())).resolves.toMatchObject({
      sessionId: qr.sessionId,
      status: "confirmed",
    });
  });

  it("returns 404 for unknown fake QR status sessions instead of waiting forever", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const response = await getQrStatus(
      new Request(`http://localhost:3000/api/qr/status?sessionId=missing-qr-session&expiresAt=${encodeURIComponent(expiresAt)}`),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "qr_session_not_found" });
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
    await expect(prisma.inboundDedupe.findFirstOrThrow()).resolves.toMatchObject({ duplicateCount: 1 });
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
    ]);
    expect(outbox.every((message) => message.idempotencyKey.endsWith(":waiting"))).toBe(false);
  });

  it("returns 404 for fake callback payloads in openclaw provider mode", async () => {
    await withEnv({ PROVIDER_MODE: "openclaw" }, async () => {
      const response = await postCallback(
        new Request("http://local.test/api/wechat/callback", {
          method: "POST",
          body: JSON.stringify(fakeInbound({ providerMessageKey: "openclaw-route-open", providerUserId: "openclaw-route-user", text: "打开" })),
        }),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "not_found" });
    });

    await expect(prisma.inboundDedupe.count()).resolves.toBe(0);
    await expect(prisma.user.count()).resolves.toBe(0);
  });

  it("logs fake outbound messages without sensitive fields", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await fakeOpenClaw.sendOutbound({
      recipientUserId: "sensitive-recipient-user",
      idempotencyKey: "sensitive-idempotency-key",
      body: "sensitive outbound body",
    });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("fakeOutbound");
    expect(output).not.toContain("sensitive-recipient-user");
    expect(output).not.toContain("sensitive-idempotency-key");
    expect(output).not.toContain("sensitive outbound body");
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

    const outboxMessage = await prisma.messageOutbox.findUniqueOrThrow({
      where: { idempotencyKey: "relay-message:relay" },
    });
    expect(outboxMessage).toMatchObject({
      connectionId: connection.id,
      recipientUserId: recipientId,
    });
    expect(outboxMessage.bodyCiphertextOrBody).not.toContain("今晚的风很安静");
    expect(decodeOutboxBody(outboxMessage.bodyCiphertextOrBody ?? "")).toEqual({
      body: "今晚的风很安静",
      encrypted: true,
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

  it("answers ordinary waiting messages with waiting copy instead of asking to open again", async () => {
    await openUser("waiting-message-open", "waiting-message-user");
    await sendFake({
      providerMessageKey: "waiting-message",
      providerUserId: "waiting-message-user",
      text: "有人在吗",
    });

    await expect(prisma.connection.count()).resolves.toBe(0);
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "waiting-message:no-match" } })).resolves.toMatchObject({
      bodyCiphertextOrBody: voice.waitingStill(),
    });
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "waiting-message:no-match" } })).resolves.not.toMatchObject({
      bodyCiphertextOrBody: expect.stringContaining("发「打开」"),
    });
  });

  it.each([
    { label: "help", text: "帮助", passiveMessageKey: "passive-help-a", openerMessageKey: "passive-help-b" },
    { label: "ordinary", text: "有人在吗", passiveMessageKey: "passive-ordinary-a", openerMessageKey: "passive-ordinary-b" },
  ])("does not match a user created by a $label message until they explicitly open", async ({ text, passiveMessageKey, openerMessageKey }) => {
    await sendFake({
      providerMessageKey: passiveMessageKey,
      providerUserId: `${passiveMessageKey}-user`,
      text,
    });

    const passiveUser = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId(`${passiveMessageKey}-user`) },
      select: { state: true, matchingEnabled: true },
    });
    expect(passiveUser).toEqual({ state: "new", matchingEnabled: false });

    await openUser(openerMessageKey, `${openerMessageKey}-user`);

    await expect(prisma.connection.count()).resolves.toBe(0);
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { providerUserHash: hashProviderUserId(`${openerMessageKey}-user`) },
        select: { state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual({ state: "waiting", matchingEnabled: true });
  });

  it("answers help according to the current user state", async () => {
    await openUser("help-waiting-open", "help-waiting-user");
    await sendFake({ providerMessageKey: "help-waiting", providerUserId: "help-waiting-user", text: "帮助" });
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "help-waiting:help" } })).resolves.toMatchObject({
      bodyCiphertextOrBody: voice.helpWaiting(),
    });
    await prisma.user.update({
      where: { providerUserHash: hashProviderUserId("help-waiting-user") },
      data: { state: "paused", matchingEnabled: false },
    });

    await createOpenMatch("help-matched-user-a", "help-matched-user-b");
    await sendFake({ providerMessageKey: "help-matched", providerUserId: "help-matched-user-a", text: "帮助" });
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "help-matched:help" } })).resolves.toMatchObject({
      bodyCiphertextOrBody: voice.helpMatched(),
    });

    await confirmLeave("help-cooldown-leave", "help-matched-user-a");
    await sendFake({ providerMessageKey: "help-cooldown", providerUserId: "help-matched-user-a", text: "帮助" });
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "help-cooldown:help" } })).resolves.toMatchObject({
      bodyCiphertextOrBody: voice.helpCooldown(),
    });

    await sendFake({ providerMessageKey: "help-paused-open", providerUserId: "help-paused-user", text: "打开" });
    await sendFake({ providerMessageKey: "help-paused-pause", providerUserId: "help-paused-user", text: "暂停" });
    await sendFake({ providerMessageKey: "help-paused", providerUserId: "help-paused-user", text: "帮助" });
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "help-paused:help" } })).resolves.toMatchObject({
      bodyCiphertextOrBody: voice.helpPaused(),
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
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "pause-a:pause-confirmed" } })).resolves.toMatchObject({
      bodyCiphertextOrBody: voice.pauseConfirmed(),
    });

    await openUser("pause-open-b", "pause-user-b");
    await expect(prisma.connection.count()).resolves.toBe(0);

    await openUser("pause-reopen-a", "pause-user-a");

    await expect(prisma.connection.count()).resolves.toBe(1);
    await expect(prisma.connection.findFirstOrThrow()).resolves.toMatchObject({ state: "active" });
  });

  it("keeps an active match intact when a user pauses future matching", async () => {
    const connection = await createOpenMatch("pause-active-user-a", "pause-active-user-b");
    const actor = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("pause-active-user-a") },
    });

    await sendFake({ providerMessageKey: "pause-active-a", providerUserId: "pause-active-user-a", text: "暂停" });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "active",
    });
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: actor.id },
        select: { state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual({ state: "matched", matchingEnabled: false });
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "pause-active-a:pause-after-match" } })).resolves.toMatchObject({
      recipientUserId: actor.id,
      bodyCiphertextOrBody: voice.pauseAfterMatch(),
    });
  });

  it("uses paused leave copy when a matched user pauses before leaving", async () => {
    const connection = await createOpenMatch("pause-leave-user-a", "pause-leave-user-b");
    const actor = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("pause-leave-user-a") },
    });

    await sendFake({ providerMessageKey: "pause-leave-pause", providerUserId: "pause-leave-user-a", text: "暂停" });
    await confirmLeave("pause-leave", "pause-leave-user-a");

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "left",
    });
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "pause-leave:leave-confirmed" } })).resolves.toMatchObject({
      recipientUserId: actor.id,
      bodyCiphertextOrBody: voice.leaveConfirmedPaused(),
    });

    await releaseCooldownFor("pause-leave-user-a");
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: actor.id },
        select: { state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual({ state: "paused", matchingEnabled: false });
  });

  it.each([
    { text: "打开", messageKey: "blocked-command-open" },
    { text: "继续", messageKey: "blocked-command-continue" },
    { text: "暂停", messageKey: "blocked-command-pause" },
  ])("does not let $text overwrite a user blocked after inbound lookup", async ({ text, messageKey }) => {
    const commandUser = await prisma.user.create({
      data: {
        providerUserHash: hashProviderUserId("blocked-command-user"),
        state: "available",
        matchingEnabled: true,
        reachableUntil: new Date("2026-07-01T10:00:00.000Z"),
        providerSendQuota: 999,
      },
    });
    setAfterInboundUserLoadHookForTest(async ({ userId }) => {
      await prisma.user.update({
        where: { id: userId },
        data: { state: "blocked", matchingEnabled: false, blockedAt: now },
      });
    });

    await sendFake({ providerMessageKey: messageKey, providerUserId: "blocked-command-user", text });

    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: commandUser.id },
        select: { state: true, matchingEnabled: true, blockedAt: true },
      }),
    ).resolves.toEqual({
      state: "blocked",
      matchingEnabled: false,
      blockedAt: now,
    });
    await expect(prisma.connection.count()).resolves.toBe(0);
    await expect(prisma.messageOutbox.count()).resolves.toBe(0);
  });

  it.each([
    { text: "离开", messageKey: "blocked-active-leave" },
    { text: "举报", messageKey: "blocked-active-report" },
    { text: "我还在", messageKey: "blocked-active-message" },
  ])("does not let $text create side effects when a user is blocked after inbound lookup", async ({ text, messageKey }) => {
    const connection = await createOpenMatch(`${messageKey}-user-a`, `${messageKey}-user-b`);
    const actor = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId(`${messageKey}-user-a`) },
    });
    setAfterInboundUserLoadHookForTest(async ({ userId }) => {
      await prisma.user.update({
        where: { id: userId },
        data: { state: "blocked", matchingEnabled: false, blockedAt: now },
      });
    });

    await expect(sendFake({ providerMessageKey: messageKey, providerUserId: `${messageKey}-user-a`, text })).resolves.toEqual({
      status: "processed",
    });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "active",
      closeReason: null,
      closedAt: null,
    });
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: actor.id },
        select: { state: true, matchingEnabled: true, blockedAt: true },
      }),
    ).resolves.toEqual({ state: "blocked", matchingEnabled: false, blockedAt: now });
    await expect(prisma.report.count()).resolves.toBe(0);
    await expect(prisma.pairBlock.count()).resolves.toBe(0);
    await expect(prisma.messageOutbox.findFirst({ where: { idempotencyKey: { startsWith: `${messageKey}:` } } })).resolves.toBeNull();
  });

  it("does not let an echo submit when a user is blocked after inbound lookup", async () => {
    const connection = await createOpenMatch("blocked-echo-user-a", "blocked-echo-user-b");
    const echoUser = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("blocked-echo-user-a") },
    });
    await confirmLeave("blocked-echo-leave", "blocked-echo-user-b");
    setAfterInboundUserLoadHookForTest(async ({ userId }) => {
      await prisma.user.update({
        where: { id: userId },
        data: { state: "blocked", matchingEnabled: false, blockedAt: now },
      });
    });

    await expect(sendFake({ providerMessageKey: "blocked-echo-message", providerUserId: "blocked-echo-user-a", text: "这句不该留下" })).resolves.toEqual({
      status: "processed",
    });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "left",
    });
    await expect(prisma.echo.count({ where: { fromUserId: echoUser.id } })).resolves.toBe(0);
    await expect(prisma.messageOutbox.findFirst({ where: { idempotencyKey: { startsWith: "blocked-echo-message:" } } })).resolves.toBeNull();
  });

  it("uses configured capacity limits before creating more callback matches or waiting users", async () => {
    await withEnv({ MAX_ACTIVE_CONNECTIONS: "1", MAX_WAITING_USERS: "1" }, async () => {
      await openUser("capacity-open-a", "capacity-user-a");
      await openUser("capacity-open-b", "capacity-user-b");
      await openUser("capacity-open-c", "capacity-user-c");
      await openUser("capacity-open-d", "capacity-user-d");

      await expect(prisma.connection.count({ where: { state: "active" } })).resolves.toBe(1);
      await expect(prisma.user.count({ where: { state: "waiting" } })).resolves.toBe(1);

      const rejectedUser = await prisma.user.findUniqueOrThrow({
        where: { providerUserHash: hashProviderUserId("capacity-user-d") },
      });
      expect(rejectedUser).toMatchObject({ state: "paused", matchingEnabled: false });
      await expect(prisma.rateLimitEvent.findFirstOrThrow({ where: { userId: rejectedUser.id } })).resolves.toMatchObject({
        eventType: "capacity_waiting_full",
      });
      await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "capacity-open-d:capacity-full" } })).resolves.toMatchObject({
        recipientUserId: rejectedUser.id,
        bodyCiphertextOrBody: capacityFullBody,
      });
    });
  });

  it("asks for confirmation before leaving an active match", async () => {
    const connection = await createOpenMatch("leave-prompt-user-a", "leave-prompt-user-b");
    const actor = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("leave-prompt-user-a") },
    });
    const peerId = connection.userAId === actor.id ? connection.userBId : connection.userAId;

    await sendFake({ providerMessageKey: "leave-prompt-a", providerUserId: "leave-prompt-user-a", text: "离开" });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "active",
      closeReason: null,
      closedAt: null,
    });
    await expect(prisma.pairBlock.count()).resolves.toBe(0);
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "leave-prompt-a:leave-prompt" } })).resolves.toMatchObject({
      connectionId: connection.id,
      recipientUserId: actor.id,
      bodyCiphertextOrBody: voice.leaveConfirmPrompt(),
    });

    await sendFake({ providerMessageKey: "leave-prompt-message", providerUserId: "leave-prompt-user-a", text: "我还在" });

    const relay = await prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "leave-prompt-message:relay" } });
    expect(relay).toMatchObject({ connectionId: connection.id, recipientUserId: peerId });
    expect(decodeOutboxBody(relay.bodyCiphertextOrBody ?? "")).toEqual({ encrypted: true, body: "我还在" });
  });

  it("handles leave without blocking future matches after cooldown release", async () => {
    const firstConnection = await createOpenMatch("leave-user-a", "leave-user-b");
    const leavingUser = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("leave-user-a") },
    });
    const otherUserId = firstConnection.userAId === leavingUser.id ? firstConnection.userBId : firstConnection.userAId;

    await confirmLeave("leave-a", "leave-user-a");

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: firstConnection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "left",
    });
    await expect(prisma.pairBlock.count()).resolves.toBe(1);
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "leave-a:leave-confirmed" } })).resolves.toMatchObject({
      connectionId: firstConnection.id,
      recipientUserId: leavingUser.id,
      bodyCiphertextOrBody: voice.leaveConfirmed(),
    });
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "leave-a:peer-left" } })).resolves.toMatchObject({
      connectionId: firstConnection.id,
      recipientUserId: otherUserId,
      bodyCiphertextOrBody: partnerLeftBody,
    });

    await openUser("leave-open-c", "leave-user-c");
    await openUser("leave-reopen-cooling-down-a", "leave-user-a");
    await expect(prisma.connection.count({ where: { state: "active" } })).resolves.toBe(0);
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "leave-reopen-cooling-down-a:cooldown" } })).resolves.toMatchObject({
      recipientUserId: leavingUser.id,
      bodyCiphertextOrBody: cooldownActiveBody,
    });

    await releaseCooldownFor("leave-user-a");

    const activeConnection = await prisma.connection.findFirstOrThrow({
      where: { state: "active" },
      orderBy: { startedAt: "desc" },
    });
    const reopenedUser = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("leave-user-a") },
    });
    const waitingUser = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("leave-user-c") },
    });
    const participants = [activeConnection.userAId, activeConnection.userBId];
    expect(participants).toContain(waitingUser.id);
    expect(new Set(participants)).not.toEqual(new Set([reopenedUser.id, otherUserId]));
  });

  it.each([
    { command: "离开", actorMessageKey: "cooldown-leave-a", reopenMessageKey: "cooldown-leave-reopen-a" },
    { command: "举报", actorMessageKey: "cooldown-report-a", reopenMessageKey: "cooldown-report-reopen-a" },
  ])("keeps a user in cooldown from bypassing with open after $command", async ({ command, actorMessageKey, reopenMessageKey }) => {
    await createOpenMatch(`${actorMessageKey}-user-a`, `${actorMessageKey}-user-b`);
    const actor = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId(`${actorMessageKey}-user-a`) },
    });

    if (command === "离开") {
      await confirmLeave(actorMessageKey, `${actorMessageKey}-user-a`);
    } else {
      await sendFake({ providerMessageKey: actorMessageKey, providerUserId: `${actorMessageKey}-user-a`, text: command });
    }
    await openUser(`${reopenMessageKey}-waiting-peer`, `${reopenMessageKey}-waiting-peer`);
    await openUser(reopenMessageKey, `${actorMessageKey}-user-a`);

    await expect(prisma.connection.count({ where: { state: "active" } })).resolves.toBe(0);
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: actor.id },
        select: { state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual({ state: "cooldown", matchingEnabled: true });
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: `${reopenMessageKey}:cooldown` } })).resolves.toMatchObject({
      recipientUserId: actor.id,
      bodyCiphertextOrBody: cooldownActiveBody,
    });
  });

  it("does not store echo after a user leaves because messages no longer reach the peer", async () => {
    const connection = await createOpenMatch("echo-callback-user-a", "echo-callback-user-b");
    const echoUser = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("echo-callback-user-a") },
    });

    await confirmLeave("echo-callback-leave", "echo-callback-user-a");
    await sendFake({ providerMessageKey: "echo-callback-message", providerUserId: "echo-callback-user-a", text: "谢谢这一小时" });

    await expect(prisma.echo.count({ where: { connectionId: connection.id, fromUserId: echoUser.id } })).resolves.toBe(0);
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "echo-callback-message:no-match" } })).resolves.toMatchObject({
      recipientUserId: echoUser.id,
      bodyCiphertextOrBody: voice.closedNoRelay(),
    });
  });

  it("does not store echo after a user reports because messages no longer reach the peer", async () => {
    const connection = await createOpenMatch("report-no-echo-user-a", "report-no-echo-user-b");
    const reporter = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("report-no-echo-user-a") },
    });

    await sendFake({ providerMessageKey: "report-no-echo", providerUserId: "report-no-echo-user-a", text: "举报" });
    await sendFake({ providerMessageKey: "report-no-echo-message", providerUserId: "report-no-echo-user-a", text: "这句不会到达" });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "reported",
    });
    await expect(prisma.echo.count({ where: { connectionId: connection.id, fromUserId: reporter.id } })).resolves.toBe(0);
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "report-no-echo-message:no-match" } })).resolves.toMatchObject({
      recipientUserId: reporter.id,
      bodyCiphertextOrBody: voice.closedNoRelay(),
    });
  });

  it("does not store echo after provider expiration because the old connection is gone", async () => {
    const connection = await createOpenMatch("provider-expired-no-echo-user-a", "provider-expired-no-echo-user-b");
    const peer = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("provider-expired-no-echo-user-b") },
    });
    await prisma.connection.update({
      where: { id: connection.id },
      data: { state: "awaiting_echo", closeReason: "provider_expired", closedAt: now },
    });
    await prisma.user.update({
      where: { id: peer.id },
      data: { state: "cooldown", matchingEnabled: true },
    });

    await sendFake({
      providerMessageKey: "provider-expired-no-echo-message",
      providerUserId: "provider-expired-no-echo-user-b",
      text: "还在吗",
    });

    await expect(prisma.echo.count({ where: { connectionId: connection.id, fromUserId: peer.id } })).resolves.toBe(0);
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "provider-expired-no-echo-message:no-match" } })).resolves.toMatchObject({
      recipientUserId: peer.id,
      bodyCiphertextOrBody: voice.closedNoRelay(),
    });
  });

  it("relays to a new active participant instead of consuming the message as an old echo", async () => {
    const firstConnection = await createOpenMatch("echo-active-user-a", "echo-active-user-b");
    const echoUser = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("echo-active-user-a") },
    });

    await confirmLeave("echo-active-leave", "echo-active-user-a");
    await releaseCooldownFor("echo-active-user-a", new Date(now.getTime() + 30_000));
    await openUser("echo-active-open-c", "echo-active-user-c");
    await openUser("echo-active-reopen-a", "echo-active-user-a");

    const activeConnection = await prisma.connection.findFirstOrThrow({
      where: { state: "active" },
      orderBy: { startedAt: "desc" },
    });
    expect([activeConnection.userAId, activeConnection.userBId]).toContain(echoUser.id);

    await sendFake({ providerMessageKey: "echo-active-message", providerUserId: "echo-active-user-a", text: "谢谢旧相遇" });

    await expect(
      prisma.echo.findUnique({
        where: {
          connectionId_fromUserId: {
            connectionId: firstConnection.id,
            fromUserId: echoUser.id,
          },
        },
      }),
    ).resolves.toBeNull();
    const relay = await prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "echo-active-message:relay" } });
    expect(relay).toMatchObject({
      connectionId: activeConnection.id,
    });
    expect(relay.bodyCiphertextOrBody).not.toContain("谢谢旧相遇");
    expect(decodeOutboxBody(relay.bodyCiphertextOrBody ?? "")).toEqual({
      body: "谢谢旧相遇",
      encrypted: true,
    });
  });

  it("handles report by recording the report and closing the active connection", async () => {
    const connection = await createOpenMatch("report-user-a", "report-user-b");
    const reporter = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("report-user-a") },
    });
    const reportedUserId = connection.userAId === reporter.id ? connection.userBId : connection.userAId;

    await sendFake({ providerMessageKey: "report-a", providerUserId: "report-user-a", text: "举报" });

    await expect(prisma.report.count()).resolves.toBe(1);
    await expect(prisma.pairBlock.count()).resolves.toBe(1);
    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "reported",
    });
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "report-a:report-confirmed" } })).resolves.toMatchObject({
      connectionId: connection.id,
      recipientUserId: reporter.id,
      bodyCiphertextOrBody: reportConfirmedBody,
    });
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "report-a:peer-ended" } })).resolves.toMatchObject({
      connectionId: connection.id,
      recipientUserId: reportedUserId,
      bodyCiphertextOrBody: peerEndedBody,
    });
  });

  it("handles report after the one-hour timeout closes the connection to awaiting echo", async () => {
    const connection = await createOpenMatch("report-timeout-user-a", "report-timeout-user-b");
    const reporter = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("report-timeout-user-a") },
    });
    const reportedUserId = connection.userAId === reporter.id ? connection.userBId : connection.userAId;
    const timeoutAt = new Date(now.getTime() + 60 * 60_000);

    await processScheduledJobs({ now: timeoutAt, limit: 10, cooldownSeconds: 60 });
    await sendFake({
      providerMessageKey: "report-after-timeout",
      providerUserId: "report-timeout-user-a",
      text: "举报",
      receivedAt: new Date(timeoutAt.getTime() + 1_000),
    });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "timeout",
      closedAt: timeoutAt,
    });
    await expect(prisma.report.findFirstOrThrow()).resolves.toMatchObject({
      connectionId: connection.id,
      reporterUserId: reporter.id,
      reportedUserId,
    });
    await expect(prisma.pairBlock.count()).resolves.toBe(1);
    await expect(prisma.messageOutbox.findUnique({ where: { idempotencyKey: "report-after-timeout:no-match" } })).resolves.toBeNull();
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "report-after-timeout:report-confirmed" } })).resolves.toMatchObject({
      connectionId: connection.id,
      recipientUserId: reporter.id,
      bodyCiphertextOrBody: reportConfirmedBody,
    });
    await expect(prisma.messageOutbox.findUnique({ where: { idempotencyKey: "report-after-timeout:peer-ended" } })).resolves.toBeNull();
  });

  it("blocks a user at the report threshold and closes their newer active connection", async () => {
    const oldConnection = await createOpenMatch("threshold-old-reporter", "threshold-reported");
    const reporter = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("threshold-old-reporter") },
    });
    const reported = await prisma.user.findUniqueOrThrow({
      where: { providerUserHash: hashProviderUserId("threshold-reported") },
    });
    const timeoutAt = new Date(now.getTime() + 60 * 60_000);
    const reportAt = new Date(timeoutAt.getTime() + 2_000);
    await processScheduledJobs({ now: timeoutAt, limit: 10, cooldownSeconds: 60 });

    const previousReporterA = await prisma.user.create({
      data: {
        providerUserHash: hashProviderUserId("threshold-previous-a"),
        state: "cooldown",
        matchingEnabled: false,
        reachableUntil: new Date(timeoutAt.getTime() + 2 * 60 * 60_000),
      },
    });
    const previousReporterB = await prisma.user.create({
      data: {
        providerUserHash: hashProviderUserId("threshold-previous-b"),
        state: "cooldown",
        matchingEnabled: false,
        reachableUntil: new Date(timeoutAt.getTime() + 2 * 60 * 60_000),
      },
    });
    await prisma.report.createMany({
      data: [
        { reporterUserId: previousReporterA.id, reportedUserId: reported.id, connectionId: oldConnection.id, reason: "reported" },
        { reporterUserId: previousReporterB.id, reportedUserId: reported.id, connectionId: oldConnection.id, reason: "reported" },
      ],
    });

    const newerPeer = await prisma.user.create({
      data: {
        providerUserHash: hashProviderUserId("threshold-new-peer"),
        state: "matched",
        matchingEnabled: false,
        reachableUntil: new Date(timeoutAt.getTime() + 2 * 60 * 60_000),
        providerSendQuota: 999,
      },
    });
    await prisma.user.update({
      where: { id: reported.id },
      data: {
        state: "matched",
        matchingEnabled: true,
        reachableUntil: new Date(timeoutAt.getTime() + 2 * 60 * 60_000),
        providerSendQuota: 999,
      },
    });
    const newerConnection = await prisma.connection.create({
      data: {
        userAId: reported.id,
        userBId: newerPeer.id,
        state: "active",
        startedAt: new Date(timeoutAt.getTime() + 1_000),
      },
    });
    await prisma.messageOutbox.create({
      data: {
        connectionId: newerConnection.id,
        recipientUserId: reported.id,
        idempotencyKey: "threshold-pending-to-blocked",
        bodyCiphertextOrBody: "must not send after block",
        nextAttemptAt: timeoutAt,
      },
    });

    await sendFake({
      providerMessageKey: "report-threshold",
      providerUserId: "threshold-old-reporter",
      text: "举报",
      receivedAt: reportAt,
    });

    await expect(prisma.user.findUniqueOrThrow({ where: { id: reported.id } })).resolves.toMatchObject({
      state: "blocked",
      matchingEnabled: false,
      blockedAt: reportAt,
    });
    await expect(prisma.connection.findUniqueOrThrow({ where: { id: oldConnection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "timeout",
    });
    await expect(prisma.connection.findUniqueOrThrow({ where: { id: newerConnection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "reported",
      closedAt: reportAt,
    });
    await expect(prisma.user.findUniqueOrThrow({ where: { id: newerPeer.id } })).resolves.toMatchObject({
      state: "cooldown",
    });
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "report-threshold:report-confirmed" } })).resolves.toMatchObject({
      connectionId: oldConnection.id,
      recipientUserId: reporter.id,
      bodyCiphertextOrBody: reportConfirmedBody,
    });
    await expect(
      prisma.messageOutbox.findUniqueOrThrow({
        where: { idempotencyKey: `report-threshold:peer-ended:blocked-peer:${newerConnection.id}` },
      }),
    ).resolves.toMatchObject({
      connectionId: newerConnection.id,
      recipientUserId: newerPeer.id,
      bodyCiphertextOrBody: peerEndedBody,
    });
    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: "threshold-pending-to-blocked" } })).resolves.toMatchObject({
      status: "failed",
      bodyCiphertextOrBody: null,
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
        processedAt: new Date(Date.now() - 10 * 60_000),
      },
    });

    await expect(handleFakeInbound(input)).resolves.toEqual({ status: "processed" });
    await expect(prisma.inboundDedupe.findUniqueOrThrow({ where: { providerMessageKey: input.providerMessageKey } })).resolves.toMatchObject({
      status: "processed",
      receivedAt: input.receivedAt,
      processedAt: input.receivedAt,
    });
  });

  it("does not reclaim a fresh processing inbound callback", async () => {
    const input = fakeInbound({
      providerMessageKey: "fresh-processing",
      providerUserId: "fresh-processing-user",
      text: "帮助",
      receivedAt: new Date("2026-01-01T10:00:00.000Z"),
    });
    const claimedAt = new Date();
    await prisma.inboundDedupe.create({
      data: {
        providerMessageKey: input.providerMessageKey,
        receivedAt: input.receivedAt,
        status: "processing",
        processedAt: claimedAt,
      },
    });

    await expect(handleFakeInbound(input)).resolves.toEqual({ status: "duplicate" });
    await expect(prisma.messageOutbox.count()).resolves.toBe(0);
    await expect(prisma.inboundDedupe.findUniqueOrThrow({ where: { providerMessageKey: input.providerMessageKey } })).resolves.toMatchObject({
      status: "processing",
      receivedAt: input.receivedAt,
      processedAt: claimedAt,
    });
  });

  it("returns 400 for invalid callback payloads and records only a safe fingerprint", async () => {
    const rawPayloadText = "do not record this raw payload text";
    const response = await postCallback(
      new Request("http://local.test/api/wechat/callback", {
        method: "POST",
        body: JSON.stringify({ providerMessageKey: "bad-payload", providerUserId: "bad-user", text: rawPayloadText }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_payload" });

    const appError = await prisma.appError.findFirstOrThrow({
      where: { source: "callback" },
    });
    expect(appError).toMatchObject({
      source: "callback",
      severity: "warn",
      fingerprint: "callback:invalid_payload",
      message: "invalid_payload",
      contextJson: { reason: "schema_validation" },
    });
    expect(JSON.stringify(appError)).not.toContain(rawPayloadText);
  });
});
