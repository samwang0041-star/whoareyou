import { describe, expect, it } from "vitest";
import { voice } from "../../src/domain/voice";

describe("voice", () => {
  it("uses product language instead of system language", () => {
    const copy = [
      voice.webSubtitle(),
      voice.wechatEntry(),
      voice.waiting(),
      voice.matchStarted(),
      voice.pauseConfirmed(),
      voice.pauseAfterMatch(),
      voice.minuteReminder(50),
      voice.ended(),
      voice.leaveConfirmPrompt(),
      voice.leaveConfirmed(),
      voice.leaveConfirmedPaused(),
      voice.partnerLeft(),
      voice.peerEnded(),
      voice.closedNoRelay(),
      voice.reachabilityRenewal(),
      voice.reachabilityExpired(),
      voice.help(),
      voice.helpWaiting(),
      voice.helpMatched(),
      voice.helpCooldown(),
      voice.unknown(),
    ].join("\n");

    expect(copy).toContain("扫码，遇见一个陌生人");
    expect(copy).toContain("把这个入口，留给一次不期而遇");
    expect(copy).toContain("你遇见了一个人");
    expect(copy).not.toContain("入口后面不是 AI");
    expect(copy).not.toContain("不是 AI，不是客服");
    expect(copy).not.toContain("AI 入口");
    expect(copy).not.toContain("真人相遇");
    expect(copy).not.toContain("匹配成功");
    expect(copy).not.toContain("状态已更新");
    expect(copy).not.toContain("会话已结束");
    expect(copy).not.toContain("打开」或「继续");
    expect(copy).not.toContain("发「继续」");
    expect(copy).not.toContain("留下一句回声");
    expect(voice.matchStarted()).not.toContain("举报");
    expect(voice.helpMatched()).not.toContain("举报");
  });

  it("makes the pre-match WeChat guide explicit", () => {
    expect(voice.help()).toContain("这里没有菜单选项");
    expect(voice.help()).toContain("不用回复数字");
    expect(voice.help()).toContain("先发「打开」");
    expect(voice.help()).not.toContain("离开");
    expect(voice.waitingFull()).toContain("入口已经打开");
    expect(voice.waitingFull()).toContain("不用一直发消息");
    expect(voice.waitingFull()).not.toContain("暂停");
    expect(voice.unknown()).toContain("普通消息暂时不会被转发");
    expect(voice.unknown()).not.toContain("我听见了");
    expect(voice.waitingFull()).not.toContain("你先到了一点");
  });

  it("makes manual endings explicit about not meeting again", () => {
    expect(voice.leaveConfirmed()).toContain("不会再和彼此匹配");
    expect(voice.leaveConfirmPrompt()).toContain("确认离开");
    expect(voice.leaveConfirmPrompt()).toContain("不会再和彼此匹配");
    expect(voice.leaveConfirmedPaused()).toContain("入口仍然暂停");
    expect(voice.partnerLeft()).toContain("不会再和彼此匹配");
    expect(voice.peerEnded()).toContain("不会再和彼此匹配");
    expect(voice.partnerLeft()).toContain("不会再抵达对方");
  });

  it("rounds reminder minutes into product copy", () => {
    expect(voice.minuteReminder(30)).toBe("这次相遇还剩 30 分钟。");
  });
});
