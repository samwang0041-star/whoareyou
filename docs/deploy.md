# Deploy Runbook

This is the production runbook for the first deployable MVP of `你是谁 / Who Are You`.

## Architecture

Run one deployable TypeScript monolith with three process roles:

```text
web                Next.js app and API routes
outbox-worker      sends queued outbound messages with retry/window checks
scheduled-worker   processes reminders, one-hour close, cooldown release, reachability renewal, and cleanup
```

PostgreSQL is the source of truth. Do not run without a managed PostgreSQL database and durable migrations.

## Required Environment

```text
DATABASE_URL=postgresql://...
ADMIN_TOKEN=<long random admin token>
PROVIDER_MODE=fake
PROVIDER_REPLY_WINDOW_HOURS=24
PROVIDER_SEND_QUOTA_AFTER_USER_MESSAGE=999
REACHABILITY_RENEWAL_PROMPT_BEFORE_MINUTES=60
MIN_REACHABLE_MINUTES_TO_MATCH=70
MAX_ACTIVE_CONNECTIONS=5
MAX_WAITING_USERS=20
COOLDOWN_SECONDS=60
OUTBOX_BODY_TTL_SECONDS=900
OUTBOX_MAX_RETRIES=3
SCHEDULED_JOB_BATCH_SIZE=50
WORKER_POLL_INTERVAL_MS=5000
```

Use a strong non-default `ADMIN_TOKEN` in production. Never expose it to the browser except by typing it into the private admin pages.

## Build And Release

```bash
npm ci
DATABASE_URL="$DATABASE_URL" npx prisma generate
DATABASE_URL="$DATABASE_URL" ADMIN_TOKEN="$ADMIN_TOKEN" npm run build
DATABASE_URL="$DATABASE_URL" npm run db:migrate
```

`db:migrate` runs `prisma migrate deploy` and should be the release command before starting new runtime processes.

## Process Commands

Web:

```bash
DATABASE_URL="$DATABASE_URL" ADMIN_TOKEN="$ADMIN_TOKEN" npm run start
```

Outbox worker:

```bash
DATABASE_URL="$DATABASE_URL" npm run worker:outbox:loop
```

Scheduled worker:

```bash
DATABASE_URL="$DATABASE_URL" npm run worker:scheduled:loop
```

The one-shot worker commands are also available for cron platforms:

```bash
npm run worker:outbox
npm run worker:scheduled
```

## Provider Entry

Configure the OpenClaw-style callback URL to:

```text
https://<your-domain>/api/wechat/callback
```

The MVP callback accepts normalized fake-testable payloads:

```json
{
  "providerMessageKey": "unique-provider-message-id",
  "providerUserId": "provider-user-id",
  "text": "打开",
  "receivedAt": "2026-06-30T10:00:00.000Z"
}
```

If the actual provider sends a different shape, map it at the adapter boundary before calling the domain flow. Keep provider-specific parsing in `src/adapters/*`, not in product domain services.

## Runtime URLs

```text
/                         public ritual entry
/api/qr                   entry QR URL
/api/wechat/callback      provider callback
/admin                    private ops overview
/admin/health             service health
/admin/safety             safety metrics
/admin/connections/:id    anonymous connection detail
```

Admin pages require `ADMIN_TOKEN` and call protected APIs with `Bearer <token>`.

## Smoke Test After Deploy

1. Open `/` and click `进入`; `/api/qr` should return a callback entry URL.
2. POST two fake callback events with `text: "打开"` to `/api/wechat/callback`; a connection should become active.
3. POST a normal message from one participant; outbox should queue a relay to the other participant.
4. Open `/admin`, enter `ADMIN_TOKEN`, confirm overview counts and connection list render.
5. Click a connection detail; confirm no chat text or provider identity appears.
6. Confirm both workers are running and outbox backlog is not growing unexpectedly.

## Privacy And Safety Checklist

- Do not log raw provider user ids in app logs.
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
DATABASE_URL="$DATABASE_URL" ADMIN_TOKEN="$ADMIN_TOKEN" npm run test:e2e
DATABASE_URL="$DATABASE_URL" ADMIN_TOKEN="$ADMIN_TOKEN" npm run build
```

Database-backed tests share one PostgreSQL database. Do not run separate Vitest DB test processes in parallel.
