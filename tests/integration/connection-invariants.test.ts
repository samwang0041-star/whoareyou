import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/storage/prisma";

async function createUser(providerUserHash: string) {
  return prisma.user.create({
    data: {
      providerUserHash,
      state: "available",
    },
  });
}

describe("connection invariants", () => {
  beforeEach(async () => {
    await prisma.echo.deleteMany();
    await prisma.report.deleteMany();
    await prisma.messageOutbox.deleteMany();
    await prisma.scheduledJob.deleteMany();
    await prisma.connection.deleteMany();
    await prisma.user.deleteMany();
  });

  it("allows only one active-state connection per user across both user columns", async () => {
    const userA = await createUser("connection-invariant-a");
    const userB = await createUser("connection-invariant-b");
    const userC = await createUser("connection-invariant-c");
    const userD = await createUser("connection-invariant-d");

    await expect(
      prisma.connection.create({
        data: {
          userAId: userA.id,
          userBId: userB.id,
          state: "active",
        },
      }),
    ).resolves.toMatchObject({
      userAId: userA.id,
      userBId: userB.id,
      state: "active",
    });

    await expect(
      prisma.connection.create({
        data: {
          userAId: userC.id,
          userBId: userA.id,
          state: "active",
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.connection.create({
        data: {
          userAId: userB.id,
          userBId: userD.id,
          state: "active",
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.connection.create({
        data: {
          userAId: userC.id,
          userBId: userA.id,
          state: "closed",
        },
      }),
    ).resolves.toMatchObject({
      userAId: userC.id,
      userBId: userA.id,
      state: "closed",
    });
  });

  it("allows closing an active connection before creating a new active connection for that user", async () => {
    const userA = await createUser("connection-transition-a");
    const userB = await createUser("connection-transition-b");
    const userC = await createUser("connection-transition-c");

    const connection = await prisma.connection.create({
      data: {
        userAId: userA.id,
        userBId: userB.id,
        state: "active",
      },
    });

    await expect(
      prisma.connection.update({
        where: { id: connection.id },
        data: {
          state: "closed",
          closedAt: new Date("2026-06-30T00:00:00.000Z"),
        },
      }),
    ).resolves.toMatchObject({
      id: connection.id,
      state: "closed",
    });

    await expect(
      prisma.connection.create({
        data: {
          userAId: userC.id,
          userBId: userA.id,
          state: "active",
        },
      }),
    ).resolves.toMatchObject({
      userAId: userC.id,
      userBId: userA.id,
      state: "active",
    });

    await expect(
      prisma.connection.update({
        where: { id: connection.id },
        data: { state: "active" },
      }),
    ).rejects.toThrow();
  });

  it("allows an awaiting echo connection and a new active connection for the same user", async () => {
    const userA = await createUser("connection-echo-a");
    const userB = await createUser("connection-echo-b");
    const userC = await createUser("connection-echo-c");

    await expect(
      prisma.connection.create({
        data: {
          userAId: userA.id,
          userBId: userB.id,
          state: "awaiting_echo",
        },
      }),
    ).resolves.toMatchObject({
      userAId: userA.id,
      userBId: userB.id,
      state: "awaiting_echo",
    });

    await expect(
      prisma.connection.create({
        data: {
          userAId: userC.id,
          userBId: userA.id,
          state: "active",
        },
      }),
    ).resolves.toMatchObject({
      userAId: userC.id,
      userBId: userA.id,
      state: "active",
    });
  });

  it("detects existing cross-column active-state conflicts during validation", async () => {
    const userA = await createUser("connection-preflight-a");
    const userB = await createUser("connection-preflight-b");
    const userC = await createUser("connection-preflight-c");

    try {
      await prisma.$executeRaw`
        ALTER TABLE "Connection"
        DISABLE TRIGGER "enforce_single_active_connection_per_user_trigger"
      `;

      await prisma.connection.create({
        data: {
          userAId: userA.id,
          userBId: userB.id,
          state: "active",
        },
      });

      await prisma.connection.create({
        data: {
          userAId: userC.id,
          userBId: userA.id,
          state: "ending",
        },
      });
    } finally {
      await prisma.$executeRaw`
        ALTER TABLE "Connection"
        ENABLE TRIGGER "enforce_single_active_connection_per_user_trigger"
      `;
    }

    try {
      await expect(
        prisma.$executeRaw`SELECT "validate_single_active_connection_per_user"()`,
      ).rejects.toThrow(/active-state connection/);
    } finally {
      await prisma.connection.deleteMany();
      await prisma.user.deleteMany();
    }
  });
});
