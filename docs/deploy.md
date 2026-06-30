# Deploy Runbook

This is the production runbook for the first deployable MVP of `你是谁 / Who Are You`.

## Architecture

Run one deployable TypeScript monolith with four runtime process roles:

```text
web                Next.js app and API routes
openclaw-updates   polls real OpenClaw/Weixin getupdates and normalizes inbound text
outbox-worker      sends queued outbound messages with retry/window checks
scheduled-worker   processes reminders, one-hour close, cooldown release, reachability renewal, and cleanup
```

PostgreSQL is the source of truth. Do not run without a managed PostgreSQL database and durable migrations.

## Required Environment

```text
DATABASE_URL=postgresql://...
ADMIN_TOKEN=<long random admin token>
PROVIDER_MODE=openclaw
PROVIDER_USER_HASH_SECRET=<long random hash secret>
PROVIDER_CREDENTIAL_ENCRYPTION_SECRET=<long random credential secret>
OPENCLAW_WEIXIN_API_BASE_URL=https://ilinkai.weixin.qq.com
OPENCLAW_WEIXIN_BOT_TYPE=3
OPENCLAW_WEIXIN_CLIENT_VERSION=2.4.6
OPENCLAW_QR_TTL_SECONDS=300
OPENCLAW_QR_REQUEST_TIMEOUT_MS=15000
OPENCLAW_QR_STATUS_TIMEOUT_MS=8000
OPENCLAW_GETUPDATES_TIMEOUT_MS=35000
OPENCLAW_SEND_TIMEOUT_MS=15000
PROVIDER_REPLY_WINDOW_HOURS=24
PROVIDER_SEND_QUOTA_AFTER_USER_MESSAGE=999
REACHABILITY_RENEWAL_PROMPT_BEFORE_MINUTES=60
MIN_REACHABLE_MINUTES_TO_MATCH=70
MAX_ACTIVE_CONNECTIONS=5
MAX_WAITING_USERS=20
MATCH_CANDIDATE_SCAN_LIMIT=50
COOLDOWN_SECONDS=60
OUTBOX_BODY_TTL_SECONDS=900
OUTBOX_BODY_MAX_PENDING_SECONDS=3600
OUTBOX_MAX_RETRIES=3
OUTBOX_STALE_RECOVERY_BATCH_SIZE=50
SCHEDULED_JOB_BATCH_SIZE=50
OPENCLAW_UPDATES_BATCH_SIZE=1
OPERATIONAL_JOB_INTERVAL_SECONDS=60
WORKER_HEARTBEAT_STALE_SECONDS=60
WORKER_POLL_INTERVAL_MS=5000
ENTITY_CLEANUP_INTERVAL_SECONDS=21600
ENTITY_CLEANUP_SESSION_RETENTION_HOURS=24
ENTITY_CLEANUP_INBOUND_DEDUPE_RETENTION_HOURS=168
ENTITY_CLEANUP_APP_ERROR_RETENTION_HOURS=720
ENTITY_CLEANUP_RATE_LIMIT_RETENTION_HOURS=168
ADMIN_LOGIN_MAX_FAILS=5
ADMIN_LOGIN_LOCK_MS=900000
ADMIN_LOGIN_FAILURE_MAX_RECORDS=1000
ADMIN_ALLOWED_IPS=
RATE_LIMIT_QR_PER_WINDOW=1
RATE_LIMIT_QR_WINDOW_MS=10000
RATE_LIMIT_QR_STATUS_PER_WINDOW=30
RATE_LIMIT_QR_STATUS_WINDOW_MS=10000
OPENCLAW_QR_STATUS_ERROR_BACKOFF_MS=10000
RATE_LIMIT_FAKE_CALLBACK_PER_WINDOW=10
RATE_LIMIT_FAKE_CALLBACK_WINDOW_MS=60000
FAKE_CALLBACK_MAX_BODY_BYTES=16384
```

Use strong non-default secrets in production. `ADMIN_TOKEN`, `PROVIDER_USER_HASH_SECRET`, and `PROVIDER_CREDENTIAL_ENCRYPTION_SECRET` must be separate values. Production must run with `PROVIDER_MODE=openclaw`; `PROVIDER_MODE=fake` is blocked in production, and `ALLOW_FAKE_PROVIDER` must not be set in production at all. `PROVIDER_MODE=openclaw` refuses to start without explicit provider secrets, and must not use the development secrets from `.env.example`. Never expose `ADMIN_TOKEN` to the browser except by typing it into the private admin pages. In production `ADMIN_TOKEN` must be at least 32 characters; the app refuses to start with a shorter token under `NODE_ENV=production`.

