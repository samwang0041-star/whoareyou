import { describe, expect, it } from "vitest";
import { transitionUser } from "../../src/domain/state-machine";

describe("transitionUser", () => {
  it("opens the random entrance from paused", () => {
    expect(transitionUser({ state: "paused", matchingEnabled: false }, "open")).toEqual({
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

  it("moves ended users to cooldown while keeping matching open", () => {
    expect(transitionUser({ state: "matched", matchingEnabled: true }, "connection_closed")).toEqual({
      state: "cooldown",
      matchingEnabled: true,
    });
  });

  it("moves expired reachable users to unreachable and disables matching", () => {
    expect(transitionUser({ state: "available", matchingEnabled: true }, "provider_expired")).toEqual({
      state: "unreachable",
      matchingEnabled: false,
    });
  });
});
