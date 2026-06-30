# UNKNOWN

<p align="center">
  <img src="public/whoareyou-main-visual.png" alt="UNKNOWN main visual" width="100%" />
</p>

<p align="center">
  <a href="#中文">中文</a> ·
  <a href="#english">English</a> ·
  <a href="https://ai.wangyuzhao.cn/">体验 UNKNOWN</a> ·
  <a href="mailto:samwang0041@gmail.com">Contact</a>
</p>

<p align="center">
  <a href="https://ai.wangyuzhao.cn/">
    <img src="public/unknown-experience-qr.png" alt="UNKNOWN experience QR code" width="180" />
  </a>
</p>

<p align="center">
  <sub>手机扫码，或在移动端长按识别，体验 UNKNOWN · Scan or long-press on mobile to try UNKNOWN</sub>
</p>

## 中文

UNKNOWN 是一个把微信里熟悉的 AI 入口，临时留给一个未知信号的小实验。

它不是匿名社交，也不是新社区。更像是一个 AI 爱好者在长期 vibe coding 之后，给自己做的一个提醒：别只和模型说话。

我们已经习惯扫码进入一个又一个 agent。问问题，等回答，继续追问，让它帮我们写代码、整理想法、推进工作。AI 时代确实让效率变高了，但人也变得更累。五小时窗口、week 窗口、token 焦虑、上下文限制、队列、永远可以继续的对话，让人仿佛停不下来。

AI 工具一天迭代 N 个版本。我们刚学会一个入口，它又换了交互；刚相信一个答案，它又更新了模型。我们像被拉去给它们做回归测试的人，反复适配、确认、重来。

UNKNOWN 借用同一个入口，但把它交还给人：你扫码，回到微信，发 `打开`。如果此刻另一个未知的人也停了下来，你们会被放进同一段一小时的对话。

没有无限续杯，没有信息流，没有让你继续沉下去的机制。只是想在 vibe coding 这么久后，真的做一个自己觉得有意思的产品。

这个网站是开源的，不保存昵称、头像、手机号或明文聊天记录。如有侵权或不适，请联系 `samwang0041@gmail.com`，我会关闭本网站。

## English

UNKNOWN is a small experiment that borrows the familiar WeChat AI entry point and leaves it, for a moment, to an unknown signal.

It is not anonymous social networking, and it is not a new community. It is closer to a small toy built by an AI hobbyist after a long stretch of vibe coding, as a reminder to stop talking only to models.

We have learned to scan into one agent after another. We ask, wait, refine, code, summarize, and keep going. The AI era makes us more productive, but also more tired. Five-hour windows, week windows, token anxiety, context limits, queues, and conversations that can always continue make it harder to stop.

AI tools iterate many times a day. As soon as we learn one entry point, the interaction changes. As soon as we trust one answer, the model changes again. We start to feel like regression testers for the tools that were supposed to help us.

UNKNOWN uses the same entrance, then gives it back to a person. Scan it, return to WeChat, and send `打开`. If another unknown person has also stopped at that moment, you get one shared hour.

No infinite session, no feed, no machine designed to keep you there. This is simply something I wanted to build because it felt personally interesting.

This site is open source. It does not store nicknames, avatars, phone numbers, or readable chat history. If anything here infringes your rights, contact `samwang0041@gmail.com` and I will close the site.

## 产品形态 / Product Shape

