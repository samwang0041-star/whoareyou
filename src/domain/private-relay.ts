export type RelayInviteState =
  | "created"
  | "a_qr_issued"
  | "a_bound"
  | "b_qr_issued"
  | "connected"
  | "closed"
  | "expired";

export type RelayInviteSnapshot = {
  state: RelayInviteState;
};

export type RelayInviteEvent =
  | "a_qr_issued"
  | "a_bound"
  | "b_qr_issued"
  | "b_bound"
  | "disconnect"
  | "expire";

export type ParsedRelayCommand =
  | { kind: "disconnect" }
  | { kind: "message"; text: string };

const terminalStates = new Set<RelayInviteState>(["closed", "expired"]);

export function parseRelayCommand(input: string): ParsedRelayCommand {
  const text = input.trim();
  if (text === "/断开") return { kind: "disconnect" };
  return { kind: "message", text };
}

export function transitionRelayInvite(
  invite: RelayInviteSnapshot,
  event: RelayInviteEvent,
): RelayInviteSnapshot {
  if (terminalStates.has(invite.state)) return invite;
  if (event === "disconnect") return { state: "closed" };
  if (event === "expire") return { state: "expired" };
  if (invite.state === "created" && event === "a_qr_issued") return { state: "a_qr_issued" };
  if (invite.state === "a_qr_issued" && event === "a_bound") return { state: "a_bound" };
  if (invite.state === "a_bound" && event === "b_qr_issued") return { state: "b_qr_issued" };
  if (invite.state === "b_qr_issued" && event === "b_bound") return { state: "connected" };
  return invite;
}