The scheduled worker self-seeds recurring `outbox_body_cleanup`, `metric_snapshot`, and `entity_cleanup` jobs. `entity_cleanup` runs on a separate cadence controlled by `ENTITY_CLEANUP_INTERVAL_SECONDS` (default 6 hours) and prunes expired/superseded OpenClaw bot sessions, old inbound dedupe rows, resolved app errors, and old rate-limit events so tables stay bounded. Each retention window is configurable and defaults to a safe value (sessions 24h, inbound dedupe and rate-limit events 7d, resolved app errors 30d).

### Public Endpoint Rate Limiting

`/api/qr`, `/api/qr/status`, and (in fake mode) `/api/wechat/callback` are rate-limited in-process by client IP. Defaults are tuned for a single-replica MVP (`/api/qr`: 1 request per 10s, `/api/qr/status`: 30 per 10s, fake callback: 10 per 60s) and overridable via the `RATE_LIMIT_*` env vars. QR status provider errors also use `OPENCLAW_QR_STATUS_ERROR_BACKOFF_MS` so repeated polling does not keep hitting OpenClaw during a short error window. Fake callback bodies are capped by `FAKE_CALLBACK_MAX_BODY_BYTES`. The limiter is per-process; multi-replica deployments must replace it with a shared store and should still put a reverse-proxy `limit_req` (nginx/Caddy) in front as the primary defense.

### Admin Access Control

Admin APIs use a constant-time token comparison with per-IP lockout (`ADMIN_LOGIN_MAX_FAILS` failures trigger a `ADMIN_LOGIN_LOCK_MS` cooldown, returning 429 with `Retry-After`). Failed admin-auth records are pruned and capped by `ADMIN_LOGIN_FAILURE_MAX_RECORDS` to avoid unbounded process memory growth. Set `ADMIN_ALLOWED_IPS` to a comma-separated allow-list of operator IPs as seen in `X-Real-IP` after your reverse proxy. When unset, only the token gate applies. The reverse proxy must overwrite inbound proxy headers before forwarding, for example `proxy_set_header X-Real-IP $remote_addr;` and `proxy_set_header X-Forwarded-For $remote_addr;`. Do not use `$proxy_add_x_forwarded_for` as the only application-facing IP source because it preserves spoofable client-supplied leftmost values.

## Build And Release

```bash
npm ci
DATABASE_URL="$DATABASE_URL" npx prisma generate
DATABASE_URL="$DATABASE_URL" npm run build
DATABASE_URL="$DATABASE_URL" npm run db:migrate
```

`db:migrate` runs `prisma migrate deploy` and should be the release command before starting new runtime processes.

Migration `000009_openclaw_provider_ref_privacy` intentionally aborts if `UserProviderRef` already contains rows. This MVP migration is for a fresh database or a disposable demo database only; do not apply this migration to an existing production database with provider refs. A production upgrade from `000008` would need a separate runtime backfill using `PROVIDER_USER_HASH_SECRET` and `PROVIDER_CREDENTIAL_ENCRYPTION_SECRET` before dropping legacy plaintext columns.

Before applying migration `000015_redact_legacy_openclaw_sessions`, verify no confirmed legacy OpenClaw sessions are still referenced by users:

```sql
SELECT COUNT(*)
FROM "OpenClawBotSession" s
JOIN "UserProviderRef" r ON r."botSessionId" = s."id"
WHERE s."providerQrcodeCiphertext" IS NULL
  AND s."providerQrcodeHash" IS NULL
  AND s."status" = 'confirmed';
```

The count must be `0`. If it is not, rebind or backfill those sessions before deploy; the migration intentionally aborts instead of silently expiring active user bindings.

## Process Commands

Web:

```bash
DATABASE_URL="$DATABASE_URL" PROVIDER_MODE="openclaw" ADMIN_TOKEN="$ADMIN_TOKEN" PROVIDER_USER_HASH_SECRET="$PROVIDER_USER_HASH_SECRET" PROVIDER_CREDENTIAL_ENCRYPTION_SECRET="$PROVIDER_CREDENTIAL_ENCRYPTION_SECRET" OPENCLAW_WEIXIN_API_BASE_URL="$OPENCLAW_WEIXIN_API_BASE_URL" OPENCLAW_WEIXIN_BOT_TYPE="$OPENCLAW_WEIXIN_BOT_TYPE" OPENCLAW_WEIXIN_CLIENT_VERSION="$OPENCLAW_WEIXIN_CLIENT_VERSION" npm run start
```

Outbox worker:

```bash
DATABASE_URL="$DATABASE_URL" PROVIDER_MODE="openclaw" PROVIDER_CREDENTIAL_ENCRYPTION_SECRET="$PROVIDER_CREDENTIAL_ENCRYPTION_SECRET" npm run worker:outbox:loop
```

OpenClaw updates worker, required only for `PROVIDER_MODE=openclaw`:

