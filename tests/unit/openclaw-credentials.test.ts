import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptProviderCredential,
  encryptProviderCredential,
  providerCredentialDevelopmentSecret,
} from "../../src/adapters/openclaw-credentials";

describe("openclaw credential encryption", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects the development credential secret in production for env and explicit call paths", () => {
    vi.stubEnv("NODE_ENV", "test");
    const ciphertext = encryptProviderCredential("bot-token", providerCredentialDevelopmentSecret);

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PROVIDER_CREDENTIAL_ENCRYPTION_SECRET", providerCredentialDevelopmentSecret);

    expect(() => encryptProviderCredential("bot-token")).toThrow(
      "PROVIDER_CREDENTIAL_ENCRYPTION_SECRET must not use the development secret in production",
    );
    expect(() => decryptProviderCredential(ciphertext)).toThrow(
      "PROVIDER_CREDENTIAL_ENCRYPTION_SECRET must not use the development secret in production",
    );
    expect(() => encryptProviderCredential("bot-token", providerCredentialDevelopmentSecret)).toThrow(
      "PROVIDER_CREDENTIAL_ENCRYPTION_SECRET must not use the development secret in production",
    );
    expect(() => decryptProviderCredential(ciphertext, providerCredentialDevelopmentSecret)).toThrow(
      "PROVIDER_CREDENTIAL_ENCRYPTION_SECRET must not use the development secret in production",
    );
  });
});
