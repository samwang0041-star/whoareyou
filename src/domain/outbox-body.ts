import { decryptProviderCredential, encryptProviderCredential } from "../adapters/openclaw-credentials";

const encryptedOutboxBodyPrefix = "outbox:";

export type DecodedOutboxBody = {
  body: string;
  encrypted: boolean;
};

export function encryptOutboxBody(body: string, secret?: string): string {
  return `${encryptedOutboxBodyPrefix}${encryptProviderCredential(body, secret)}`;
}

export function decodeOutboxBody(value: string, secret?: string): DecodedOutboxBody {
  if (!value.startsWith(encryptedOutboxBodyPrefix)) {
    return { body: value, encrypted: false };
  }

  return {
    body: decryptProviderCredential(value.slice(encryptedOutboxBodyPrefix.length), secret),
    encrypted: true,
  };
}