```bash
DATABASE_URL="$DATABASE_URL" PROVIDER_MODE="openclaw" PROVIDER_USER_HASH_SECRET="$PROVIDER_USER_HASH_SECRET" PROVIDER_CREDENTIAL_ENCRYPTION_SECRET="$PROVIDER_CREDENTIAL_ENCRYPTION_SECRET" npm run worker:openclaw-updates:loop
```

Scheduled worker:

```bash
DATABASE_URL="$DATABASE_URL" npm run worker:scheduled:loop
```

The scheduled worker self-seeds recurring `outbox_body_cleanup` and `metric_snapshot` jobs. `OPERATIONAL_JOB_INTERVAL_SECONDS` controls the next-run cadence used by this MVP worker loop.

The one-shot worker commands are also available for cron platforms:

```bash
npm run worker:outbox
npm run worker:openclaw-updates
npm run worker:scheduled
```

## Provider Entry

`PROVIDER_MODE=fake` uses `/api/wechat/callback` for local/demo payloads. This callback is not the real OpenClaw/Weixin production inbound path. Do not set `PROVIDER_MODE=fake` or `ALLOW_FAKE_PROVIDER` in production.

Real OpenClaw/Weixin mode uses:

```text
GET /api/qr                       web requests QR from get_bot_qrcode
GET /api/qr/status                web polls get_qrcode_status and persists confirmed credentials
worker:openclaw-updates:loop      polls <baseurl>/ilink/bot/getupdates
worker:outbox:loop                sends <baseurl>/ilink/bot/sendmessage
```

The fake/demo callback accepts normalized fake-testable payloads:

```json
{
  "providerMessageKey": "unique-provider-message-id",
  "providerUserId": "provider-user-id",
  "text": "打开",
  "receivedAt": "2026-06-30T10:00:00.000Z"
}
```

Real provider-specific parsing stays in `src/adapters/*` and `src/workers/openclaw-updates.ts`, not in product domain services.

## Runtime URLs

```text
/                         public ritual entry
/api/qr                   entry QR URL
/api/wechat/callback      fake/demo callback only
/admin                    private ops overview
/admin/health             service health
/admin/safety             safety metrics
/admin/connections/:id    anonymous connection detail
```

Admin pages require `ADMIN_TOKEN` and call protected APIs with `Bearer <token>`.

## Smoke Test After Deploy

1. Open `/` and click `进入`; `/api/qr` should return a QR entry and status URL.
2. In fake mode, POST two fake callback events with `text: "打开"` to `/api/wechat/callback`; a connection should become active.
3. POST a normal message from one participant; outbox should queue a relay to the other participant.
4. Open `/admin`, enter `ADMIN_TOKEN`, confirm overview counts and connection list render.
5. Click a connection detail; confirm no chat text or provider identity appears.
6. In real mode, confirm web, openclaw updates worker, outbox worker, and scheduled worker are all running and outbox backlog is not growing unexpectedly.

## Privacy And Safety Checklist

- Do not log raw provider user ids in app logs.
- Do not expose raw `UserProviderRef` values in admin APIs.
- Store `OpenClawBotSession.botTokenCiphertext` encrypted with `PROVIDER_CREDENTIAL_ENCRYPTION_SECRET`.
- Store `UserProviderRef` raw delivery refs encrypted and use `providerUserHash` for lookup/uniqueness.
- Keep stale pending/retrying outbox bodies bounded with `OUTBOX_BODY_MAX_PENDING_SECONDS`.
- Do not add profile fields to `User`.
- Do not expose `providerUserHash`, `idempotencyKey`, outbox bodies, echo bodies, or arbitrary worker metadata through admin APIs.
- Keep `ADMIN_TOKEN` private and rotate it if leaked.
- Keep `PROVIDER_REPLY_WINDOW_HOURS`, `MIN_REACHABLE_MINUTES_TO_MATCH`, and renewal prompt timing aligned with the real provider's latest rules before public launch.

## Verification Commands

```bash
DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy
DATABASE_URL="$DATABASE_URL" npx prisma generate
npm run lint
DATABASE_URL="$DATABASE_URL" npm run typecheck
DATABASE_URL="$DATABASE_URL" npm test
DATABASE_URL="$DATABASE_URL" ADMIN_TOKEN="$ADMIN_TOKEN" PROVIDER_USER_HASH_SECRET="$PROVIDER_USER_HASH_SECRET" PROVIDER_CREDENTIAL_ENCRYPTION_SECRET="$PROVIDER_CREDENTIAL_ENCRYPTION_SECRET" npm run test:e2e
DATABASE_URL="$DATABASE_URL" npm run build
```

Database-backed tests share one PostgreSQL database. Do not run separate Vitest DB test processes in parallel.
