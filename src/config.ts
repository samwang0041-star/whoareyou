import { z } from "zod";
import { providerCredentialDevelopmentSecret } from "./adapters/openclaw-credentials";

const adminTokenDevelopmentSecret = "dev-admin-token";
const providerUserHashDevelopmentSecrets = new Set([
  "whoareyou-dev-provider-user-hash-secret",
  "dev-provider-user-hash-secret",
]);

const BaseEnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  ADMIN_TOKEN: z.string().min(8),
  PROVIDER_USER_HASH_SECRET: z.string().min(16),
  ALLOW_FAKE_PROVIDER: z.string().optional(),
  PROVIDER_MODE: z.enum(["fake", "openclaw"]).default("fake"),
  OPENCLAW_WEIXIN_API_BASE_URL: z.string().url().default("https://ilinkai.weixin.qq.com"),
  OPENCLAW_WEIXIN_BOT_TYPE: z.string().min(1).default("3"),
  OPENCLAW_WEIXIN_CLIENT_VERSION: z.string().min(1).default("2.4.6"),
  OPENCLAW_QR_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OPENCLAW_QR_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  OPENCLAW_QR_STATUS_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  OPENCLAW_GETUPDATES_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  OPENCLAW_SEND_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: z.string().min(32).optional(),
  PROVIDER_REPLY_WINDOW_HOURS: z.coerce.number().int().positive().default(24),
  PROVIDER_SEND_QUOTA_AFTER_USER_MESSAGE: z.coerce.number().int().positive().default(999),
  REACHABILITY_RENEWAL_PROMPT_BEFORE_MINUTES: z.coerce.number().int().positive().default(60),
  MIN_REACHABLE_MINUTES_TO_MATCH: z.coerce.number().int().positive().default(70),
  MAX_ACTIVE_CONNECTIONS: z.coerce.number().int().positive().default(5),
  MAX_WAITING_USERS: z.coerce.number().int().positive().default(20),
  COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
  OUTBOX_BODY_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  OUTBOX_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  SCHEDULED_JOB_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
});

const EnvSchema = BaseEnvSchema
  .superRefine(validateFakeProvider)
  .superRefine(validateOpenClawCredentialSecret)
  .superRefine(validateOpenClawProviderUserHashSecret)
  .superRefine(validateOpenClawAdminToken);

export type AppConfig = z.infer<typeof EnvSchema>;
export type QrProviderConfig = {
  NODE_ENV?: string;
  PROVIDER_MODE: "fake" | "openclaw";
  OPENCLAW_WEIXIN_API_BASE_URL: string;
  OPENCLAW_WEIXIN_BOT_TYPE: string;
  OPENCLAW_WEIXIN_CLIENT_VERSION: string;
  OPENCLAW_QR_TTL_SECONDS: number;
  OPENCLAW_QR_REQUEST_TIMEOUT_MS: number;
  OPENCLAW_QR_STATUS_TIMEOUT_MS: number;
  PROVIDER_CREDENTIAL_ENCRYPTION_SECRET?: string;
};
export type ProviderModeConfig = {
  NODE_ENV?: string;
  PROVIDER_MODE: "fake" | "openclaw";
};
export type OpenClawUpdatesWorkerConfig = {
  NODE_ENV?: string;
  DATABASE_URL: string;
  PROVIDER_MODE: "openclaw";
  PROVIDER_USER_HASH_SECRET: string;
  PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: string;
  OPENCLAW_WEIXIN_CLIENT_VERSION: string;
  OPENCLAW_GETUPDATES_TIMEOUT_MS: number;
  PROVIDER_REPLY_WINDOW_HOURS: number;
  PROVIDER_SEND_QUOTA_AFTER_USER_MESSAGE: number;
};
export type OpenClawOutboxConfig = {
  NODE_ENV?: string;
  PROVIDER_MODE: "openclaw";
  PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: string;
  OPENCLAW_WEIXIN_API_BASE_URL: string;
  OPENCLAW_WEIXIN_CLIENT_VERSION: string;
  OPENCLAW_SEND_TIMEOUT_MS: number;
};

const QrProviderEnvSchema = BaseEnvSchema.pick({
  NODE_ENV: true,
  ALLOW_FAKE_PROVIDER: true,
  PROVIDER_MODE: true,
  OPENCLAW_WEIXIN_API_BASE_URL: true,
  OPENCLAW_WEIXIN_BOT_TYPE: true,
  OPENCLAW_WEIXIN_CLIENT_VERSION: true,
  OPENCLAW_QR_TTL_SECONDS: true,
  OPENCLAW_QR_REQUEST_TIMEOUT_MS: true,
  OPENCLAW_QR_STATUS_TIMEOUT_MS: true,
  PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: true,
})
  .superRefine(validateFakeProvider)
  .superRefine(validateOpenClawCredentialSecret);

const ProviderModeEnvSchema = BaseEnvSchema.pick({
  NODE_ENV: true,
  ALLOW_FAKE_PROVIDER: true,
  PROVIDER_MODE: true,
}).superRefine(validateFakeProvider);

