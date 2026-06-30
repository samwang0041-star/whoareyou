import type { NormalizedInboundEvent, OutboundMessage } from "../domain/types";

export type EntryQrStatus =
  | "waiting_to_scan"
  | "scan_confirming"
  | "confirmed"
  | "verification_required"
  | "expired"
  | "provider_error";

export type EntryQrResponse = {
  provider: "openclaw-weixin";
  mode: "fake" | "openclaw";
  sessionId: string;
  status: EntryQrStatus;
  expiresAt: string;
  qr: {
    imageSrc: string;
    payloadUrl: string;
  };
  statusUrl: string;
};

export type OpenClawAdapter = {
  parseInbound(requestBody: unknown): NormalizedInboundEvent;
  sendOutbound(message: OutboundMessage): Promise<void>;
  getEntryQr(origin: string): Promise<EntryQrResponse>;
};
