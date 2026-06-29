import { describe, expect, it } from "vitest";
import { transitionUser } from "../../src/domain/state-machine";

describe("transitionUser", () => {
  it("opens the random entrance from paused", () => {
    expect(transitionUser({ state: "paused", matchingEnabled: false }, "open")).toEqual({
      state: "available",
      matchingEnabled: true,
    });
  });

  it("continues matching from paused", () => {
    expect(transitionUser({ state: "paused", matchingEnabled: false }, "continue")).toEqual({
      state: "available",
      matchingEnabled: true,
    });
  });

  it("pauses matching without deleting identity", () => {
    expect(transitionUser({ state: "available", matchingEnabled: true }, "pause")).toEqual({
      state: "paused",
      matchingEnabled: false,
    });
  });

  it("moves available users into matched without changing matching preference", () => {
    expect(transitionUser({ state: "available", matchingEnabled: true }, "matched")).toEqual({
      state: "matched",
      matchingEnabled: true,
    });
  });

  it("moves ended users to cooldown while keeping matching open", () => {
    expect(transitionUser({ state: "matched", matchingEnabled: true }, "connection_closed")).toEqual({
      state: "cooldown",
      matchingEnabled: true,
    });
  });

  it("returns reachable cooldown users to matching", () => {
    expect(transitionUser({ state: "cooldown", matchingEnabled: true }, "cooldown_done_reachable")).toEqual({
      state: "available",
      matchingEnabled: true,
    });
  });

  it("moves unreachable cooldown users out of matching", () => {
    expect(transitionUser({ state: "cooldown", matchingEnabled: true }, "cooldown_done_unreachable")).toEqual({
      state: "unreachable",
      matchingEnabled: false,
    });
  });

  it("moves expired reachable users to unreachable and disables matching", () => {
    expect(transitionUser({ state: "available", matchingEnabled: true }, "provider_expired")).toEqual({
      state: "unreachable",
      matchingEnabled: false,
    });
  });

  it("keeps blocked users blocked when they open matching", () => {
    expect(transitionUser({ state: "blocked", matchingEnabled: true }, "open")).toEqual({
      state: "blocked",
      matchingEnabled: false,
    });
  });

  it("keeps blocked users blocked when they continue matching", () => {
    expect(transitionUser({ state: "blocked", matchingEnabled: true }, "continue")).toEqual({
      state: "blocked",
      matchingEnabled: false,
    });
  });

  it("keeps blocked users blocked when provider reachability expires", () => {
    expect(transitionUser({ state: "blocked", matchingEnabled: true }, "provider_expired")).toEqual({
      state: "blocked",
      matchingEnabled: false,
    });
  });
});
