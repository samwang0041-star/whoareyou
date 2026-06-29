import { describe, expect, it } from "vitest";
import { voice } from "../../src/domain/voice";

describe("voice", () => {
  it("uses product language instead of system language", () => {
    const copy = [
      voice.webSubtitle(),
      voice.wechatEntry(),
      voice.waiting(),
      voice.matchStarted(),
      voice.minuteReminder(50),
      voice.ended(),
      voice.leaveConfirmed(),
      voice.reachabilityRenewal(),
      voice.reachabilityExpired(),
      voice.help(),
    ].join("\n");

    expect(copy).toContain("入口后面不是 AI");
    expect(copy).toContain("你遇见了一个人");
    expect(copy).not.toContain("匹配成功");
    expect(copy).not.toContain("状态已更新");
    expect(copy).not.toContain("会话已结束");
  });

  it("rounds reminder minutes into product copy", () => {
    expect(voice.minuteReminder(30)).toBe("这次相遇还剩 30 分钟。");
  });
});
