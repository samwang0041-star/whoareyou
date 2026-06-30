import { NextResponse } from "next/server";
import type { EntryQrStatus } from "../../../../../../src/adapters/openclaw";
import {
  markRelayAConfirmed,
  markRelayBConfirmed,
} from "../../../../../../src/domain/private-relay-service";
import { prisma } from "../../../../../../src/storage/prisma";

type RouteContext = {
  params: { id: string } | Promise<{ id: string }>;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const status = await getRelayInviteWebStatus(id, new Date());
  if (!status) {
    return NextResponse.json({ error: "relay_invite_not_found" }, { status: 404 });
  }
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}

async function getRelayInviteWebStatus(inviteId: string, now: Date) {
  const invite = await prisma.relayInvite.findUnique({
    where: { id: inviteId },
    include: {
      connection: true,
    },
  });
  if (!invite) return null;
  if (invite.state === "closed") return { state: "closed" as const };
  if (invite.state === "expired" || invite.expiresAt <= now) return { state: "expired" as const };
  if (invite.state === "connected" || invite.connection?.state === "active") return { state: "connected" as const };

  if (invite.state === "a_qr_issued") {
    const aStatus = await botSessionStatus(invite.aBotSessionId);
    if (aStatus === "confirmed") {
      await markRelayAConfirmed({ inviteId, now });
      return { state: "a_bound" as const, canIssuePeerQr: true };
    }
    return { state: aStatus === "scan_confirming" ? "a_scan_confirming" : "a_waiting_to_scan" };
  }

  if (invite.state === "a_bound") {
    return { state: "a_bound" as const, canIssuePeerQr: true };
  }

  if (invite.state === "b_qr_issued") {
    const bStatus = await botSessionStatus(invite.bBotSessionId);
    if (bStatus === "confirmed") {
      await markRelayBConfirmed({ inviteId, now });
      return { state: "connected" as const };
    }
    if (bStatus === "expired") return { state: "b_qr_expired" as const };
    return { state: "waiting_for_b_scan" as const };
  }

  return { state: invite.state };
}

async function botSessionStatus(botSessionId: string | null): Promise<EntryQrStatus | "missing"> {
  if (!botSessionId) return "missing";
  const session = await prisma.openClawBotSession.findUnique({
    where: { id: botSessionId },
    select: { status: true },
  });
  if (!session) return "missing";
  if (session.status === "confirmed") return "confirmed";
  if (session.status === "scan_confirming") return "scan_confirming";
  if (session.status === "expired") return "expired";
  return "waiting_to_scan";
}
