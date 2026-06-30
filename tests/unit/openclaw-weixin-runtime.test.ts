import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptProviderCredential, encryptProviderCredential, hashProviderCredential } from "../../src/adapters/openclaw-credentials";
import {
  fetchOpenClawWeixinUpdates,
  isOpenClawStaleTokenError,
  normalizeOpenClawWeixinUpdates,
  OpenClawProviderError,
  sendOpenClawWeixinMessage,
} from "../../src/adapters/openclaw-weixin-runtime";
import { hashProviderUserId } from "../../src/domain/identity";
import { prisma } from "../../src/storage/prisma";
import { processOpenClawUpdatesBatch } from "../../src/workers/openclaw-updates";
import { processOutboxBatch, sendOpenClawOutboxMessage } from "../../src/workers/outbox";

const now = new Date("2026-06-30T10:00:00.000Z");
const testCredentialKey = "test-provider-credential-key-for-fixtures";
const testProviderHashKey = "test-provider-user-hash-key";

async function cleanDatabase() {
  await prisma.workerHeartbeat.deleteMany();
  await prisma.appError.deleteMany();
  await prisma.inboundDedupe.deleteMany();
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

describe("openclaw weixin runtime contract", () => {
  beforeEach(async () => {
    vi.stubEnv("PROVIDER_USER_HASH_SECRET", testProviderHashKey);
    await cleanDatabase();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await cleanDatabase();
  });

  it("posts getupdates with bot credentials and normalizes text messages", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ret: 0,
          get_updates_buf: "next-buffer",
          msgs: [
            {
              message_id: "msg-1",
              from_user_id: "provider-user-1",
              create_time_ms: "1782813600000",
              context_token: "context-1",
              item_list: [{ type: 1, text_item: { text: "打开" } }],
            },
            {
              message_id: "msg-2",
              from_user_id: "provider-user-2",
              create_time_ms: 1782813601000,
              context_token: "context-2",
              item_list: [{ type: 2 }],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchOpenClawWeixinUpdates({
      sessionId: "qr-session",
      baseUrl: "https://bot-base.weixin.qq.com",
      botToken: "bot-token",
      ilinkUserId: "uin-123",
      getUpdatesBuf: "previous-buffer",
      timeoutMs: 5000,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ href: "https://bot-base.weixin.qq.com/ilink/bot/getupdates" }),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          AuthorizationType: "ilink_bot_token",
          Authorization: "Bearer bot-token",
          "iLink-App-Id": "bot",
          "iLink-App-ClientVersion": "132102",
        }),
      }),
    );
    expectRandomWechatUin(fetchMock, 0, "uin-123");
    expect(fetchJsonBody(fetchMock)).toEqual({
      get_updates_buf: "previous-buffer",
      base_info: {
        channel_version: "2.4.6",
        bot_agent: "OpenClaw",
      },
    });
    expect(result).toEqual({
      nextGetUpdatesBuf: "next-buffer",
      messages: [
        {
          event: {
            providerMessageKey: "openclaw-weixin:qr-session:msg-1",
            providerUserId: "provider-user-1",
            text: "打开",
            receivedAt: new Date("2026-06-30T10:00:00.000Z"),
          },
          contextToken: "context-1",
        },
      ],
    });
  });

  it("returns an empty update batch with the previous cursor when long-polling times out", async () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    const fetchMock = vi.fn(async () => {
      throw timeoutError;
    });
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchOpenClawWeixinUpdates({
        sessionId: "qr-session",
        botToken: "bot-token",
        getUpdatesBuf: "previous-buffer",
        timeoutMs: 5000,
      }),
    ).resolves.toEqual({
      nextGetUpdatesBuf: "previous-buffer",
      messages: [],
    });

    expect(timeoutSpy).toHaveBeenCalledWith(35000);
  });

  it("posts sendmessage with recipient provider ref and context token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ret: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendOpenClawWeixinMessage({
      baseUrl: "https://bot-base.weixin.qq.com",
      botToken: "bot-token",
      ilinkUserId: "uin-123",
      toUserId: "provider-user-1",
      clientId: "outbox-message-1",
      text: "hello",
      contextToken: "context-1",
      timeoutMs: 5000,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ href: "https://bot-base.weixin.qq.com/ilink/bot/sendmessage" }),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          AuthorizationType: "ilink_bot_token",
          Authorization: "Bearer bot-token",
          "iLink-App-ClientVersion": "132102",
        }),
      }),
    );
    expectRandomWechatUin(fetchMock, 0, "uin-123");
    expect(fetchJsonBody(fetchMock)).toEqual({
      msg: {
        from_user_id: "",
        to_user_id: "provider-user-1",
        client_id: "outbox-message-1",
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: "hello" } }],
        context_token: "context-1",
      },
      base_info: {
        channel_version: "2.4.6",
        bot_agent: "OpenClaw",
      },
    });
  });

  it("rejects unsafe provider base URLs before sending bot credentials", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ret: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchOpenClawWeixinUpdates({
        sessionId: "qr-session",
        baseUrl: "http://127.0.0.1:8080",
        botToken: "bot-token",
        getUpdatesBuf: "previous-buffer",
      }),
    ).rejects.toThrow("openclaw_provider_host_not_allowed");
    await expect(
      sendOpenClawWeixinMessage({
        baseUrl: "https://attacker.example",
        botToken: "bot-token",
        toUserId: "provider-user-1",
        clientId: "outbox-message-1",
        text: "hello",
      }),
    ).rejects.toThrow("openclaw_provider_host_not_allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses wrapped getupdates envelopes and rejects unknown or error shapes", () => {
    expect(
      normalizeOpenClawWeixinUpdates({
        sessionId: "qr-session",
        body: {
          msg: {
            get_updates_buf: "msg-next-buffer",
            msg_list: [
              {
                message_id: "msg-wrapped",
                from_user_id: "provider-user-wrapped",
                create_time_ms: now.getTime(),
                item_list: [{ type: 1, text_item: { text: "打开" } }],
              },
            ],
          },
        },
      }),
    ).toMatchObject({
      nextGetUpdatesBuf: "msg-next-buffer",
      messages: [
        {
          event: {
            providerMessageKey: "openclaw-weixin:qr-session:msg-wrapped",
            providerUserId: "provider-user-wrapped",
            text: "打开",
            receivedAt: now,
          },
        },
      ],
    });

    expect(
      normalizeOpenClawWeixinUpdates({
        sessionId: "qr-session",
        body: {
          data: {
            get_updates_buf: 123,
            message_list: [
              {
                message_id: "data-wrapped",
                from_user_id: "provider-user-data",
                create_time_ms: now.getTime(),
                item_list: [{ type: 1, text_item: { text: "继续" } }],
              },
            ],
          },
        },
      }).nextGetUpdatesBuf,
    ).toBe("123");

    expect(() =>
      normalizeOpenClawWeixinUpdates({
        sessionId: "qr-session",
        body: { ret: 500, errmsg: "provider failed" },
      }),
    ).toThrow("openclaw_getupdates_failed:500");
    try {
      normalizeOpenClawWeixinUpdates({
        sessionId: "qr-session",
        body: { ret: -14, errmsg: "session timeout" },
      });
      throw new Error("expected stale token error");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenClawProviderError);
      expect(isOpenClawStaleTokenError(error)).toBe(true);
    }
    expect(() => normalizeOpenClawWeixinUpdates({ sessionId: "qr-session", body: {} })).toThrow(
      "openclaw_getupdates_invalid",
    );
  });

  it("accepts empty sendmessage success and rejects wrapped provider errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ msg: { ret: 0 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { errcode: 47001, errmsg: "bad recipient" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendOpenClawWeixinMessage({
        baseUrl: "https://bot-base.weixin.qq.com",
        botToken: "bot-token",
        toUserId: "provider-user-1",
        clientId: "outbox-message-1",
        text: "hello",
      }),
    ).resolves.toBeUndefined();
    await expect(
      sendOpenClawWeixinMessage({
        baseUrl: "https://bot-base.weixin.qq.com",
        botToken: "bot-token",
        toUserId: "provider-user-1",
        clientId: "outbox-message-2",
        text: "hello",
      }),
    ).rejects.toThrow("openclaw_sendmessage_failed:47001");
    await expect(
      sendOpenClawWeixinMessage({
        baseUrl: "https://bot-base.weixin.qq.com",
        botToken: "bot-token",
        toUserId: "provider-user-1",
        clientId: "outbox-message-3",
        text: "hello",
      }),
    ).resolves.toBeUndefined();
  });

  it("uses the real sendmessage adapter from outbox when provider mode is openclaw", async () => {
    const user = await prisma.user.create({
      data: {
        providerUserHash: hashProviderUserId("provider-user-1"),
        state: "available",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T12:00:00.000Z"),
        providerSendQuota: 999,
      },
    });
    await prisma.openClawBotSession.create({
      data: {
        id: "qr-session",
        qrcode: "qr-session",
        status: "confirmed",
        ...encryptedQr("provider-qr-session"),
        botTokenCiphertext: encryptProviderCredential("bot-token", testCredentialKey),
        ilinkBotId: encryptProviderCredential("bot-123", testCredentialKey),
        ilinkBotHash: hashProviderCredential("bot-123", testCredentialKey),
        baseUrl: "https://bot-base.weixin.qq.com",
        ilinkUserId: encryptProviderCredential("uin-123", testCredentialKey),
        ilinkUserHash: hashProviderCredential("uin-123", testCredentialKey),
        expiresAt: new Date("2026-06-30T12:00:00.000Z"),
      },
    });
    await prisma.userProviderRef.create({
      data: encryptedProviderRef({
        userId: user.id,
        providerUserId: "provider-user-1",
        contextToken: "context-1",
        botSessionId: "qr-session",
      }),
    });
    await prisma.messageOutbox.create({
      data: {
        recipientUserId: user.id,
        idempotencyKey: "outbox-message-1",
        bodyCiphertextOrBody: "hello from outbox",
        nextAttemptAt: now,
      },
    });

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ret: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await withEnv(
      {
        PROVIDER_MODE: "openclaw",
        OPENCLAW_WEIXIN_API_BASE_URL: "https://ilinkai.weixin.qq.com",
        PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: testCredentialKey,
      },
      () => processOutboxBatch({ now, limit: 10 }),
    );

    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining("hello from outbox"));
    expect(fetchJsonBody(fetchMock)).toMatchObject({
      msg: {
        to_user_id: "provider-user-1",
        client_id: "outbox-message-1",
        context_token: "context-1",
        item_list: [{ type: 1, text_item: { text: "hello from outbox" } }],
      },
    });
    await expect(prisma.messageOutbox.findFirstOrThrow()).resolves.toMatchObject({
      status: "sent",
      bodyCiphertextOrBody: null,
    });
  });

  it("uses the recipient's bound bot session when sending OpenClaw outbox messages", async () => {
    const [userA, userB] = await Promise.all([
      prisma.user.create({
        data: {
          providerUserHash: hashProviderUserId("provider-user-a"),
          state: "available",
          matchingEnabled: true,
          reachableUntil: new Date("2026-06-30T12:00:00.000Z"),
          providerSendQuota: 999,
        },
      }),
      prisma.user.create({
        data: {
          providerUserHash: hashProviderUserId("provider-user-b"),
          state: "available",
          matchingEnabled: true,
          reachableUntil: new Date("2026-06-30T12:00:00.000Z"),
          providerSendQuota: 999,
        },
      }),
    ]);
    const oldSession = await prisma.openClawBotSession.create({
      data: {
        qrcode: "qr-old-session",
        status: "confirmed",
        botTokenCiphertext: encryptProviderCredential("old-token", testCredentialKey),
        baseUrl: "https://old-base.weixin.qq.com",
        ilinkUserId: encryptProviderCredential("old-uin", testCredentialKey),
        ilinkUserHash: hashProviderCredential("old-uin", testCredentialKey),
        expiresAt: new Date("2026-06-30T12:00:00.000Z"),
        updatedAt: new Date("2026-06-30T09:00:00.000Z"),
      },
    });
    const latestSession = await prisma.openClawBotSession.create({
      data: {
        qrcode: "qr-latest-session",
        status: "confirmed",
        botTokenCiphertext: encryptProviderCredential("latest-token", testCredentialKey),
        baseUrl: "https://latest-base.weixin.qq.com",
        ilinkUserId: encryptProviderCredential("latest-uin", testCredentialKey),
        ilinkUserHash: hashProviderCredential("latest-uin", testCredentialKey),
        expiresAt: new Date("2026-06-30T12:00:00.000Z"),
        updatedAt: new Date("2026-06-30T09:30:00.000Z"),
      },
    });
    await prisma.userProviderRef.createMany({
      data: [
        encryptedProviderRef({
          userId: userA.id,
          providerUserId: "provider-user-a",
          contextToken: "context-a",
          botSessionId: oldSession.id,
        }),
        encryptedProviderRef({
          userId: userB.id,
          providerUserId: "provider-user-b",
          contextToken: "context-b",
          botSessionId: latestSession.id,
        }),
      ],
    });
    await prisma.messageOutbox.create({
      data: {
        recipientUserId: userA.id,
        idempotencyKey: "outbox-bound-session",
        bodyCiphertextOrBody: "hello bound session",
        nextAttemptAt: now,
      },
    });

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ret: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await withEnv(
      {
        PROVIDER_MODE: "openclaw",
        OPENCLAW_WEIXIN_API_BASE_URL: "https://ilinkai.weixin.qq.com",
        PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: testCredentialKey,
      },
      () => processOutboxBatch({ now, limit: 10 }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ href: "https://old-base.weixin.qq.com/ilink/bot/sendmessage" }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer old-token",
        }),
      }),
    );
    expectRandomWechatUin(fetchMock, 0, "old-uin");
    expect(fetchJsonBody(fetchMock)).toMatchObject({
      msg: {
        to_user_id: "provider-user-a",
        context_token: "context-a",
      },
    });
  });

  it("polls confirmed bot sessions and stores latest provider context refs", async () => {
    const session = await prisma.openClawBotSession.create({
      data: {
        qrcode: "qr-session",
        status: "confirmed",
        ...encryptedQr("provider-qr-session"),
        botTokenCiphertext: encryptProviderCredential("bot-token", testCredentialKey),
        ilinkBotId: encryptProviderCredential("bot-123", testCredentialKey),
        ilinkBotHash: hashProviderCredential("bot-123", testCredentialKey),
        baseUrl: "https://bot-base.weixin.qq.com",
        ilinkUserId: encryptProviderCredential("uin-123", testCredentialKey),
        ilinkUserHash: hashProviderCredential("uin-123", testCredentialKey),
        getUpdatesBuf: encryptProviderCredential("previous-buffer", testCredentialKey),
        expiresAt: new Date("2026-06-30T12:00:00.000Z"),
      },
    });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ret: 0,
          get_updates_buf: "next-buffer",
          msgs: [
            {
              message_id: "msg-1",
              from_user_id: "provider-user-1",
              create_time_ms: now.getTime(),
              context_token: "context-1",
              item_list: [{ type: 1, text_item: { text: "帮助" } }],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await withEnv(
      {
        PROVIDER_MODE: "openclaw",
        PROVIDER_USER_HASH_SECRET: testProviderHashKey,
        PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: testCredentialKey,
        PROVIDER_REPLY_WINDOW_HOURS: "24",
        PROVIDER_SEND_QUOTA_AFTER_USER_MESSAGE: "999",
      },
      () => processOpenClawUpdatesBatch({ now, limit: 10 }),
    );

    const updatedSession = await prisma.openClawBotSession.findUniqueOrThrow({ where: { qrcode: "qr-session" } });
    expect(updatedSession.providerError).toBeNull();
    expect(JSON.stringify(updatedSession)).not.toContain("next-buffer");
    expect(decryptProviderCredential(updatedSession.getUpdatesBuf, testCredentialKey)).toBe("next-buffer");
    const user = await prisma.user.findUniqueOrThrow({ where: { providerUserHash: hashProviderUserId("provider-user-1") } });
    const providerRef = await prisma.userProviderRef.findUniqueOrThrow({
      where: { provider_userId: { provider: "openclaw-weixin", userId: user.id } },
    });
    expect(providerRef.providerUserHash).toBe(hashProviderUserId("provider-user-1"));
    expect(providerRef.botSessionId).toBe(session.id);
    expect(decryptProviderCredential(providerRef.providerUserIdCiphertext, testCredentialKey)).toBe("provider-user-1");
    expect(decryptProviderCredential(providerRef.latestContextTokenCiphertext, testCredentialKey)).toBe("context-1");
    expect(JSON.stringify(providerRef)).not.toContain("provider-user-1");
    expect(JSON.stringify(providerRef)).not.toContain("context-1");
    await expect(prisma.messageOutbox.findFirstOrThrow()).resolves.toMatchObject({
      recipientUserId: user.id,
      idempotencyKey: "openclaw-weixin:qr-session:msg-1:help",
    });
  });

  it("skips legacy confirmed bot sessions without encrypted QR state", async () => {
    await prisma.openClawBotSession.create({
      data: {
        qrcode: "legacy-provider-qrcode",
        status: "confirmed",
        botTokenCiphertext: encryptProviderCredential("bot-token", testCredentialKey),
        getUpdatesBuf: encryptProviderCredential("previous-buffer", testCredentialKey),
        expiresAt: new Date("2026-06-30T12:00:00.000Z"),
      },
    });
    const fetchUpdates = vi.fn(async () => ({ nextGetUpdatesBuf: "next-buffer", messages: [] }));

    const result = await withEnv(
      {
        PROVIDER_MODE: "openclaw",
        PROVIDER_USER_HASH_SECRET: testProviderHashKey,
        PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: testCredentialKey,
        PROVIDER_REPLY_WINDOW_HOURS: "24",
        PROVIDER_SEND_QUOTA_AFTER_USER_MESSAGE: "999",
      },
      () => processOpenClawUpdatesBatch({ now, limit: 10, fetchUpdates }),
    );

    expect(result).toEqual({ sessions: 0, messages: 0, failedMessages: 0, failedSessions: 0 });
    expect(fetchUpdates).not.toHaveBeenCalled();
  });

  it("fails closed when the OpenClaw updates worker starts without required secrets", async () => {
    await withEnv(
      {
        PROVIDER_MODE: "openclaw",
        PROVIDER_USER_HASH_SECRET: "",
        PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: "",
      },
      async () => {
        await expect(processOpenClawUpdatesBatch({ now, limit: 10 })).rejects.toThrow("PROVIDER_USER_HASH_SECRET");
      },
    );
  });

  it("fails closed when OpenClaw outbox send starts without a credential key", async () => {
    await withEnv(
      {
        PROVIDER_MODE: "openclaw",
        PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: "",
      },
      async () => {
        await expect(
          sendOpenClawOutboxMessage({
            recipientUserId: "recipient",
            body: "hello",
            idempotencyKey: "missing-credential-key",
          }),
        ).rejects.toThrow("PROVIDER_CREDENTIAL_ENCRYPTION_SECRET");
      },
    );
  });

  it("stores provider refs before handling inbound messages that can enqueue outbox", async () => {
    const session = await prisma.openClawBotSession.create({
      data: {
        qrcode: "qr-session",
        status: "confirmed",
        ...encryptedQr("provider-qr-session"),
        botTokenCiphertext: encryptProviderCredential("bot-token", testCredentialKey),
        ilinkBotId: encryptProviderCredential("bot-123", testCredentialKey),
        ilinkBotHash: hashProviderCredential("bot-123", testCredentialKey),
        baseUrl: "https://bot-base.weixin.qq.com",
        ilinkUserId: encryptProviderCredential("uin-123", testCredentialKey),
        ilinkUserHash: hashProviderCredential("uin-123", testCredentialKey),
        getUpdatesBuf: encryptProviderCredential("previous-buffer", testCredentialKey),
        expiresAt: new Date("2026-06-30T12:00:00.000Z"),
      },
    });

    await withEnv(
      {
        PROVIDER_MODE: "openclaw",
        PROVIDER_USER_HASH_SECRET: testProviderHashKey,
        PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: testCredentialKey,
        PROVIDER_REPLY_WINDOW_HOURS: "24",
        PROVIDER_SEND_QUOTA_AFTER_USER_MESSAGE: "999",
      },
      () =>
        processOpenClawUpdatesBatch({
          now,
          limit: 10,
          fetchUpdates: async () => ({
            nextGetUpdatesBuf: "next-buffer",
            messages: [
              {
                event: {
                  providerMessageKey: "openclaw-weixin:qr-session:msg-first",
                  providerUserId: "provider-user-first",
                  text: "打开",
                  receivedAt: now,
                },
                contextToken: "context-first",
              },
            ],
          }),
          handleInbound: async (event) => {
            const user = await prisma.user.findUniqueOrThrow({
              where: { providerUserHash: hashProviderUserId(event.providerUserId) },
            });
            await expect(
              prisma.userProviderRef.findUnique({
                where: {
                  provider_userId: {
                    provider: "openclaw-weixin",
                    userId: user.id,
                  },
                },
              }),
            ).resolves.toMatchObject({
              userId: user.id,
              botSessionId: session.id,
            });
          },
        }),
    );
  });

  it("advances the getupdates cursor when one inbound message is quarantined", async () => {
    await prisma.openClawBotSession.create({
      data: {
        qrcode: "qr-session",
        status: "confirmed",
        ...encryptedQr("provider-qr-session"),
        botTokenCiphertext: encryptProviderCredential("bot-token", testCredentialKey),
        getUpdatesBuf: encryptProviderCredential("previous-buffer", testCredentialKey),
        expiresAt: new Date("2026-06-30T12:00:00.000Z"),
      },
    });

    const handled: string[] = [];
    await withEnv(
      {
        PROVIDER_MODE: "openclaw",
        PROVIDER_USER_HASH_SECRET: testProviderHashKey,
        PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: testCredentialKey,
        PROVIDER_REPLY_WINDOW_HOURS: "24",
        PROVIDER_SEND_QUOTA_AFTER_USER_MESSAGE: "999",
      },
      () =>
        processOpenClawUpdatesBatch({
          now,
          limit: 10,
          fetchUpdates: async () => ({
            nextGetUpdatesBuf: "next-buffer",
            messages: [
              {
                event: {
                  providerMessageKey: "openclaw-weixin:qr-session:poison",
                  providerUserId: "provider-user-poison",
                  text: "打开",
                  receivedAt: now,
                },
              },
              {
                event: {
                  providerMessageKey: "openclaw-weixin:qr-session:later",
                  providerUserId: "provider-user-later",
                  text: "帮助",
                  receivedAt: now,
                },
              },
            ],
          }),
          handleInbound: async (event) => {
            if (event.providerMessageKey.endsWith(":poison")) {
              throw new Error("poison_inbound");
            }
            handled.push(event.providerMessageKey);
          },
        }),
    );

    const session = await prisma.openClawBotSession.findUniqueOrThrow({ where: { qrcode: "qr-session" } });
    expect(decryptProviderCredential(session.getUpdatesBuf, testCredentialKey)).toBe("next-buffer");
    expect(session.providerError).toBeNull();
    expect(handled).toEqual(["openclaw-weixin:qr-session:later"]);
    await expect(
      prisma.appError.findFirstOrThrow({
        where: {
          source: "openclaw-updates",
          fingerprint: "openclaw-updates:poison_inbound",
        },
      }),
    ).resolves.toMatchObject({
      severity: "error",
      message: "poison_inbound",
    });
  });

  it("keeps the previous getupdates cursor when a session poll fails", async () => {
    await prisma.openClawBotSession.create({
      data: {
        qrcode: "qr-session",
        status: "confirmed",
        ...encryptedQr("provider-qr-session"),
        botTokenCiphertext: encryptProviderCredential("bot-token", testCredentialKey),
        getUpdatesBuf: encryptProviderCredential("previous-buffer", testCredentialKey),
        expiresAt: new Date("2026-06-30T12:00:00.000Z"),
      },
    });

    await withEnv({ PROVIDER_MODE: "openclaw", PROVIDER_USER_HASH_SECRET: testProviderHashKey, PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: testCredentialKey }, () =>
      processOpenClawUpdatesBatch({
        now,
        limit: 10,
        fetchUpdates: async () => {
          throw new Error("openclaw_getupdates_invalid");
        },
      }),
    );

    const failedSession = await prisma.openClawBotSession.findUniqueOrThrow({ where: { qrcode: "qr-session" } });
    expect(decryptProviderCredential(failedSession.getUpdatesBuf, testCredentialKey)).toBe("previous-buffer");
    expect(failedSession.providerError).toBe("openclaw_getupdates_invalid");
  });

  it("expires stale OpenClaw sessions instead of accumulating active app errors", async () => {
    await prisma.openClawBotSession.create({
      data: {
        qrcode: "qr-stale-session",
        status: "confirmed",
        ...encryptedQr("provider-qr-stale-session"),
        botTokenCiphertext: encryptProviderCredential("bot-token", testCredentialKey),
        getUpdatesBuf: encryptProviderCredential("previous-buffer", testCredentialKey),
        expiresAt: new Date("2026-06-30T12:00:00.000Z"),
      },
    });
    await prisma.appError.create({
      data: {
        source: "openclaw-updates",
        severity: "error",
        fingerprint: "openclaw-updates:openclaw_getupdates_failed:-14",
        message: "openclaw_getupdates_failed:-14",
        createdAt: new Date(now.getTime() - 60_000),
      },
    });

    await withEnv({ PROVIDER_MODE: "openclaw", PROVIDER_USER_HASH_SECRET: testProviderHashKey, PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: testCredentialKey }, () =>
      processOpenClawUpdatesBatch({
        now,
        limit: 10,
        fetchUpdates: async () => {
          throw new OpenClawProviderError("openclaw_getupdates_failed", -14);
        },
      }),
    );

    await expect(prisma.openClawBotSession.findUniqueOrThrow({ where: { qrcode: "qr-stale-session" } })).resolves.toMatchObject({
      status: "expired",
      providerError: "openclaw_getupdates_failed:-14",
    });
    await expect(
      prisma.appError.count({
        where: {
          source: "openclaw-updates",
          fingerprint: "openclaw-updates:openclaw_getupdates_failed:-14",
          resolvedAt: null,
        },
      }),
    ).resolves.toBe(0);
  });
});

