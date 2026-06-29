import { describe, expect, it } from "vitest";
import { parseCommand } from "../../src/domain/commands";

describe("parseCommand", () => {
  it("recognizes product commands", () => {
    expect(parseCommand("打开")).toEqual({ kind: "open" });
    expect(parseCommand("继续")).toEqual({ kind: "continue" });
    expect(parseCommand("暂停")).toEqual({ kind: "pause" });
    expect(parseCommand("离开")).toEqual({ kind: "leave" });
    expect(parseCommand("举报")).toEqual({ kind: "report", reason: "user_requested" });
    expect(parseCommand("帮助")).toEqual({ kind: "help" });
  });

  it("treats ordinary text as a message", () => {
    expect(parseCommand("今天你为什么会扫进来？")).toEqual({
      kind: "message",
      text: "今天你为什么会扫进来？",
    });
  });
});
