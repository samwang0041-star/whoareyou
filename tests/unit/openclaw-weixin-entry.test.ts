import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getQrStatus } from "../../app/api/qr/status/route";
import { decryptProviderCredential, encryptProviderCredential, hashProviderCredential } from "../../src/adapters/openclaw-credentials";
import { loadConfig, loadQrProviderConfig } from "../../src/config";
import { getOpenClawWeixinEntryQr, getOpenClawWeixinQrStatus } from "../../src/adapters/openclaw-weixin-entry";
import { prisma } from "../../src/storage/prisma";

const config = loadQrProviderConfig({
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/whoareyou",
  ADMIN_TOKEN: "dev-admin-token",
  PROVIDER_MODE: "openclaw",
  OPENCLAW_WEIXIN_API_BASE_URL: "https://ilinkai.weixin.qq.com",
  OPENCLAW_WEIXIN_BOT_TYPE: "3",
  OPENCLAW_QR_TTL_SECONDS: "300",
  OPENCLAW_QR_REQUEST_TIMEOUT_MS: "15000",
  OPENCLAW_QR_STATUS_TIMEOUT_MS: "5000",
  PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: "test-provider-credential-encryption-secret",
});

describe("openclaw weixin entry", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await prisma.appError.deleteMany();
    await prisma.openClawBotSession.deleteMany();
  });

  it("fetches a real Weixin QR payload shape and renders it for display", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          qrcode: "wechat-qr-session",
          qrcode_img_content: "https://liteapp.weixin.qq.com/q/example?qrcode=wechat-qr-session&bot_type=3",
          ret: 0,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const qr = await getOpenClawWeixinEntryQr("http://localhost:3000", config);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        href: "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3",
      }),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "iLink-App-ClientVersion": "132102",
        }),
        body: JSON.stringify({ local_token_list: [] }),
      }),
    );
    expectRandomWechatUin(fetchMock, 0);
    expect(qr).toMatchObject({
      provider: "openclaw-weixin",
      mode: "openclaw",
      status: "waiting_to_scan",
    });
    expect(qr.sessionId).toEqual(expect.any(String));
    expect(qr.sessionId).not.toBe("wechat-qr-session");
    expect(qr.qr.payloadUrl).toContain("https://liteapp.weixin.qq.com/q/example");
    expect(qr.qr.imageSrc).toMatch(/^data:image\/png;base64,/);
    expect(qr.statusUrl).toContain("mode=openclaw");
    expect(qr.statusUrl).toContain(`sessionId=${qr.sessionId}`);
    const session = await prisma.openClawBotSession.findUniqueOrThrow({ where: { qrcode: qr.sessionId } });
    expect(JSON.stringify(session)).not.toContain("wechat-qr-session");
    expect(decryptProviderCredential(session.providerQrcodeCiphertext, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)).toBe(
      "wechat-qr-session",
    );
    expect(session.providerQrcodeHash).toBe(hashProviderCredential("wechat-qr-session", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET));
  });

  it("requires a credential encryption secret for openclaw mode config", () => {
    const baseEnv = {
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/whoareyou",
      ADMIN_TOKEN: "dev-admin-token",
      PROVIDER_USER_HASH_SECRET: "dev-provider-user-hash-secret",
      PROVIDER_MODE: "openclaw",
      OPENCLAW_WEIXIN_API_BASE_URL: "https://ilinkai.weixin.qq.com",
    };

    expect(() => loadQrProviderConfig(baseEnv)).toThrow("PROVIDER_CREDENTIAL_ENCRYPTION_SECRET");
    expect(() =>
      loadQrProviderConfig({
        ...baseEnv,
        NODE_ENV: "production",
        PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: "whoareyou-dev-provider-credential-encryption-secret",
      }),
    ).toThrow("PROVIDER_CREDENTIAL_ENCRYPTION_SECRET must not use the development secret");
  });

  it("rejects public development secrets when the app runs in openclaw mode", () => {
    const baseEnv = {
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/whoareyou",
      PROVIDER_MODE: "openclaw",
      OPENCLAW_WEIXIN_API_BASE_URL: "https://ilinkai.weixin.qq.com",
      PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: "test-provider-credential-encryption-secret",
    };

    expect(() =>
      loadConfig({
        ...baseEnv,
        ADMIN_TOKEN: "dev-admin-token",
        PROVIDER_USER_HASH_SECRET: "test-provider-user-hash-secret",
      }),
    ).toThrow("ADMIN_TOKEN must not use the development secret");
    expect(() =>
      loadConfig({
        ...baseEnv,
        ADMIN_TOKEN: "strong-admin-token",
        PROVIDER_USER_HASH_SECRET: "dev-provider-user-hash-secret",
      }),
    ).toThrow("PROVIDER_USER_HASH_SECRET must not use the development secret");
  });

  it("does not silently fall back to fake provider in production", () => {
    const productionEnv = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/whoareyou",
      ADMIN_TOKEN: "strong-admin-token",
      PROVIDER_USER_HASH_SECRET: "test-provider-user-hash-secret",
    };

    expect(() => loadConfig(productionEnv)).toThrow("PROVIDER_MODE must be openclaw in production");
    expect(() => loadQrProviderConfig(productionEnv)).toThrow("PROVIDER_MODE must be openclaw in production");
    expect(() =>
      loadQrProviderConfig({
        ...productionEnv,
        ALLOW_FAKE_PROVIDER: "1",
      }),
    ).not.toThrow();
  });

  it("maps Weixin scan status into the app status contract", async () => {
    const cases = [
      ["scaned", "scan_confirming"],
      ["scaned_but_redirect", "scan_confirming"],
      ["confirmed", "confirmed"],
      ["binded_redirect", "confirmed"],
      ["need_verifycode", "verification_required"],
      ["verify_code_blocked", "verification_required"],
    ] as const;

    for (const [providerStatus, appStatus] of cases) {
      await createQrSession("wechat-qr-session");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(
            JSON.stringify({
              status: providerStatus,
              bot_token: appStatus === "confirmed" ? "raw-bot-token" : undefined,
            }),
            { status: 200 },
          ),
        ),
      );

      await expect(
        getOpenClawWeixinQrStatus({
          sessionId: "wechat-qr-session",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          config,
        }),
      ).resolves.toMatchObject({
        sessionId: "wechat-qr-session",
        status: appStatus,
        sourceStatus: providerStatus,
      });
    }
  });

  it("persists encrypted credentials when Weixin QR status is confirmed", async () => {
    await createQrSession("wechat-qr-session");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            status: "confirmed",
            bot_token: "raw-bot-token",
            ilink_bot_id: "bot-123",
            baseurl: "https://confirmed.weixin.qq.com",
            ilink_user_id: "uin-123",
            get_updates_buf: "cursor-123",
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      getOpenClawWeixinQrStatus({
        sessionId: "wechat-qr-session",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        config,
      }),
    ).resolves.toMatchObject({
      sessionId: "wechat-qr-session",
      status: "confirmed",
      sourceStatus: "confirmed",
    });

    const session = await prisma.openClawBotSession.findUniqueOrThrow({
      where: { qrcode: "wechat-qr-session" },
    });
    expect(session).toMatchObject({
      qrcode: "wechat-qr-session",
      status: "confirmed",
      baseUrl: "https://confirmed.weixin.qq.com",
      ilinkBotHash: hashProviderCredential("bot-123", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
      ilinkUserHash: hashProviderCredential("uin-123", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
    });
    expect(JSON.stringify(session)).not.toContain("bot-123");
    expect(JSON.stringify(session)).not.toContain("uin-123");
    expect(JSON.stringify(session)).not.toContain("cursor-123");
    expect(decryptProviderCredential(session.ilinkBotId, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)).toBe("bot-123");
    expect(decryptProviderCredential(session.ilinkUserId, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)).toBe("uin-123");
    expect(decryptProviderCredential(session.getUpdatesBuf, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)).toBe("cursor-123");
    expect(session.botTokenCiphertext).toBeTruthy();
    expect(session.botTokenCiphertext).not.toContain("raw-bot-token");
    expect(decryptProviderCredential(session.botTokenCiphertext, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)).toBe(
      "raw-bot-token",
    );
  });

  it("does not return confirmed when provider confirms without a usable bot token", async () => {
    await prisma.openClawBotSession.create({
      data: {
        qrcode: "wechat-qr-session",
        status: "waiting_to_scan",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            status: "confirmed",
            ilink_bot_id: "bot-123",
            baseurl: "https://confirmed.weixin.qq.com",
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      getOpenClawWeixinQrStatus({
        sessionId: "wechat-qr-session",
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        config,
      }),
    ).rejects.toThrow("openclaw_qr_confirmed_missing_credentials");

    await expect(
      prisma.openClawBotSession.findUniqueOrThrow({
        where: { qrcode: "wechat-qr-session" },
        select: { status: true, botTokenCiphertext: true, providerError: true },
      }),
    ).resolves.toEqual({
      status: "provider_error",
      botTokenCiphertext: null,
      providerError: "openclaw_qr_confirmed_missing_credentials",
    });
  });

  it("reuses a matching confirmed credential when binded_redirect omits bot_token", async () => {
    await prisma.openClawBotSession.create({
      data: {
        qrcode: "previous-qr-session",
        status: "confirmed",
        botTokenCiphertext: encryptProviderCredential("reused-bot-token", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
        ilinkBotId: encryptProviderCredential("bot-123", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
        ilinkBotHash: hashProviderCredential("bot-123", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
        baseUrl: "https://previous.weixin.qq.com",
        ilinkUserId: encryptProviderCredential("uin-123", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
        ilinkUserHash: hashProviderCredential("uin-123", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
        expiresAt: new Date(Date.now() + 60_000),
        confirmedAt: new Date(Date.now() - 60_000),
      },
    });
    await createQrSession("wechat-qr-session");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            status: "binded_redirect",
            ilink_bot_id: "bot-123",
            baseurl: "https://confirmed.weixin.qq.com",
            ilink_user_id: "uin-123",
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      getOpenClawWeixinQrStatus({
        sessionId: "wechat-qr-session",
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        config,
      }),
    ).resolves.toMatchObject({
      sessionId: "wechat-qr-session",
      status: "confirmed",
      sourceStatus: "binded_redirect",
    });

    const session = await prisma.openClawBotSession.findUniqueOrThrow({
      where: { qrcode: "wechat-qr-session" },
    });
    expect(session).toMatchObject({
      status: "confirmed",
      baseUrl: "https://confirmed.weixin.qq.com",
      ilinkBotHash: hashProviderCredential("bot-123", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
      ilinkUserHash: hashProviderCredential("uin-123", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
      providerError: null,
    });
    expect(decryptProviderCredential(session.ilinkBotId, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)).toBe("bot-123");
    expect(decryptProviderCredential(session.ilinkUserId, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)).toBe("uin-123");
    expect(decryptProviderCredential(session.botTokenCiphertext, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)).toBe(
      "reused-bot-token",
    );
    await expect(
      prisma.openClawBotSession.findUniqueOrThrow({
        where: { qrcode: "previous-qr-session" },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "superseded" });
    await expect(
      prisma.openClawBotSession.count({
        where: {
          status: "confirmed",
          ilinkBotHash: hashProviderCredential("bot-123", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
          ilinkUserHash: hashProviderCredential("uin-123", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
        },
      }),
    ).resolves.toBe(1);
  });

  it("keeps binded_redirect non-confirmed when no matching credential can be reused", async () => {
    await prisma.openClawBotSession.create({
      data: {
        qrcode: "different-bot-session",
        status: "confirmed",
        botTokenCiphertext: encryptProviderCredential("wrong-bot-token", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
        ilinkBotId: encryptProviderCredential("bot-other", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
        ilinkBotHash: hashProviderCredential("bot-other", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
        ilinkUserId: encryptProviderCredential("uin-123", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
        ilinkUserHash: hashProviderCredential("uin-123", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await createQrSession("wechat-qr-session");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            status: "binded_redirect",
            ilink_bot_id: "bot-123",
            baseurl: "https://confirmed.weixin.qq.com",
            ilink_user_id: "uin-123",
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      getOpenClawWeixinQrStatus({
        sessionId: "wechat-qr-session",
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        config,
      }),
    ).resolves.toMatchObject({
      sessionId: "wechat-qr-session",
      status: "scan_confirming",
      sourceStatus: "binded_redirect",
    });

    await expect(
      prisma.openClawBotSession.findUniqueOrThrow({
        where: { qrcode: "wechat-qr-session" },
        select: {
          status: true,
          botTokenCiphertext: true,
          providerError: true,
          ilinkBotId: true,
          ilinkBotHash: true,
          ilinkUserId: true,
          ilinkUserHash: true,
        },
      }),
    ).resolves.toMatchObject({
      status: "scan_confirming",
      botTokenCiphertext: null,
      providerError: null,
      ilinkBotHash: hashProviderCredential("bot-123", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
      ilinkUserHash: hashProviderCredential("uin-123", config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
    });
    const pendingSession = await prisma.openClawBotSession.findUniqueOrThrow({ where: { qrcode: "wechat-qr-session" } });
    expect(decryptProviderCredential(pendingSession.ilinkBotId, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)).toBe("bot-123");
    expect(decryptProviderCredential(pendingSession.ilinkUserId, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)).toBe("uin-123");
    await expect(prisma.appError.count()).resolves.toBe(0);
  });

  it("uses the server-created session expiry instead of client-supplied status expiry", async () => {
    const dbExpiresAt = new Date(Date.now() + 60_000);
    await prisma.openClawBotSession.create({
      data: {
        qrcode: "wechat-qr-session",
        status: "waiting_to_scan",
        expiresAt: dbExpiresAt,
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "scaned" }), { status: 200 })));

    await expect(
      getOpenClawWeixinQrStatus({
        sessionId: "wechat-qr-session",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        config,
      }),
    ).resolves.toMatchObject({
      status: "scan_confirming",
      expiresAt: dbExpiresAt.toISOString(),
    });
  });

  it("rejects unknown QR sessions before polling the provider", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "scaned" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getOpenClawWeixinQrStatus({
        sessionId: "unknown-qr-session",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        config,
      }),
    ).rejects.toThrow("openclaw_qr_session_not_found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 from the status route for unknown OpenClaw sessions", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "scaned" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await getQrStatus(openclawStatusRequest("unknown-qr-session"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "qr_session_not_found" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists redirect hosts and uses them for later QR status polling", async () => {
    await createQrSession("wechat-qr-session");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "scaned_but_redirect",
            redirect_host: "https://redirect.weixin.qq.com",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "scaned" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await getOpenClawWeixinQrStatus({
      sessionId: "wechat-qr-session",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      config,
    });
    await expect(
      prisma.openClawBotSession.findUniqueOrThrow({ where: { qrcode: "wechat-qr-session" } }),
    ).resolves.toMatchObject({ redirectHost: "https://redirect.weixin.qq.com" });

    await getOpenClawWeixinQrStatus({
      sessionId: "wechat-qr-session",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      config,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ href: "https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=wechat-qr-session" }),
    );
    expect(fetchMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ href: "https://redirect.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=wechat-qr-session" }),
    );
  });

  it("rejects provider-supplied base URLs outside the OpenClaw allowlist", async () => {
    await createQrSession("wechat-qr-session");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            status: "confirmed",
            bot_token: "raw-bot-token",
            ilink_bot_id: "bot-123",
            baseurl: "https://attacker.example",
            ilink_user_id: "uin-123",
          }),
          { status: 200 },
        ),
      ),
    );

    const response = await getQrStatus(openclawStatusRequest());

    await expect(response.json()).resolves.toMatchObject({
      sessionId: "wechat-qr-session",
      status: "provider_error",
      retryable: true,
    });
    expect(response.status).toBe(502);
    await expect(
      prisma.openClawBotSession.findUniqueOrThrow({
        where: { qrcode: "wechat-qr-session" },
        select: { status: true, baseUrl: true, providerError: true },
      }),
    ).resolves.toEqual({
      status: "provider_error",
      baseUrl: null,
      providerError: "openclaw_provider_host_not_allowed",
    });
  });

  it("rejects persisted redirect hosts before polling them", async () => {
    await prisma.openClawBotSession.create({
      data: {
        qrcode: "wechat-qr-session",
        status: "scan_confirming",
        redirectHost: "http://127.0.0.1:8080",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "scaned" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await getQrStatus(openclawStatusRequest());

    await expect(response.json()).resolves.toMatchObject({
      sessionId: "wechat-qr-session",
      status: "provider_error",
      retryable: true,
    });
    expect(response.status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      prisma.openClawBotSession.findUniqueOrThrow({
        where: { qrcode: "wechat-qr-session" },
        select: { status: true, providerError: true },
      }),
    ).resolves.toEqual({
      status: "provider_error",
      providerError: "openclaw_provider_host_not_allowed",
    });
  });

  it("returns provider_error when the provider status endpoint is non-2xx", async () => {
    await createQrSession("wechat-qr-session");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));

    const response = await getQrStatus(openclawStatusRequest());

    await expect(response.json()).resolves.toMatchObject({
      sessionId: "wechat-qr-session",
      status: "provider_error",
      retryable: true,
    });
    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(prisma.appError.findFirstOrThrow()).resolves.toMatchObject({
      source: "openclaw-qr-status",
      message: "openclaw_qr_status_failed:502",
    });
  });

  it("keeps waiting when the provider status request times out without a state change", async () => {
    await createQrSession("wechat-qr-session");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      }),
    );

    const response = await getQrStatus(openclawStatusRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessionId: "wechat-qr-session",
      status: "waiting_to_scan",
      sourceStatus: "timeout_no_change",
    });
    await expect(
      prisma.openClawBotSession.findUniqueOrThrow({
        where: { qrcode: "wechat-qr-session" },
        select: { status: true, providerError: true },
      }),
    ).resolves.toEqual({
      status: "waiting_to_scan",
      providerError: null,
    });
    await expect(prisma.appError.count()).resolves.toBe(0);
  });

  it("returns provider_error when the provider status response is invalid JSON", async () => {
    await createQrSession("wechat-qr-session");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider-secret-errmsg-token", { status: 200 })));

    const response = await getQrStatus(openclawStatusRequest());

    await expect(response.json()).resolves.toMatchObject({
      sessionId: "wechat-qr-session",
      status: "provider_error",
      retryable: true,
    });
    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(prisma.openClawBotSession.findUniqueOrThrow({ where: { qrcode: "wechat-qr-session" } })).resolves.toMatchObject({
      status: "provider_error",
      providerError: "openclaw_qr_status_invalid_json",
    });
    await expect(prisma.appError.findFirstOrThrow()).resolves.toMatchObject({
      source: "openclaw-qr-status",
      message: "openclaw_qr_status_invalid_json",
    });
    const stored = JSON.stringify(await prisma.appError.findMany()) + JSON.stringify(await prisma.openClawBotSession.findMany());
    expect(stored).not.toContain("provider-secret-errmsg-token");
  });
});

function openclawStatusRequest(sessionId = "wechat-qr-session") {
  const url = new URL("http://localhost:3000/api/qr/status");
  url.searchParams.set("mode", "openclaw");
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("expiresAt", new Date(Date.now() + 60_000).toISOString());

  return new Request(url);
}

async function createQrSession(qrcode: string, expiresAt = new Date(Date.now() + 60_000)) {
  await prisma.openClawBotSession.upsert({
    where: { qrcode },
    create: {
      qrcode,
      status: "waiting_to_scan",
      expiresAt,
    },
    update: {
      status: "waiting_to_scan",
      expiresAt,
      providerError: null,
    },
  });
}

function expectRandomWechatUin(fetchMock: ReturnType<typeof vi.fn>, callIndex: number) {
  const call = fetchMock.mock.calls[callIndex] as unknown as [unknown, RequestInit];
  const headers = call[1].headers as Record<string, string>;
  const value = headers["X-WECHAT-UIN"];
  expect(value).toEqual(expect.any(String));
  const decoded = Buffer.from(value, "base64").toString("utf8");
  expect(decoded).toMatch(/^\d+$/);
  const numericValue = Number(decoded);
  expect(Number.isInteger(numericValue)).toBe(true);
  expect(numericValue).toBeGreaterThanOrEqual(0);
  expect(numericValue).toBeLessThanOrEqual(0xffffffff);
}