function fetchJsonBody(fetchMock: ReturnType<typeof vi.fn>) {
  const firstCall = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit];
  return JSON.parse(String(firstCall[1].body));
}

function expectRandomWechatUin(fetchMock: ReturnType<typeof vi.fn>, callIndex: number, previousValue: string) {
  const call = fetchMock.mock.calls[callIndex] as unknown as [unknown, RequestInit];
  const headers = call[1].headers as Record<string, string>;
  const value = headers["X-WECHAT-UIN"];
  expect(value).toEqual(expect.any(String));
  expect(value).not.toBe(previousValue);
  const decoded = Buffer.from(value, "base64").toString("utf8");
  expect(decoded).toMatch(/^\d+$/);
  const numericValue = Number(decoded);
  expect(Number.isInteger(numericValue)).toBe(true);
  expect(numericValue).toBeGreaterThanOrEqual(0);
  expect(numericValue).toBeLessThanOrEqual(0xffffffff);
}

function encryptedQr(providerQrcode: string) {
  return {
    providerQrcodeCiphertext: encryptProviderCredential(providerQrcode, testCredentialKey),
    providerQrcodeHash: hashProviderCredential(providerQrcode, testCredentialKey),
  };
}

function encryptedProviderRef(input: {
  userId: string;
  providerUserId: string;
  contextToken?: string;
  botSessionId: string;
}) {
  return {
    userId: input.userId,
    provider: "openclaw-weixin",
    providerUserHash: hashProviderUserId(input.providerUserId),
    providerUserIdCiphertext: encryptProviderCredential(input.providerUserId, testCredentialKey),
    latestContextTokenCiphertext: input.contextToken ? encryptProviderCredential(input.contextToken, testCredentialKey) : undefined,
    botSessionId: input.botSessionId,
  };
}
