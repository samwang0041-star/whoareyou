# 你是谁 / Who Are You

一个借用微信 AI 入口，让两个真实的人短暂相遇一小时的产品实验。

This is a product experiment that uses a WeChat AI-style entry point to let two real people meet for one bounded hour.

## 为什么做这个

我们已经习惯扫码进入一个又一个 AI agent。

我们问问题，等回答，继续追问，让它帮我们写代码、整理想法、推进工作。AI 时代确实让效率变高了，但人也变得更累。五小时限制、七天 token、上下文窗口、队列、vibe coding、永远可以继续的对话，让人仿佛停不下来。

有时候，我感觉自己活成了一个服务于 AI 的碳基 AI。

「你是谁」想在这个入口里制造一次反差：你以为自己又打开了一个 agent，但这一次，入口后面不是 AI，而是另一个真实的人。

你们只有一小时。时间到了，就断开。不能无限续杯，不能把关系产品化成另一个让人停不下来的机器。因为稀缺，所以这一小时更值得被认真对待。

这个产品想表达的是：

> 在 AI 时代，不要忘记人类。

## What This Is For

We have learned to scan into one AI agent after another.

We ask, wait, refine, code, summarize, and keep going. The AI era makes us more productive, but it also makes us more tired. Five-hour caps, seven-day token windows, context budgets, queues, vibe coding loops, and conversations that can always continue make it harder to stop.

Sometimes it feels like we have become carbon-based AIs serving AI.

`Who Are You` creates a quiet reversal inside that same entry point. You think you are opening another agent, but this time there is a human being behind the entrance.

You get one hour. Then it ends. No infinite scroll, no endless session, no system trying to keep you there forever. The scarcity is the point: it asks both people to take the hour seriously.

The product thesis is simple:

> In the age of AI, do not forget the human.

## 产品形态

- 首屏极简：`你是谁`，以及“扫码，遇见一个陌生人。”
- 用户通过微信 AI / OpenClaw 入口进入。
- 服务端只保留匿名内部身份，不保存昵称、头像、手机号或明文聊天记录。
- 系统只在可匹配、未封禁、OpenClaw 可触达窗口足够的用户之间随机匹配。
- 每段相遇一小时，每 10 分钟有一次产品声音提醒。
- 任何一方可以发 `离开` 断开。
- 发 `暂停` 可以关闭后续随机匹配；发 `打开` 或 `继续` 可以重新打开。
- 断开、离开或举报后不默认关闭入口，只进入短暂冷却；如果入口仍打开，就继续等待下一次不期而遇。
- OpenClaw 入口按用户最后一次主动消息维护约 24 小时可触达窗口；到期前询问用户是否继续打开，不回复则关闭匹配入口。

## Product Shape

- A minimal landing page: `你是谁`, plus “scan to meet a stranger.”
- Users enter through the WeChat AI / OpenClaw entry point.
- The server keeps only anonymous internal identity, not nicknames, avatars, phone numbers, or readable chat history.
- Matching only happens between eligible users who are open, not blocked, and still reachable through the OpenClaw window.
- Each encounter lasts one hour, with product reminders every 10 minutes.
- Either person can send `离开` to leave.
- `暂停` closes future random matching; `打开` or `继续` opens it again.
- Ending, leaving, or reporting does not close the entrance by default. It enters a short cooldown, then waits for another unexpected encounter if still open.
- The OpenClaw entry is modeled with an approximately 24-hour reachability window from the user's last inbound message. Before it expires, the product asks whether to keep the entrance open; no reply closes matching.

## 当前 MVP

This repository now contains the deployable MVP implementation:

- Next.js App Router web entry and private admin dashboard.
- PostgreSQL + Prisma source of truth for users, connections, reports, pair blocks, outbox, jobs, errors, and metrics.
- Fake-testable OpenClaw callback route at `/api/wechat/callback`.
- QR route at `/api/qr`.
- One-hour matching, 10-minute reminders, close/echo flow, leave/report/pair-block/three-report block.
- 24-hour-style provider reachability window with renewal prompt and expiry.
- Privacy-safe admin overview, health, safety, anonymous connection list, and anonymous detail pages.
- Outbox and scheduled-job workers for database-backed retries and timed behavior.
- Unit, integration, and Playwright E2E coverage.

## Privacy Boundaries

- No raw provider user id is stored.
- No nickname, avatar, phone number, or profile field is collected.
- Provider identity is stored only as a SHA-256 hash.
- Admin anonymous IDs are derived from a keyed HMAC and do not expose provider hash prefixes.
- Outbox bodies are cleared after send/failure/expiry.
- Echo text is stored as `[redacted]`.
- Admin APIs must not return provider hashes, idempotency keys, outbox bodies, echo bodies, or arbitrary worker metadata.

## Local Development

Requirements:

- Node.js 20+
- PostgreSQL

Setup:

```bash
npm install
cp .env.example .env
DATABASE_URL='postgresql://yuriwong@localhost:5432/whoareyou' npx prisma migrate deploy
DATABASE_URL='postgresql://yuriwong@localhost:5432/whoareyou' npx prisma generate
DATABASE_URL='postgresql://yuriwong@localhost:5432/whoareyou' ADMIN_TOKEN='dev-admin-token' npm run dev
```

Open:

- Web: `http://localhost:3000`
- Admin: `http://localhost:3000/admin`

## Production Deploy

See [docs/deploy.md](docs/deploy.md).

Minimum production process model:

```text
web                npm run start
outbox-worker      npm run worker:outbox:loop
scheduled-worker   npm run worker:scheduled:loop
release/migration  npm run db:migrate
```

Build:

```bash
npm ci
DATABASE_URL='postgresql://...' npx prisma generate
DATABASE_URL='postgresql://...' ADMIN_TOKEN='...' npm run build
DATABASE_URL='postgresql://...' npm run db:migrate
```

Callback URL for the OpenClaw-style entry:

```text
https://<your-domain>/api/wechat/callback
```

Admin URL:

```text
https://<your-domain>/admin
```

## Verification

Full local verification used for this MVP:

```bash
DATABASE_URL='postgresql://yuriwong@localhost:5432/whoareyou' npx prisma migrate deploy
DATABASE_URL='postgresql://yuriwong@localhost:5432/whoareyou' npx prisma generate
npm run lint
DATABASE_URL='postgresql://yuriwong@localhost:5432/whoareyou' npm run typecheck
DATABASE_URL='postgresql://yuriwong@localhost:5432/whoareyou' npm test
DATABASE_URL='postgresql://yuriwong@localhost:5432/whoareyou' ADMIN_TOKEN='dev-admin-token' npm run test:e2e
DATABASE_URL='postgresql://yuriwong@localhost:5432/whoareyou' ADMIN_TOKEN='dev-admin-token' npm run build
```

Database-backed tests share one PostgreSQL database. Run separate Vitest processes sequentially, not in parallel.

## 不是

- 不是匿名交友软件。
- 不是公开大流量陌生人聊天室。
- 不是另一个让人停不下来的内容机器。
- 不是用 AI 冒充人，也不是用人冒充 AI。

## Not This

- Not a dating app.
- Not a public high-scale stranger chat room.
- Not another machine optimized to keep people stuck.
- Not AI pretending to be human, and not humans pretending to be AI.

## Key Documents

- [MVP implementation plan](docs/superpowers/plans/2026-06-29-whoareyou-mvp.md)
- [Admin ops dashboard spec](docs/superpowers/specs/2026-06-29-admin-ops-dashboard-design.md)