- 首屏以 `UNKNOWN` 和主视觉作为产品入口；体验地址：[https://ai.wangyuzhao.cn/](https://ai.wangyuzhao.cn/)。
- Users enter through the WeChat AI / OpenClaw entry point.
- 服务端只保留匿名内部身份，不保存昵称、头像、手机号或明文聊天记录。
- Matching only happens between eligible users who are open, not blocked, and still reachable through the OpenClaw window.
- 每段相遇一小时，每 10 分钟有一次产品声音提醒。
- Either person can send `离开`, then confirm before leaving.
- `暂停` closes future random matching; `打开` opens it again. Legacy entry commands remain supported for compatibility, but are not part of the product guidance.
- 断开、离开或举报后不默认关闭入口，只进入短暂冷却；离开或举报后不会再匹配到同一个人。
- The OpenClaw entry is modeled with an approximately 24-hour reachability window from the user's last inbound message. Before it expires, the product asks whether to keep the entrance open; no reply closes matching.

## 当前 MVP

This repository now contains the deployable MVP implementation:

- Next.js App Router web entry and private admin dashboard.
- PostgreSQL + Prisma source of truth for users, connections, reports, pair blocks, outbox, jobs, errors, and metrics.
- Fake-testable OpenClaw callback route at `/api/wechat/callback`.
- QR session route at `/api/qr`, returning a generated QR image, session id, status URL, and expiry.
- One-hour matching, 10-minute reminders, close/echo flow, leave/report/pair-block/three-report block.
- 24-hour-style provider reachability window with renewal prompt and expiry.
- Privacy-safe admin overview, health, safety, anonymous connection list, and anonymous detail pages.
- Outbox and scheduled-job workers for database-backed retries and timed behavior.
- Unit, integration, and Playwright E2E coverage.

## 微信二维码接入

The landing page follows a provider-neutral QR contract:

```text
GET /api/qr -> imageSrc, sessionId, statusUrl, expiresAt
GET statusUrl -> waiting_to_scan | scan_confirming | confirmed | verification_required | expired | provider_error
```

Local development uses `qrcode` to render a real, scannable fake QR payload. With `PROVIDER_MODE=openclaw`, the app calls the Weixin iLink QR endpoints directly, receives the real Weixin QR payload, and renders that payload as the displayed QR image.

Reference implementation path:

- Official channel plugin: [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
- Official docs: [OpenClaw Weixin channel](https://docs.openclaw.ai/zh-CN/channels/wechat)
- Plugin QR flow: `ilink/bot/get_bot_qrcode` returns `qrcode` and `qrcode_img_content`
- Plugin status flow: `ilink/bot/get_qrcode_status` returns statuses such as `wait`, `scaned`, `confirmed`, and `expired`

Map those provider statuses to the app contract:

```text
wait -> waiting_to_scan
scaned -> scan_confirming
scaned_but_redirect -> scan_confirming
confirmed -> confirmed
binded_redirect -> confirmed
need_verifycode -> verification_required
expired -> expired
```

Local fake mode:

```bash
PROVIDER_MODE=fake npm run dev
```

Real Weixin QR mode:

```bash
PROVIDER_MODE=openclaw npm run dev
```

In real mode, `/api/qr` calls:

```text
POST https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3
```

The response includes a Weixin QR payload hosted under `liteapp.weixin.qq.com`. The app renders that payload into the visible QR image, then `/api/qr/status` polls:

```text
GET https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=<provider qrcode held encrypted server-side>
```

When status is `confirmed`, the app stores the confirmed bot session credentials in `OpenClawBotSession`. Provider qrcode, `bot_token`, `ilink_bot_id`, `ilink_user_id`, and `get_updates_buf` are stored with AES-GCM using `PROVIDER_CREDENTIAL_ENCRYPTION_SECRET`; equality checks use keyed hashes. Do not use `ADMIN_TOKEN` or `PROVIDER_USER_HASH_SECRET` for credential encryption.

Real inbound messages do not use `/api/wechat/callback`. Run the OpenClaw updates worker:

```bash
PROVIDER_MODE=openclaw npm run worker:openclaw-updates:loop
```

The worker polls:

```text
POST <baseurl>/ilink/bot/getupdates
```

It normalizes text messages into the existing inbound domain flow, advances `get_updates_buf`, and stores encrypted delivery refs plus the producing bot session in `UserProviderRef` so the outbox worker can send:

```text
POST <baseurl>/ilink/bot/sendmessage
```

`/api/wechat/callback` is fake/demo-only for local and E2E testing.

## Privacy Boundaries

- The primary `User` row stores only a keyed HMAC-SHA-256 provider hash.
- Real provider mode stores only keyed provider-user hashes plus AES-GCM encrypted delivery refs in `UserProviderRef` (`from_user_id`, latest `context_token`) so sendmessage can address the user without keeping raw refs in cleartext.
- OpenClaw bot sessions use a local opaque session id in the browser; provider QR/session ids and cursors are encrypted at rest, with hashes only for lookup/supersession.
- No nickname, avatar, phone number, or profile field is collected.
- Matching identity uses `PROVIDER_USER_HASH_SECRET`; do not reuse `ADMIN_TOKEN` for this secret.
- Admin anonymous IDs are derived from a keyed HMAC and do not expose provider hash prefixes.
- Outbox bodies are a short-term plaintext delivery queue. They are cleared after send/failure/expiry, stale pending/retrying bodies fail and clear after `OUTBOX_BODY_MAX_PENDING_SECONDS`, and the cleanup job clears any terminal bodies left past `OUTBOX_BODY_TTL_SECONDS`.
- Echo text is stored as `[redacted]`.
- Admin APIs and logs must not return raw provider refs, provider hashes, idempotency keys, outbox bodies, echo bodies, or arbitrary worker metadata.

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
DATABASE_URL='postgresql://yuriwong@localhost:5432/whoareyou' ADMIN_TOKEN='dev-admin-token' PROVIDER_USER_HASH_SECRET='dev-provider-user-hash-secret' PROVIDER_CREDENTIAL_ENCRYPTION_SECRET='whoareyou-dev-provider-credential-encryption-secret' npm run dev
```

Open:

- Web: `http://localhost:3000`
- Admin: `http://localhost:3000/admin`

## Production Deploy

See [docs/deploy.md](docs/deploy.md).

Minimum production process model:

```text
web                npm run start
openclaw-updates   npm run worker:openclaw-updates:loop
outbox-worker      npm run worker:outbox:loop
scheduled-worker   npm run worker:scheduled:loop
release/migration  npm run db:migrate
```

Build:

```bash
npm ci
DATABASE_URL='postgresql://...' npx prisma generate
DATABASE_URL='postgresql://...' ADMIN_TOKEN='...' PROVIDER_USER_HASH_SECRET='...' PROVIDER_CREDENTIAL_ENCRYPTION_SECRET='...' npm run build
DATABASE_URL='postgresql://...' npm run db:migrate
```

In `PROVIDER_MODE=openclaw`, `/api/wechat/callback` is not part of the real provider path. The real process model is QR/status in the web process, getupdates in `worker:openclaw-updates:loop`, sendmessage in `worker:outbox:loop`, and timed jobs in `worker:scheduled:loop`.

`PROVIDER_MODE=openclaw` requires `PROVIDER_CREDENTIAL_ENCRYPTION_SECRET`. Production must not use the development secret from `.env.example`.

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
DATABASE_URL='postgresql://yuriwong@localhost:5432/whoareyou' ADMIN_TOKEN='dev-admin-token' PROVIDER_USER_HASH_SECRET='dev-provider-user-hash-secret' PROVIDER_CREDENTIAL_ENCRYPTION_SECRET='dev-provider-credential-encryption-secret' npm run test:e2e
DATABASE_URL='postgresql://yuriwong@localhost:5432/whoareyou' ADMIN_TOKEN='dev-admin-token' PROVIDER_USER_HASH_SECRET='dev-provider-user-hash-secret' PROVIDER_CREDENTIAL_ENCRYPTION_SECRET='dev-provider-credential-encryption-secret' npm run build
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
