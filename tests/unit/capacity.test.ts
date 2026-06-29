import { describe, expect, it } from "vitest";
import { decideCapacityState } from "../../src/domain/capacity";

describe("decideCapacityState", () => {
  it("allows matching when active and waiting capacity are open", () => {
    expect(decideCapacityState({ activeConnections: 0, waitingUsers: 0, maxActiveConnections: 5, maxWaitingUsers: 20 })).toBe("available");
  });

  it("moves to waiting when active capacity is full but waiting pool is open", () => {
    expect(decideCapacityState({ activeConnections: 5, waitingUsers: 0, maxActiveConnections: 5, maxWaitingUsers: 20 })).toBe("waiting");
  });

  it("keeps the user paused when both active and waiting capacity are full", () => {
    expect(decideCapacityState({ activeConnections: 5, waitingUsers: 20, maxActiveConnections: 5, maxWaitingUsers: 20 })).toBe("paused");
  });
});
