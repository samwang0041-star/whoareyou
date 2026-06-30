export type ParsedCommand =
  | { kind: "open" }
  | { kind: "continue" }
  | { kind: "pause" }
  | { kind: "leave" }
  | { kind: "confirm_leave" }
  | { kind: "report"; reason: "user_requested" }
  | { kind: "help" }
  | { kind: "message"; text: string };

export function parseCommand(input: string): ParsedCommand {
  const text = input.trim();
  if (text === "打开") return { kind: "open" };
  if (text === "继续") return { kind: "continue" };
  if (text === "暂停") return { kind: "pause" };
  if (text === "离开") return { kind: "leave" };
  if (text === "确认离开") return { kind: "confirm_leave" };
  if (text === "举报") return { kind: "report", reason: "user_requested" };
  if (text === "帮助") return { kind: "help" };
  return { kind: "message", text };
}
