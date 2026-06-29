import type { NormalizedInboundEvent, OutboundMessage } from "../domain/types";

export type OpenClawAdapter = {
  parseInbound(requestBody: unknown): NormalizedInboundEvent;
  sendOutbound(message: OutboundMessage): Promise<void>;
  getEntryQr(): Promise<{ url: string }>;
};
