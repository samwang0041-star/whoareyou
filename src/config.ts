import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ADMIN_TOKEN: z.string().min(8),
  PROVIDER_MODE: z.enum(["fake", "openclaw"]).default("fake"),
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
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvSchema.parse(env);
}
