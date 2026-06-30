import { beforeEach, describe, expect, it } from "vitest";
import { getFakeEntryQr } from "../../src/adapters/fake-openclaw-entry";
import { prisma } from "../../src/storage/prisma";

describe("getFakeEntryQr", () => {
  beforeEach(async () => {
    await prisma.openClawBotSession.deleteMany();
  });

  it("returns a WeChat entry QR session", async () => {
    const qr = await getFakeEntryQr("http://localhost:3000");

    expect(qr).toMatchObject({
      provider: "openclaw-weixin",
      mode: "fake",
      status: "waiting_to_scan",
    });
    expect(qr.sessionId).toHaveLength(36);
    expect(qr.qr.imageSrc).toMatch(/^data:image\/png;base64,/);
    expect(qr.qr.payloadUrl).toContain("/api/wechat/callback?fake=1");
    expect(qr.statusUrl).toContain("/api/qr/status?sessionId=");
    await expect(prisma.openClawBotSession.findUniqueOrThrow({ where: { qrcode: qr.sessionId } })).resolves.toMatchObject({
      status: "waiting_to_scan",
    });
  });
});