const OpenClawUpdatesWorkerEnvSchema = BaseEnvSchema.pick({
  NODE_ENV: true,
  DATABASE_URL: true,
  PROVIDER_MODE: true,
  PROVIDER_USER_HASH_SECRET: true,
  PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: true,
  OPENCLAW_WEIXIN_CLIENT_VERSION: true,
  OPENCLAW_GETUPDATES_TIMEOUT_MS: true,
  PROVIDER_REPLY_WINDOW_HOURS: true,
  PROVIDER_SEND_QUOTA_AFTER_USER_MESSAGE: true,
}).extend({
  PROVIDER_MODE: z.literal("openclaw"),
})
  .superRefine(validateOpenClawCredentialSecret)
  .superRefine(validateOpenClawProviderUserHashSecret);

const OpenClawOutboxEnvSchema = BaseEnvSchema.pick({
  NODE_ENV: true,
  PROVIDER_MODE: true,
  PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: true,
  OPENCLAW_WEIXIN_API_BASE_URL: true,
  OPENCLAW_WEIXIN_CLIENT_VERSION: true,
  OPENCLAW_SEND_TIMEOUT_MS: true,
}).extend({
  PROVIDER_MODE: z.literal("openclaw"),
}).superRefine(validateOpenClawCredentialSecret);

type EnvInput = Record<string, string | undefined>;

export function loadConfig(env: EnvInput = process.env): AppConfig {
  return EnvSchema.parse(env);
}

export function loadQrProviderConfig(env: EnvInput = process.env): QrProviderConfig {
  return QrProviderEnvSchema.parse(env);
}

export function loadProviderModeConfig(env: EnvInput = process.env): ProviderModeConfig {
  return ProviderModeEnvSchema.parse(env);
}

export function loadOpenClawUpdatesWorkerConfig(env: EnvInput = process.env): OpenClawUpdatesWorkerConfig {
  const parsed = OpenClawUpdatesWorkerEnvSchema.parse(env);
  return {
    ...parsed,
    PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: requireOpenClawCredentialSecret(parsed.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
  };
}

export function loadOpenClawOutboxConfig(env: EnvInput = process.env): OpenClawOutboxConfig {
  const parsed = OpenClawOutboxEnvSchema.parse(env);
  return {
    ...parsed,
    PROVIDER_CREDENTIAL_ENCRYPTION_SECRET: requireOpenClawCredentialSecret(parsed.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
  };
}

function validateOpenClawCredentialSecret(env: {
  PROVIDER_MODE: "fake" | "openclaw";
  PROVIDER_CREDENTIAL_ENCRYPTION_SECRET?: string;
}, ctx: z.RefinementCtx) {
  if (env.PROVIDER_MODE !== "openclaw") return;

  if (!env.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET) {
    ctx.addIssue({
      code: "custom",
      path: ["PROVIDER_CREDENTIAL_ENCRYPTION_SECRET"],
      message: "PROVIDER_CREDENTIAL_ENCRYPTION_SECRET is required when PROVIDER_MODE=openclaw",
    });
    return;
  }

  if (env.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET === providerCredentialDevelopmentSecret) {
    ctx.addIssue({
      code: "custom",
      path: ["PROVIDER_CREDENTIAL_ENCRYPTION_SECRET"],
      message: "PROVIDER_CREDENTIAL_ENCRYPTION_SECRET must not use the development secret when PROVIDER_MODE=openclaw",
    });
  }
}

function validateFakeProvider(env: {
  NODE_ENV?: string;
  PROVIDER_MODE: "fake" | "openclaw";
  ALLOW_FAKE_PROVIDER?: string;
}, ctx: z.RefinementCtx) {
  if (env.NODE_ENV !== "production" || env.PROVIDER_MODE !== "fake" || env.ALLOW_FAKE_PROVIDER === "1") return;

  ctx.addIssue({
    code: "custom",
    path: ["PROVIDER_MODE"],
    message: "PROVIDER_MODE must be openclaw in production unless ALLOW_FAKE_PROVIDER=1",
  });
}

function requireOpenClawCredentialSecret(secret: string | undefined): string {
  if (!secret) throw new Error("PROVIDER_CREDENTIAL_ENCRYPTION_SECRET is required when PROVIDER_MODE=openclaw");
  return secret;
}

function validateOpenClawProviderUserHashSecret(env: {
  PROVIDER_MODE: "fake" | "openclaw";
  PROVIDER_USER_HASH_SECRET: string;
}, ctx: z.RefinementCtx) {
  if (env.PROVIDER_MODE !== "openclaw") return;

  if (providerUserHashDevelopmentSecrets.has(env.PROVIDER_USER_HASH_SECRET)) {
    ctx.addIssue({
      code: "custom",
      path: ["PROVIDER_USER_HASH_SECRET"],
      message: "PROVIDER_USER_HASH_SECRET must not use the development secret when PROVIDER_MODE=openclaw",
    });
  }
}

function validateOpenClawAdminToken(env: {
  PROVIDER_MODE: "fake" | "openclaw";
  ADMIN_TOKEN: string;
}, ctx: z.RefinementCtx) {
  if (env.PROVIDER_MODE !== "openclaw") return;

  if (env.ADMIN_TOKEN === adminTokenDevelopmentSecret) {
    ctx.addIssue({
      code: "custom",
      path: ["ADMIN_TOKEN"],
      message: "ADMIN_TOKEN must not use the development secret when PROVIDER_MODE=openclaw",
    });
  }
}
