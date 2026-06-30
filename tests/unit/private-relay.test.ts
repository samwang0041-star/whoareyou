import { describe, expect, it } from "vitest";
import {
  parseRelayCommand,
  transitionRelayInvite,
  type RelayInviteSnapshot,
} from "../../src/domain/private-relay";

describe("private relay domain", () => {
  it("recognizes only slash disconnect as a command", () => {
    expect(parseRelayCommand("/断开")).toEqual({ kind: "disconnect" });
    expect(parseRelayCommand(" /断开 ")).toEqual({ kind: "disconnect" });
    expect(parseRelayCommand("断开")).toEqual({ kind: "message", text: "断开" });
    expect(parseRelayCommand("/help")).toEqual({ kind: "message", text: "/help" });
  });

  it("moves an invite through one disposable A/B relay lifecycle", () => {
    const created: RelayInviteSnapshot = { state: "created" };
    const aQrIssued = transitionRelayInvite(created, "a_qr_issued");
    const aBound = transitionRelayInvite(aQrIssued, "a_bound");
    const bQrIssued = transitionRelayInvite(aBound, "b_qr_issued");
    const connected = transitionRelayInvite(bQrIssued, "b_bound");
    const closed = transitionRelayInvite(connected, "disconnect");

    expect(aQrIssued).toEqual({ state: "a_qr_issued" });
    expect(aBound).toEqual({ state: "a_bound" });
    expect(bQrIssued).toEqual({ state: "b_qr_issued" });
    expect(connected).toEqual({ state: "connected" });
    expect(closed).toEqual({ state: "closed" });
    expect(transitionRelayInvite(closed, "b_bound")).toEqual({ state: "closed" });
    expect(transitionRelayInvite(closed, "a_bound")).toEqual({ state: "closed" });
  });

  it("expires unfinished invites and keeps expired invites terminal", () => {
    const expired = transitionRelayInvite({ state: "a_bound" }, "expire");

    expect(expired).toEqual({ state: "expired" });
    expect(transitionRelayInvite(expired, "b_qr_issued")).toEqual({ state: "expired" });
    expect(transitionRelayInvite(expired, "disconnect")).toEqual({ state: "expired" });
  });
});
