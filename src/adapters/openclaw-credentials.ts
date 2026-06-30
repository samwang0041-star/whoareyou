import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "crypto";

const credentialVersion = "v1";
export const providerCredentialDevelopmentSecret = "whoareyou-dev-provider-credential-encryption-secret";

export function encryptProviderCredential(value: string, secretInput?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", credentialKey(resolveCredentialSecret(secretInput)), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [credentialVersion, encode(iv), encode(tag), encode(ciphertext)].join(":");
}

export function decryptProviderCredential(value: string | null | undefined, secretInput?: string): string {
  if (!value) {
    throw new Error("provider_credential_missing");
  }

  const [version, iv, tag, ciphertext] = value.split(":");
  if (version !== credentialVersion || !iv || !tag || !ciphertext) {
    throw new Error("provider_credential_invalid");
  }

  const decipher = createDecipheriv("aes-256-gcm", credentialKey(resolveCredentialSecret(secretInput)), decode(iv));
  decipher.setAuthTag(decode(tag));
  return Buffer.concat([decipher.update(decode(ciphertext)), decipher.final()]).toString("utf8");
}

export function hashProviderCredential(value: string, secretInput?: string): string {
  return createHmac("sha256", credentialKey(resolveCredentialSecret(secretInput))).update(value).digest("hex");
}

function resolveCredentialSecret(secretInput?: string): string {
  const secret = secretInput ?? process.env.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET;
  if (secret) {
    if (process.env.NODE_ENV === "production" && secret === providerCredentialDevelopmentSecret) {
      throw new Error("PROVIDER_CREDENTIAL_ENCRYPTION_SECRET must not use the development secret in production");
    }
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("PROVIDER_CREDENTIAL_ENCRYPTION_SECRET is required");
  }
  return providerCredentialDevelopmentSecret;
}

function credentialKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function encode(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
