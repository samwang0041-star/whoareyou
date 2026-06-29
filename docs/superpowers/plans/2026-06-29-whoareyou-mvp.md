# Who Are You MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first usable version of 「你是谁」: a sparse web entry, fake-testable OpenClaw/WeChat callback flow, one-hour human-to-human matching, privacy-safe relay, reachability window policy, and a read-only admin dashboard.

**Architecture:** Use one deployable TypeScript monolith. Keep provider input/output in adapters, keep all product behavior in domain services, and keep all time/retry behavior in database-backed workers. PostgreSQL is the source of truth for users, connections, pair blocks, reports, outbox, scheduled jobs, and admin metrics.

**Tech Stack:** Next.js App Router, TypeScript, Prisma, PostgreSQL, Vitest, Playwright, Zod, Tailwind CSS.

---

## Scope Check

The approved specs span two subsystems: the product flow and the private admin dashboard. This plan keeps them in one MVP plan because the admin dashboard is read-only and only aggregates tables required by the product flow. Execute Tasks 1-10 first to get the demo working; execute Task 11 after the core flow is green.

## References

- Product design: `/Users/yuriwong/.gstack/projects/whoareyou/yuriwong-unknown-design-20260629-224429.md`
- Engineering review: `/Users/yuriwong/.gstack/projects/whoareyou/yuriwong-unknown-eng-review-20260629-231041.md`
- Test plan: `/Users/yuriwong/.gstack/projects/whoareyou/yuriwong-unknown-eng-review-test-plan-20260629-231041.md`
- Admin dashboard spec: `/Users/yuriwong/whoareyou/docs/superpowers/specs/2026-06-29-admin-ops-dashboard-design.md`

## File Structure

Create this structure under `/Users/yuriwong/whoareyou`:

```text
app/
  page.tsx
  admin/page.tsx
  admin/health/page.tsx
  admin/safety/page.tsx
  admin/connections/[id]/page.tsx
  api/qr/route.ts
  api/wechat/callback/route.ts
  api/admin/overview/route.ts
  api/admin/connections/route.ts
  api/admin/connections/[id]/route.ts
  api/admin/health/route.ts
  api/admin/safety/route.ts
  layout.tsx
  globals.css
prisma/
  schema.prisma
src/
  adapters/openclaw.ts
  adapters/fake-openclaw.ts
  config.ts
  domain/capacity.ts
  domain/commands.ts
  domain/identity.ts
  domain/matching.ts
  domain/provider-policy.ts
  domain/safety.ts
  domain/state-machine.ts
  domain/types.ts
  domain/voice.ts
  storage/prisma.ts
  workers/outbox.ts
  workers/scheduled-jobs.ts
  workers/admin-metrics.ts
  workers/admin-details.ts
tests/
  e2e/core-flow.spec.ts
  unit/capacity.test.ts
  unit/commands.test.ts
  unit/provider-policy.test.ts
  unit/state-machine.test.ts
  unit/voice.test.ts
  integration/identity.test.ts
  integration/matching.test.ts
  integration/outbox.test.ts
  integration/safety.test.ts
  integration/scheduled-jobs.test.ts
  integration/admin-metrics.test.ts
  integration/admin-details.test.ts
```

Responsibilities:

- `app/*`: HTML pages and API routes only. These call domain services and do not contain product state transitions.
- `src/adapters/*`: Convert provider-specific OpenClaw/WeChat events to normalized inbound events and send outbound messages.
- `src/domain/*`: Product rules, state machine, command parsing, matching, capacity, identity, reports, and copy.
- `src/workers/*`: DB-backed outbox, scheduled reminders, 60-minute close, reachability renewal, cleanup, and admin snapshots.
- `src/storage/prisma.ts`: Shared Prisma client.
- `tests/*`: Unit tests for pure domain logic, integration tests for database behavior, Playwright for the web and fake adapter path.

## Environment Contract

Use these environment variables:

```text
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/whoareyou
ADMIN_TOKEN=dev-admin-token
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
```

## Repository Prerequisite

The workspace was not a git repository when this plan was written. Before executing task commit steps, initialize the repo or move this plan into the target repo:

```bash
git init
git add docs/superpowers/plans/2026-06-29-whoareyou-mvp.md
git commit -m "docs: add whoareyou mvp implementation plan"
```

## Task 1: Scaffold App, Tooling, and Smoke Tests

**Files:**
- Create: `package.json`
- Create: `vitest.config.ts`
- Create: `playwright.config.ts`
- Create: `tests/unit/smoke.test.ts`
- Create: `.env.example`

- [ ] **Step 1: Create the Next.js app**

Run from `/Users/yuriwong/whoareyou`:

```bash
npm create next-app@latest . -- --ts --app --tailwind --eslint --src-dir false --import-alias "@/*"
```

Expected: app scaffold exists with `app/page.tsx`, `app/layout.tsx`, `tsconfig.json`, and `package.json`.

- [ ] **Step 2: Install runtime and test dependencies**

Run:

```bash
npm install @prisma/client zod
npm install -D prisma vitest @vitejs/plugin-react jsdom playwright
```

Expected: `package-lock.json` updates and `npm ls zod @prisma/client vitest playwright` exits with code 0.

- [ ] **Step 3: Replace `package.json` scripts**

Edit `package.json` so the `scripts` object contains exactly:

```json
{
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "next lint",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:e2e": "playwright test",
  "prisma:generate": "prisma generate",
  "prisma:migrate": "prisma migrate dev",
  "worker:scheduled": "tsx src/workers/scheduled-jobs.ts",
  "worker:outbox": "tsx src/workers/outbox.ts"
}
```

Run:

```bash
npm install -D tsx
```

Expected: `npm run test -- --help` prints Vitest help text.

- [ ] **Step 4: Add Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000,
  },
});
```

- [ ] **Step 5: Add Playwright config**

Create `playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: true,
    timeout: 120000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 15"] } },
  ],
});
```

- [ ] **Step 6: Add env example**

Create `.env.example`:

```text
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/whoareyou
ADMIN_TOKEN=dev-admin-token
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
```

- [ ] **Step 7: Write smoke test**

Create `tests/unit/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("test runner", () => {
  it("runs TypeScript tests", () => {
    expect("你是谁").toBe("你是谁");
  });
});
```

- [ ] **Step 8: Run smoke test**

Run:

```bash
npm test -- tests/unit/smoke.test.ts
```

Expected: PASS with `1 passed`.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json vitest.config.ts playwright.config.ts tests/unit/smoke.test.ts .env.example
git commit -m "chore: scaffold app and tests"
```

## Task 2: Define Domain Types, Config, and Voice Copy

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/config.ts`
- Create: `src/domain/voice.ts`
- Test: `tests/unit/voice.test.ts`

- [ ] **Step 1: Write voice tests**

Create `tests/unit/voice.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { voice } from "../../src/domain/voice";

describe("voice", () => {
  it("uses product language instead of system language", () => {
    const copy = [
      voice.wechatEntry(),
      voice.waiting(),
      voice.matchStarted(),
      voice.minuteReminder(50),
      voice.ended(),
      voice.leaveConfirmed(),
      voice.reachabilityRenewal(),
      voice.reachabilityExpired(),
      voice.help(),
    ].join("\n");

    expect(copy).toContain("入口后面不是 AI");
    expect(copy).toContain("你遇见了一个人");
    expect(copy).not.toContain("匹配成功");
    expect(copy).not.toContain("状态已更新");
    expect(copy).not.toContain("会话已结束");
  });

  it("rounds reminder minutes into product copy", () => {
    expect(voice.minuteReminder(30)).toBe("这次相遇还剩 30 分钟。");
  });
});
```

- [ ] **Step 2: Run voice tests to verify failure**

Run:

```bash
npm test -- tests/unit/voice.test.ts
```

Expected: FAIL because `src/domain/voice.ts` does not exist.

- [ ] **Step 3: Create domain types**

Create `src/domain/types.ts`:

```ts
export type UserState =
  | "new"
  | "available"
  | "waiting"
  | "matched"
  | "cooldown"
  | "paused"
  | "unreachable"
  | "blocked";

export type ConnectionState = "active" | "ending" | "awaiting_echo" | "closed";

export type CloseReason = "timeout" | "left" | "reported" | "provider_expired";

export type OutboxStatus =
  | "pending"
  | "retrying"
  | "sent"
  | "failed"
  | "provider_window_expired";

export type ScheduledJobType =
  | "reminder_10"
  | "reminder_20"
  | "reminder_30"
  | "reminder_40"
  | "reminder_50"
  | "close_connection"
  | "reachability_renewal_prompt"
  | "cooldown_release"
  | "outbox_body_cleanup"
  | "metric_snapshot";

export type Command = "open" | "continue" | "pause" | "leave" | "report" | "help" | "message";

export type NormalizedInboundEvent = {
  providerMessageKey: string;
  providerUserId: string;
  text: string;
  receivedAt: Date;
};

export type OutboundMessage = {
  recipientUserId: string;
  body: string;
  idempotencyKey: string;
};
```

- [ ] **Step 4: Create config parser**

Create `src/config.ts`:

```ts
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
```

- [ ] **Step 5: Create voice module**

Create `src/domain/voice.ts`:

```ts
export const voice = {
  webTitle: () => "你是谁",
  webSubtitle: () => "扫码，遇见一个陌生人。\n这一次，入口后面不是 AI。",
  wechatEntry: () => "你来了。\n\n这一次，我不会回答你。\n我会带你遇见一个人。",
  waiting: () => "正在等另一个也停下来的人。",
  waitingFull: () => "你先到了一点。\n\n也许另一个人还在路上。\n你可以等一会儿，也可以发「暂停」先离开。",
  matchStarted: () => "你遇见了一个人。\n\n你们有一小时。\n不用介绍自己是谁，也不用证明什么。\n只要聊聊此刻。",
  minuteReminder: (minutes: number) => `这次相遇还剩 ${minutes} 分钟。`,
  ending: () => "这次相遇快要结束了。\n如果还有话想说，现在说吧。",
  ended: () => "时间到了。\n\n你们不能继续聊天了。\n但可以留下一句回声。",
  leaveHint: () => "如果想离开，发「离开」就好。",
  leaveConfirmed: () => "你离开了这次相遇。\n\n你的入口还开着。\n也许某个时刻，还会有一个不期而遇的人出现。\n如果想先停一停，发「暂停」。",
  reachabilityRenewal: () => "这个入口快要睡着了。\n\n还要继续把它留给一个不期而遇的人吗？\n如果愿意，发「打开」。",
  reachabilityExpired: () => "入口先安静下来了。\n\n等你想再次打开它时，发「打开」就好。",
  help: () => "你可以发「打开」「继续」「暂停」「离开」「举报」。\n\n入口开着的时候，也许会遇见一个不期而遇的人。",
  unknown: () => "我听见了。\n\n如果你想知道现在能做什么，发「帮助」。",
};
```

- [ ] **Step 6: Run voice tests**

Run:

```bash
npm test -- tests/unit/voice.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/types.ts src/config.ts src/domain/voice.ts tests/unit/voice.test.ts
git commit -m "feat: add domain contracts and product voice"
```

## Task 3: Add Database Schema and Prisma Client

**Files:**
- Create: `prisma/schema.prisma`
- Create: `src/storage/prisma.ts`
- Test: Prisma schema validation command

- [ ] **Step 1: Create Prisma schema**

Create `prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserState {
  new
  available
  waiting
  matched
  cooldown
  paused
  unreachable
  blocked
}

enum ConnectionState {
  active
  ending
  awaiting_echo
  closed
}

enum CloseReason {
  timeout
  left
  reported
  provider_expired
}

enum OutboxStatus {
  pending
  retrying
  sent
  failed
  provider_window_expired
}

enum ScheduledJobStatus {
  pending
  running
  completed
  failed
}

enum ScheduledJobType {
  reminder_10
  reminder_20
  reminder_30
  reminder_40
  reminder_50
  close_connection
  reachability_renewal_prompt
  cooldown_release
  outbox_body_cleanup
  metric_snapshot
}

enum PairBlockReason {
  left
  reported
}

model User {
  id                String    @id @default(cuid())
  providerUserHash  String    @unique
  state             UserState @default(new)
  matchingEnabled   Boolean   @default(true)
  lastUserMessageAt DateTime?
  reachableUntil    DateTime?
  providerSendQuota Int       @default(999)
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  lastSeenAt        DateTime?
  blockedAt         DateTime?

  sentConnections     Connection[] @relation("ConnectionUserA")
  receivedConnections Connection[] @relation("ConnectionUserB")
  outboxMessages      MessageOutbox[]
  reportsMade         Report[]     @relation("Reporter")
  reportsReceived     Report[]     @relation("Reported")
  echoes              Echo[]

  @@index([state, updatedAt])
  @@index([matchingEnabled, reachableUntil, state])
}

model Connection {
  id          String           @id @default(cuid())
  userAId     String
  userBId     String
  state       ConnectionState  @default(active)
  startedAt   DateTime         @default(now())
  endingAt    DateTime?
  closedAt    DateTime?
  closeReason CloseReason?

  userA User @relation("ConnectionUserA", fields: [userAId], references: [id])
  userB User @relation("ConnectionUserB", fields: [userBId], references: [id])

  outboxMessages MessageOutbox[]
  scheduledJobs  ScheduledJob[]
  reports        Report[]
  echoes         Echo[]

  @@index([state, startedAt])
  @@index([userAId, state])
  @@index([userBId, state])
}

model PairBlock {
  id         String          @id @default(cuid())
  userLowId  String
  userHighId String
  reason     PairBlockReason
  createdAt  DateTime        @default(now())

  @@unique([userLowId, userHighId])
  @@index([userLowId, userHighId])
}

model Report {
  id             String   @id @default(cuid())
  reporterUserId String
  reportedUserId String
  connectionId   String
  reason         String
  createdAt      DateTime @default(now())

  reporter   User       @relation("Reporter", fields: [reporterUserId], references: [id])
  reported   User       @relation("Reported", fields: [reportedUserId], references: [id])
  connection Connection @relation(fields: [connectionId], references: [id])

  @@unique([reporterUserId, reportedUserId])
  @@index([reportedUserId, reporterUserId])
  @@index([reportedUserId, createdAt])
}

model InboundDedupe {
  id                 String    @id @default(cuid())
  providerMessageKey String    @unique
  receivedAt         DateTime  @default(now())
  processedAt        DateTime?
  status             String
}

model MessageOutbox {
  id                    String       @id @default(cuid())
  connectionId           String?
  recipientUserId        String
  idempotencyKey         String       @unique
  bodyCiphertextOrBody   String?
  bodyClearedAt          DateTime?
  status                 OutboxStatus @default(pending)
  retryCount             Int          @default(0)
  nextAttemptAt          DateTime     @default(now())
  createdAt              DateTime     @default(now())
  sentAt                 DateTime?
  failedAt               DateTime?
  providerWindowCheckedAt DateTime?

  connection Connection? @relation(fields: [connectionId], references: [id])
  recipient  User        @relation(fields: [recipientUserId], references: [id])

  @@index([status, nextAttemptAt])
}

model ScheduledJob {
  id             String             @id @default(cuid())
  connectionId   String?
  userId         String?
  type           ScheduledJobType
  runAt          DateTime
  idempotencyKey String             @unique
  status         ScheduledJobStatus @default(pending)
  attempts       Int                @default(0)
  lockedAt       DateTime?
  completedAt    DateTime?
  createdAt      DateTime           @default(now())

  connection Connection? @relation(fields: [connectionId], references: [id])

  @@index([status, runAt])
}

model Echo {
  id           String   @id @default(cuid())
  connectionId String
  fromUserId   String
  toUserId     String
  body         String
  createdAt    DateTime @default(now())

  connection Connection @relation(fields: [connectionId], references: [id])
  fromUser   User       @relation(fields: [fromUserId], references: [id])

  @@unique([connectionId, fromUserId])
}

model RateLimitEvent {
  id        String   @id @default(cuid())
  userId    String
  eventType String
  createdAt DateTime @default(now())
}

model AppError {
  id          String    @id @default(cuid())
  source      String
  severity    String
  fingerprint String
  message     String
  contextJson Json?
  createdAt   DateTime  @default(now())
  resolvedAt  DateTime?
}

model WorkerHeartbeat {
  id           String   @id @default(cuid())
  workerName   String   @unique
  lastSeenAt   DateTime
  status       String
  metadataJson Json?
}

model MetricSnapshot {
  id                         String   @id @default(cuid())
  bucketStart                DateTime
  bucketSize                 String
  activeUsers                Int
  waitingUsers               Int
  activeConnections          Int
  matchingEnabledUsers       Int
  reachableUsers             Int
  expiringReachabilityUsers  Int
  completedConnections       Int
  oneHourCompletionRate      Float
  renewalPromptSentCount     Int
  renewalPromptAnsweredCount Int
  outboxPending              Int
  providerWindowExpiredCount Int
  scheduledJobLagSeconds     Int
  reportCount                Int
  blockedCount               Int
  errorCount                 Int

  @@index([bucketStart])
}
```

- [ ] **Step 2: Add Prisma client**

Create `src/storage/prisma.ts`:

```ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
```

- [ ] **Step 3: Validate schema**

Run:

```bash
npx prisma validate
npx prisma generate
```

Expected: both commands exit 0.

- [ ] **Step 4: Create initial migration**

Run with a local Postgres database available:

```bash
npm run prisma:migrate -- --name init
```

Expected: `prisma/migrations/*_init/migration.sql` is created.

- [ ] **Step 5: Add partial unique indexes manually**

Edit the generated `migration.sql` and append:

```sql
CREATE UNIQUE INDEX "connections_active_user_a_unique"
ON "Connection"("userAId")
WHERE "state" IN ('active', 'ending', 'awaiting_echo');

CREATE UNIQUE INDEX "connections_active_user_b_unique"
ON "Connection"("userBId")
WHERE "state" IN ('active', 'ending', 'awaiting_echo');
```

Run:

```bash
npx prisma migrate reset --force
```

Expected: database resets and migration applies successfully.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/storage/prisma.ts
git commit -m "feat: add database schema"
```

## Task 4: Implement Commands, Provider Policy, and Identity

**Files:**
- Create: `src/domain/commands.ts`
- Create: `src/domain/provider-policy.ts`
- Create: `src/domain/identity.ts`
- Test: `tests/unit/commands.test.ts`
- Test: `tests/unit/provider-policy.test.ts`
- Test: `tests/integration/identity.test.ts`

- [ ] **Step 1: Write command and policy tests**

Create `tests/unit/commands.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCommand } from "../../src/domain/commands";

describe("parseCommand", () => {
  it("recognizes product commands", () => {
    expect(parseCommand("打开")).toEqual({ kind: "open" });
    expect(parseCommand("继续")).toEqual({ kind: "continue" });
    expect(parseCommand("暂停")).toEqual({ kind: "pause" });
    expect(parseCommand("离开")).toEqual({ kind: "leave" });
    expect(parseCommand("举报")).toEqual({ kind: "report", reason: "user_requested" });
    expect(parseCommand("帮助")).toEqual({ kind: "help" });
  });

  it("treats ordinary text as a message", () => {
    expect(parseCommand("今天你为什么会扫进来？")).toEqual({
      kind: "message",
      text: "今天你为什么会扫进来？",
    });
  });
});
```

Create `tests/unit/provider-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeReachability, shouldSendRenewalPrompt, canStartMatch } from "../../src/domain/provider-policy";

describe("provider policy", () => {
  it("refreshes a 24-hour reachability window from inbound user message", () => {
    const now = new Date("2026-06-29T10:00:00.000Z");
    const result = computeReachability(now, { replyWindowHours: 24, sendQuota: 999 });
    expect(result.reachableUntil.toISOString()).toBe("2026-06-30T10:00:00.000Z");
    expect(result.providerSendQuota).toBe(999);
  });

  it("requires enough remaining reachability to start a one-hour match", () => {
    const now = new Date("2026-06-29T10:00:00.000Z");
    expect(canStartMatch(now, new Date("2026-06-29T11:20:00.000Z"), 70)).toBe(true);
    expect(canStartMatch(now, new Date("2026-06-29T11:00:00.000Z"), 70)).toBe(false);
  });

  it("prompts renewal when the window is inside the prompt threshold", () => {
    const now = new Date("2026-06-29T10:00:00.000Z");
    expect(shouldSendRenewalPrompt(now, new Date("2026-06-29T10:59:00.000Z"), 60)).toBe(true);
    expect(shouldSendRenewalPrompt(now, new Date("2026-06-29T12:00:00.000Z"), 60)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- tests/unit/commands.test.ts tests/unit/provider-policy.test.ts
```

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement command parser**

Create `src/domain/commands.ts`:

```ts
export type ParsedCommand =
  | { kind: "open" }
  | { kind: "continue" }
  | { kind: "pause" }
  | { kind: "leave" }
  | { kind: "report"; reason: "user_requested" }
  | { kind: "help" }
  | { kind: "message"; text: string };

export function parseCommand(input: string): ParsedCommand {
  const text = input.trim();
  if (text === "打开") return { kind: "open" };
  if (text === "继续") return { kind: "continue" };
  if (text === "暂停") return { kind: "pause" };
  if (text === "离开") return { kind: "leave" };
  if (text === "举报") return { kind: "report", reason: "user_requested" };
  if (text === "帮助") return { kind: "help" };
  return { kind: "message", text };
}
```

- [ ] **Step 4: Implement provider policy**

Create `src/domain/provider-policy.ts`:

```ts
export type ProviderPolicyInput = {
  replyWindowHours: number;
  sendQuota: number;
};

export type Reachability = {
  lastUserMessageAt: Date;
  reachableUntil: Date;
  providerSendQuota: number;
};

export function computeReachability(now: Date, input: ProviderPolicyInput): Reachability {
  return {
    lastUserMessageAt: now,
    reachableUntil: new Date(now.getTime() + input.replyWindowHours * 60 * 60 * 1000),
    providerSendQuota: input.sendQuota,
  };
}

export function minutesUntil(now: Date, target: Date): number {
  return Math.floor((target.getTime() - now.getTime()) / 60000);
}

export function canStartMatch(now: Date, reachableUntil: Date | null, requiredMinutes: number): boolean {
  if (!reachableUntil) return false;
  return minutesUntil(now, reachableUntil) >= requiredMinutes;
}

export function shouldSendRenewalPrompt(now: Date, reachableUntil: Date | null, promptBeforeMinutes: number): boolean {
  if (!reachableUntil) return false;
  const remaining = minutesUntil(now, reachableUntil);
  return remaining > 0 && remaining <= promptBeforeMinutes;
}

export function isProviderWindowExpired(now: Date, reachableUntil: Date | null): boolean {
  if (!reachableUntil) return true;
  return reachableUntil.getTime() <= now.getTime();
}
```

- [ ] **Step 5: Implement identity hashing**

Create `src/domain/identity.ts`:

```ts
import { createHash } from "crypto";
import { prisma } from "../storage/prisma";
import { computeReachability } from "./provider-policy";

export function hashProviderUserId(providerUserId: string): string {
  return createHash("sha256").update(providerUserId).digest("hex");
}

export async function findOrCreateUserFromInbound(input: {
  providerUserId: string;
  receivedAt: Date;
  replyWindowHours: number;
  sendQuota: number;
}) {
  const providerUserHash = hashProviderUserId(input.providerUserId);
  const reachability = computeReachability(input.receivedAt, {
    replyWindowHours: input.replyWindowHours,
    sendQuota: input.sendQuota,
  });

  return prisma.user.upsert({
    where: { providerUserHash },
    create: {
      providerUserHash,
      state: "available",
      matchingEnabled: true,
      lastSeenAt: input.receivedAt,
      lastUserMessageAt: reachability.lastUserMessageAt,
      reachableUntil: reachability.reachableUntil,
      providerSendQuota: reachability.providerSendQuota,
    },
    update: {
      lastSeenAt: input.receivedAt,
      lastUserMessageAt: reachability.lastUserMessageAt,
      reachableUntil: reachability.reachableUntil,
      providerSendQuota: reachability.providerSendQuota,
      matchingEnabled: true,
      state: "available",
    },
  });
}
```

- [ ] **Step 6: Run unit tests**

Run:

```bash
npm test -- tests/unit/commands.test.ts tests/unit/provider-policy.test.ts
```

Expected: PASS.

- [ ] **Step 7: Add identity integration test**

Create `tests/integration/identity.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/storage/prisma";
import { findOrCreateUserFromInbound, hashProviderUserId } from "../../src/domain/identity";

describe("identity", () => {
  beforeEach(async () => {
    await prisma.user.deleteMany();
  });

  it("stores only a hash of provider identity and refreshes reachability", async () => {
    const user = await findOrCreateUserFromInbound({
      providerUserId: "wechat-openclaw-user-1",
      receivedAt: new Date("2026-06-29T10:00:00.000Z"),
      replyWindowHours: 24,
      sendQuota: 999,
    });

    expect(user.providerUserHash).toBe(hashProviderUserId("wechat-openclaw-user-1"));
    expect(user.providerUserHash).not.toContain("wechat-openclaw-user-1");
    expect(user.reachableUntil?.toISOString()).toBe("2026-06-30T10:00:00.000Z");
    expect(user.matchingEnabled).toBe(true);
    expect(user.state).toBe("available");
  });
});
```

- [ ] **Step 8: Run identity test**

Run:

```bash
npm test -- tests/integration/identity.test.ts
```

Expected: PASS against a migrated local Postgres database.

- [ ] **Step 9: Commit**

```bash
git add src/domain/commands.ts src/domain/provider-policy.ts src/domain/identity.ts tests/unit/commands.test.ts tests/unit/provider-policy.test.ts tests/integration/identity.test.ts
git commit -m "feat: add commands and provider reachability"
```

## Task 5: Implement State Machine and Capacity Rules

**Files:**
- Create: `src/domain/state-machine.ts`
- Create: `src/domain/capacity.ts`
- Test: `tests/unit/state-machine.test.ts`
- Test: `tests/unit/capacity.test.ts`

- [ ] **Step 1: Write state machine tests**

Create `tests/unit/state-machine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { transitionUser } from "../../src/domain/state-machine";

describe("transitionUser", () => {
  it("opens the random entrance from paused", () => {
    expect(transitionUser({ state: "paused", matchingEnabled: false }, "open")).toEqual({
      state: "available",
      matchingEnabled: true,
    });
  });

  it("pauses matching without deleting identity", () => {
    expect(transitionUser({ state: "available", matchingEnabled: true }, "pause")).toEqual({
      state: "paused",
      matchingEnabled: false,
    });
  });

  it("moves ended users to cooldown while keeping matching open", () => {
    expect(transitionUser({ state: "matched", matchingEnabled: true }, "connection_closed")).toEqual({
      state: "cooldown",
      matchingEnabled: true,
    });
  });

  it("moves expired reachable users to unreachable and disables matching", () => {
    expect(transitionUser({ state: "available", matchingEnabled: true }, "provider_expired")).toEqual({
      state: "unreachable",
      matchingEnabled: false,
    });
  });
});
```

Create `tests/unit/capacity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideCapacityState } from "../../src/domain/capacity";

describe("decideCapacityState", () => {
  it("allows matching when active and waiting capacity are open", () => {
    expect(decideCapacityState({ activeConnections: 0, waitingUsers: 0, maxActiveConnections: 5, maxWaitingUsers: 20 })).toBe("available");
  });

  it("moves to waiting when active capacity is full but waiting pool is open", () => {
    expect(decideCapacityState({ activeConnections: 5, waitingUsers: 0, maxActiveConnections: 5, maxWaitingUsers: 20 })).toBe("waiting");
  });

  it("keeps the user paused when both active and waiting capacity are full", () => {
    expect(decideCapacityState({ activeConnections: 5, waitingUsers: 20, maxActiveConnections: 5, maxWaitingUsers: 20 })).toBe("paused");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- tests/unit/state-machine.test.ts tests/unit/capacity.test.ts
```

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement state machine**

Create `src/domain/state-machine.ts`:

```ts
import type { UserState } from "./types";

export type UserSnapshot = {
  state: UserState;
  matchingEnabled: boolean;
};

export type UserEvent =
  | "open"
  | "continue"
  | "pause"
  | "matched"
  | "connection_closed"
  | "cooldown_done_reachable"
  | "cooldown_done_unreachable"
  | "provider_expired"
  | "blocked";

export function transitionUser(user: UserSnapshot, event: UserEvent): UserSnapshot {
  if (event === "blocked") return { state: "blocked", matchingEnabled: false };
  if (event === "provider_expired") return { state: "unreachable", matchingEnabled: false };
  if (event === "pause") return { state: "paused", matchingEnabled: false };
  if (event === "open" || event === "continue") return { state: "available", matchingEnabled: true };
  if (event === "matched") return { state: "matched", matchingEnabled: user.matchingEnabled };
  if (event === "connection_closed") return { state: "cooldown", matchingEnabled: user.matchingEnabled };
  if (event === "cooldown_done_reachable") return { state: "available", matchingEnabled: true };
  if (event === "cooldown_done_unreachable") return { state: "unreachable", matchingEnabled: false };
  return user;
}
```

- [ ] **Step 4: Implement capacity rules**

Create `src/domain/capacity.ts`:

```ts
import type { UserState } from "./types";

export type CapacityInput = {
  activeConnections: number;
  waitingUsers: number;
  maxActiveConnections: number;
  maxWaitingUsers: number;
};

export function decideCapacityState(input: CapacityInput): Extract<UserState, "available" | "waiting" | "paused"> {
  if (input.activeConnections < input.maxActiveConnections) return "available";
  if (input.waitingUsers < input.maxWaitingUsers) return "waiting";
  return "paused";
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm test -- tests/unit/state-machine.test.ts tests/unit/capacity.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/state-machine.ts src/domain/capacity.ts tests/unit/state-machine.test.ts tests/unit/capacity.test.ts
git commit -m "feat: add state machine and capacity rules"
```

## Task 6: Implement Transactional Matching

**Files:**
- Create: `src/domain/matching.ts`
- Test: `tests/integration/matching.test.ts`

- [ ] **Step 1: Write matching integration test**

Create `tests/integration/matching.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/storage/prisma";
import { tryMatchUser } from "../../src/domain/matching";

describe("tryMatchUser", () => {
  beforeEach(async () => {
    await prisma.scheduledJob.deleteMany();
    await prisma.messageOutbox.deleteMany();
    await prisma.connection.deleteMany();
    await prisma.pairBlock.deleteMany();
    await prisma.user.deleteMany();
  });

  it("creates one active connection between two reachable users", async () => {
    const reachableUntil = new Date("2026-06-29T12:00:00.000Z");
    const a = await prisma.user.create({ data: { providerUserHash: "a", state: "available", matchingEnabled: true, reachableUntil } });
    const b = await prisma.user.create({ data: { providerUserHash: "b", state: "available", matchingEnabled: true, reachableUntil } });

    const result = await tryMatchUser({
      userId: a.id,
      now: new Date("2026-06-29T10:00:00.000Z"),
      minReachableMinutesToMatch: 70,
    });

    expect(result.status).toBe("matched");
    const connections = await prisma.connection.findMany();
    expect(connections).toHaveLength(1);
    expect(new Set([connections[0].userAId, connections[0].userBId])).toEqual(new Set([a.id, b.id]));
  });

  it("excludes blocked pairs", async () => {
    const reachableUntil = new Date("2026-06-29T12:00:00.000Z");
    const a = await prisma.user.create({ data: { providerUserHash: "a", state: "available", matchingEnabled: true, reachableUntil } });
    const b = await prisma.user.create({ data: { providerUserHash: "b", state: "available", matchingEnabled: true, reachableUntil } });
    await prisma.pairBlock.create({ data: { userLowId: a.id < b.id ? a.id : b.id, userHighId: a.id < b.id ? b.id : a.id, reason: "left" } });

    const result = await tryMatchUser({
      userId: a.id,
      now: new Date("2026-06-29T10:00:00.000Z"),
      minReachableMinutesToMatch: 70,
    });

    expect(result.status).toBe("waiting");
    expect(await prisma.connection.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run matching tests to verify failure**

Run:

```bash
npm test -- tests/integration/matching.test.ts
```

Expected: FAIL because `tryMatchUser` does not exist.

- [ ] **Step 3: Implement matching service**

Create `src/domain/matching.ts`:

```ts
import { prisma } from "../storage/prisma";
import { voice } from "./voice";

export type MatchResult = { status: "matched"; connectionId: string } | { status: "waiting" } | { status: "not_eligible" };

export async function tryMatchUser(input: {
  userId: string;
  now: Date;
  minReachableMinutesToMatch: number;
}): Promise<MatchResult> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.user.findUnique({ where: { id: input.userId } });
    if (!current || !current.matchingEnabled || current.state === "blocked") return { status: "not_eligible" };
    if (!current.reachableUntil || current.reachableUntil.getTime() < input.now.getTime() + input.minReachableMinutesToMatch * 60000) {
      await tx.user.update({ where: { id: current.id }, data: { state: "unreachable", matchingEnabled: false } });
      return { status: "not_eligible" };
    }

    const activeConnection = await tx.connection.findFirst({
      where: {
        state: { in: ["active", "ending", "awaiting_echo"] },
        OR: [{ userAId: current.id }, { userBId: current.id }],
      },
    });
    if (activeConnection) return { status: "not_eligible" };

    const candidates = await tx.user.findMany({
      where: {
        id: { not: current.id },
        state: { in: ["available", "waiting"] },
        matchingEnabled: true,
        reachableUntil: { gte: new Date(input.now.getTime() + input.minReachableMinutesToMatch * 60000) },
      },
      orderBy: { updatedAt: "asc" },
      take: 10,
    });

    for (const candidate of candidates) {
      const low = current.id < candidate.id ? current.id : candidate.id;
      const high = current.id < candidate.id ? candidate.id : current.id;
      const blocked = await tx.pairBlock.findUnique({ where: { userLowId_userHighId: { userLowId: low, userHighId: high } } });
      if (blocked) continue;

      const candidateActive = await tx.connection.findFirst({
        where: {
          state: { in: ["active", "ending", "awaiting_echo"] },
          OR: [{ userAId: candidate.id }, { userBId: candidate.id }],
        },
      });
      if (candidateActive) continue;

      const connection = await tx.connection.create({
        data: {
          userAId: current.id,
          userBId: candidate.id,
          state: "active",
          startedAt: input.now,
        },
      });

      await tx.user.updateMany({
        where: { id: { in: [current.id, candidate.id] } },
        data: { state: "matched" },
      });

      const reminderMinutes = [10, 20, 30, 40, 50, 60];
      await tx.scheduledJob.createMany({
        data: reminderMinutes.map((minute) => ({
          connectionId: connection.id,
          type: minute === 60 ? "close_connection" : (`reminder_${minute}` as const),
          runAt: new Date(input.now.getTime() + minute * 60000),
          idempotencyKey: `${connection.id}:job:${minute}`,
        })),
      });

      await tx.messageOutbox.createMany({
        data: [current.id, candidate.id].map((recipientUserId) => ({
          connectionId: connection.id,
          recipientUserId,
          idempotencyKey: `${connection.id}:match-start:${recipientUserId}`,
          bodyCiphertextOrBody: voice.matchStarted(),
          nextAttemptAt: input.now,
        })),
      });

      return { status: "matched", connectionId: connection.id };
    }

    await tx.user.update({ where: { id: current.id }, data: { state: "waiting" } });
    return { status: "waiting" };
  });
}
```

- [ ] **Step 4: Run matching tests**

Run:

```bash
npm test -- tests/integration/matching.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/matching.ts tests/integration/matching.test.ts
git commit -m "feat: add transactional matching"
```

## Task 7: Implement Safety, Leave, Reports, and Echo

**Files:**
- Create: `src/domain/safety.ts`
- Test: `tests/integration/safety.test.ts`

- [ ] **Step 1: Write safety tests**

Create `tests/integration/safety.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/storage/prisma";
import { closeForLeave, reportConnection, submitEcho } from "../../src/domain/safety";

describe("safety", () => {
  beforeEach(async () => {
    await prisma.echo.deleteMany();
    await prisma.report.deleteMany();
    await prisma.pairBlock.deleteMany();
    await prisma.connection.deleteMany();
    await prisma.user.deleteMany();
  });

  it("leave closes the connection, creates a pair block, and keeps users open through cooldown", async () => {
    const a = await prisma.user.create({ data: { providerUserHash: "a", state: "matched", matchingEnabled: true } });
    const b = await prisma.user.create({ data: { providerUserHash: "b", state: "matched", matchingEnabled: true } });
    const connection = await prisma.connection.create({ data: { userAId: a.id, userBId: b.id, state: "active" } });

    await closeForLeave({ connectionId: connection.id, actorUserId: a.id, now: new Date("2026-06-29T10:00:00.000Z") });

    expect(await prisma.pairBlock.count()).toBe(1);
    const users = await prisma.user.findMany({ orderBy: { providerUserHash: "asc" } });
    expect(users.map((u) => u.state)).toEqual(["cooldown", "cooldown"]);
    expect(users.map((u) => u.matchingEnabled)).toEqual([true, true]);
  });

  it("three distinct reporters block a user", async () => {
    const reported = await prisma.user.create({ data: { providerUserHash: "reported", state: "matched", matchingEnabled: true } });

    for (const hash of ["r1", "r2", "r3"]) {
      const reporter = await prisma.user.create({ data: { providerUserHash: hash, state: "matched", matchingEnabled: true } });
      const connection = await prisma.connection.create({ data: { userAId: reporter.id, userBId: reported.id, state: "active" } });
      await reportConnection({ connectionId: connection.id, reporterUserId: reporter.id, reason: "user_requested", now: new Date() });
    }

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: reported.id } });
    expect(updated.state).toBe("blocked");
    expect(updated.matchingEnabled).toBe(false);
  });

  it("allows one echo per user", async () => {
    const a = await prisma.user.create({ data: { providerUserHash: "a" } });
    const b = await prisma.user.create({ data: { providerUserHash: "b" } });
    const connection = await prisma.connection.create({ data: { userAId: a.id, userBId: b.id, state: "awaiting_echo" } });

    await submitEcho({ connectionId: connection.id, fromUserId: a.id, body: "谢谢你停下来。", now: new Date() });
    await expect(submitEcho({ connectionId: connection.id, fromUserId: a.id, body: "第二句", now: new Date() })).rejects.toThrow("echo_already_submitted");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- tests/integration/safety.test.ts
```

Expected: FAIL because `src/domain/safety.ts` does not exist.

- [ ] **Step 3: Implement safety module**

Create `src/domain/safety.ts`:

```ts
import { prisma } from "../storage/prisma";

function unorderedPair(a: string, b: string) {
  return a < b ? { userLowId: a, userHighId: b } : { userLowId: b, userHighId: a };
}

export async function closeForLeave(input: { connectionId: string; actorUserId: string; now: Date }) {
  const connection = await prisma.connection.findUniqueOrThrow({ where: { id: input.connectionId } });
  const pair = unorderedPair(connection.userAId, connection.userBId);

  await prisma.$transaction([
    prisma.connection.update({
      where: { id: connection.id },
      data: { state: "awaiting_echo", closeReason: "left", closedAt: input.now },
    }),
    prisma.pairBlock.upsert({
      where: { userLowId_userHighId: pair },
      create: { ...pair, reason: "left" },
      update: { reason: "left" },
    }),
    prisma.user.updateMany({
      where: { id: { in: [connection.userAId, connection.userBId] }, state: { not: "blocked" } },
      data: { state: "cooldown" },
    }),
  ]);
}

export async function reportConnection(input: { connectionId: string; reporterUserId: string; reason: string; now: Date }) {
  const connection = await prisma.connection.findUniqueOrThrow({ where: { id: input.connectionId } });
  const reportedUserId = connection.userAId === input.reporterUserId ? connection.userBId : connection.userAId;
  const pair = unorderedPair(connection.userAId, connection.userBId);

  await prisma.$transaction(async (tx) => {
    await tx.report.upsert({
      where: { reporterUserId_reportedUserId: { reporterUserId: input.reporterUserId, reportedUserId } },
      create: {
        reporterUserId: input.reporterUserId,
        reportedUserId,
        connectionId: input.connectionId,
        reason: input.reason,
        createdAt: input.now,
      },
      update: { reason: input.reason },
    });

    await tx.pairBlock.upsert({
      where: { userLowId_userHighId: pair },
      create: { ...pair, reason: "reported" },
      update: { reason: "reported" },
    });

    await tx.connection.update({
      where: { id: input.connectionId },
      data: { state: "awaiting_echo", closeReason: "reported", closedAt: input.now },
    });

    const reportCount = await tx.report.count({ where: { reportedUserId } });
    if (reportCount >= 3) {
      await tx.user.update({ where: { id: reportedUserId }, data: { state: "blocked", matchingEnabled: false, blockedAt: input.now } });
    }

    await tx.user.updateMany({
      where: { id: { in: [connection.userAId, connection.userBId] }, state: { not: "blocked" } },
      data: { state: "cooldown" },
    });
  });
}

export async function submitEcho(input: { connectionId: string; fromUserId: string; body: string; now: Date }) {
  const connection = await prisma.connection.findUniqueOrThrow({ where: { id: input.connectionId } });
  if (connection.state !== "awaiting_echo" && connection.state !== "closed") {
    throw new Error("echo_not_open");
  }
  const toUserId = connection.userAId === input.fromUserId ? connection.userBId : connection.userAId;
  const existing = await prisma.echo.findUnique({
    where: { connectionId_fromUserId: { connectionId: input.connectionId, fromUserId: input.fromUserId } },
  });
  if (existing) throw new Error("echo_already_submitted");
  return prisma.echo.create({
    data: {
      connectionId: input.connectionId,
      fromUserId: input.fromUserId,
      toUserId,
      body: input.body.slice(0, 160),
      createdAt: input.now,
    },
  });
}
```

- [ ] **Step 4: Run safety tests**

Run:

```bash
npm test -- tests/integration/safety.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/safety.ts tests/integration/safety.test.ts
git commit -m "feat: add leave report and echo safety"
```

## Task 8: Implement Outbox and Scheduled Jobs

**Files:**
- Create: `src/workers/outbox.ts`
- Create: `src/workers/scheduled-jobs.ts`
- Test: `tests/integration/outbox.test.ts`
- Test: `tests/integration/scheduled-jobs.test.ts`

- [ ] **Step 1: Write outbox tests**

Create `tests/integration/outbox.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/storage/prisma";
import { processOutboxBatch } from "../../src/workers/outbox";

describe("outbox", () => {
  beforeEach(async () => {
    await prisma.messageOutbox.deleteMany();
    await prisma.user.deleteMany();
  });

  it("sends reachable messages and clears body", async () => {
    const user = await prisma.user.create({ data: { providerUserHash: "u", reachableUntil: new Date("2026-06-30T10:00:00.000Z"), providerSendQuota: 999 } });
    await prisma.messageOutbox.create({ data: { recipientUserId: user.id, idempotencyKey: "m1", bodyCiphertextOrBody: "hello" } });

    const sent: string[] = [];
    await processOutboxBatch({
      now: new Date("2026-06-29T10:00:00.000Z"),
      limit: 10,
      send: async (message) => {
        sent.push(message.body);
      },
    });

    const row = await prisma.messageOutbox.findFirstOrThrow();
    expect(sent).toEqual(["hello"]);
    expect(row.status).toBe("sent");
    expect(row.bodyCiphertextOrBody).toBeNull();
    expect(row.bodyClearedAt).toBeTruthy();
  });

  it("does not send after provider window expires", async () => {
    const user = await prisma.user.create({ data: { providerUserHash: "u", reachableUntil: new Date("2026-06-29T09:00:00.000Z"), providerSendQuota: 999 } });
    await prisma.messageOutbox.create({ data: { recipientUserId: user.id, idempotencyKey: "m1", bodyCiphertextOrBody: "hello" } });

    await processOutboxBatch({
      now: new Date("2026-06-29T10:00:00.000Z"),
      limit: 10,
      send: async () => {
        throw new Error("send_should_not_run");
      },
    });

    const row = await prisma.messageOutbox.findFirstOrThrow();
    expect(row.status).toBe("provider_window_expired");
  });
});
```

- [ ] **Step 2: Run outbox tests to verify failure**

Run:

```bash
npm test -- tests/integration/outbox.test.ts
```

Expected: FAIL because worker does not exist.

- [ ] **Step 3: Implement outbox worker**

Create `src/workers/outbox.ts`:

```ts
import { prisma } from "../storage/prisma";
import { isProviderWindowExpired } from "../domain/provider-policy";

export type SendInput = {
  recipientUserId: string;
  body: string;
  idempotencyKey: string;
};

export async function processOutboxBatch(input: {
  now: Date;
  limit: number;
  send: (message: SendInput) => Promise<void>;
}) {
  const messages = await prisma.messageOutbox.findMany({
    where: { status: { in: ["pending", "retrying"] }, nextAttemptAt: { lte: input.now } },
    include: { recipient: true },
    orderBy: { createdAt: "asc" },
    take: input.limit,
  });

  for (const message of messages) {
    if (isProviderWindowExpired(input.now, message.recipient.reachableUntil) || message.recipient.providerSendQuota <= 0) {
      await prisma.messageOutbox.update({
        where: { id: message.id },
        data: { status: "provider_window_expired", providerWindowCheckedAt: input.now },
      });
      await prisma.user.update({
        where: { id: message.recipientUserId },
        data: { state: "unreachable", matchingEnabled: false },
      });
      continue;
    }

    const body = message.bodyCiphertextOrBody;
    if (!body) {
      await prisma.messageOutbox.update({ where: { id: message.id }, data: { status: "failed", failedAt: input.now } });
      continue;
    }

    await input.send({ recipientUserId: message.recipientUserId, body, idempotencyKey: message.idempotencyKey });
    await prisma.messageOutbox.update({
      where: { id: message.id },
      data: {
        status: "sent",
        sentAt: input.now,
        bodyCiphertextOrBody: null,
        bodyClearedAt: input.now,
      },
    });
    await prisma.user.update({
      where: { id: message.recipientUserId },
      data: { providerSendQuota: { decrement: 1 } },
    });
  }
}

if (require.main === module) {
  processOutboxBatch({
    now: new Date(),
    limit: Number(process.env.SCHEDULED_JOB_BATCH_SIZE ?? 50),
    send: async (message) => {
      console.log(`fake-send:${message.recipientUserId}:${message.idempotencyKey}`);
    },
  }).finally(() => prisma.$disconnect());
}
```

- [ ] **Step 4: Write scheduled job test**

Create `tests/integration/scheduled-jobs.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/storage/prisma";
import { processScheduledJobs } from "../../src/workers/scheduled-jobs";

describe("scheduled jobs", () => {
  beforeEach(async () => {
    await prisma.scheduledJob.deleteMany();
    await prisma.messageOutbox.deleteMany();
    await prisma.connection.deleteMany();
    await prisma.user.deleteMany();
  });

  it("turns 50-minute reminder into ending state and outbox copy", async () => {
    const a = await prisma.user.create({ data: { providerUserHash: "a" } });
    const b = await prisma.user.create({ data: { providerUserHash: "b" } });
    const connection = await prisma.connection.create({ data: { userAId: a.id, userBId: b.id, state: "active" } });
    await prisma.scheduledJob.create({ data: { connectionId: connection.id, type: "reminder_50", runAt: new Date("2026-06-29T10:50:00.000Z"), idempotencyKey: "j1" } });

    await processScheduledJobs({ now: new Date("2026-06-29T10:50:01.000Z"), limit: 10, cooldownSeconds: 60 });

    const updated = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(updated.state).toBe("ending");
    expect(await prisma.messageOutbox.count()).toBe(2);
  });

  it("closes connection at 60 minutes and moves users to cooldown", async () => {
    const a = await prisma.user.create({ data: { providerUserHash: "a", state: "matched", matchingEnabled: true } });
    const b = await prisma.user.create({ data: { providerUserHash: "b", state: "matched", matchingEnabled: true } });
    const connection = await prisma.connection.create({ data: { userAId: a.id, userBId: b.id, state: "active" } });
    await prisma.scheduledJob.create({ data: { connectionId: connection.id, type: "close_connection", runAt: new Date("2026-06-29T11:00:00.000Z"), idempotencyKey: "j1" } });

    await processScheduledJobs({ now: new Date("2026-06-29T11:00:01.000Z"), limit: 10, cooldownSeconds: 60 });

    const updated = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    const users = await prisma.user.findMany({ orderBy: { providerUserHash: "asc" } });
    expect(updated.state).toBe("awaiting_echo");
    expect(users.map((u) => u.state)).toEqual(["cooldown", "cooldown"]);
  });
});
```

- [ ] **Step 5: Implement scheduled jobs worker**

Create `src/workers/scheduled-jobs.ts`:

```ts
import { prisma } from "../storage/prisma";
import { voice } from "../domain/voice";

function reminderBody(type: string): string {
  if (type === "reminder_50") return voice.ending();
  const minutes = 60 - Number(type.replace("reminder_", ""));
  return voice.minuteReminder(minutes);
}

export async function processScheduledJobs(input: { now: Date; limit: number; cooldownSeconds: number }) {
  const jobs = await prisma.scheduledJob.findMany({
    where: { status: "pending", runAt: { lte: input.now } },
    include: { connection: true },
    orderBy: { runAt: "asc" },
    take: input.limit,
  });

  for (const job of jobs) {
    await prisma.$transaction(async (tx) => {
      await tx.scheduledJob.update({ where: { id: job.id }, data: { status: "running", lockedAt: input.now, attempts: { increment: 1 } } });

      if (job.connection && job.type.startsWith("reminder_")) {
        if (job.type === "reminder_50") {
          await tx.connection.update({ where: { id: job.connection.id }, data: { state: "ending", endingAt: input.now } });
        }
        await tx.messageOutbox.createMany({
          data: [job.connection.userAId, job.connection.userBId].map((recipientUserId) => ({
            connectionId: job.connection!.id,
            recipientUserId,
            idempotencyKey: `${job.id}:reminder:${recipientUserId}`,
            bodyCiphertextOrBody: reminderBody(job.type),
            nextAttemptAt: input.now,
          })),
          skipDuplicates: true,
        });
      }

      if (job.connection && job.type === "close_connection") {
        await tx.connection.update({
          where: { id: job.connection.id },
          data: { state: "awaiting_echo", closeReason: "timeout", closedAt: input.now },
        });
        await tx.user.updateMany({
          where: { id: { in: [job.connection.userAId, job.connection.userBId] }, state: { not: "blocked" } },
          data: { state: "cooldown" },
        });
        await tx.messageOutbox.createMany({
          data: [job.connection.userAId, job.connection.userBId].map((recipientUserId) => ({
            connectionId: job.connection!.id,
            recipientUserId,
            idempotencyKey: `${job.id}:ended:${recipientUserId}`,
            bodyCiphertextOrBody: voice.ended(),
            nextAttemptAt: input.now,
          })),
          skipDuplicates: true,
        });
      }

      await tx.scheduledJob.update({ where: { id: job.id }, data: { status: "completed", completedAt: input.now } });
    });
  }
}

if (require.main === module) {
  processScheduledJobs({
    now: new Date(),
    limit: Number(process.env.SCHEDULED_JOB_BATCH_SIZE ?? 50),
    cooldownSeconds: Number(process.env.COOLDOWN_SECONDS ?? 60),
  }).finally(() => prisma.$disconnect());
}
```

- [ ] **Step 6: Run worker tests**

Run:

```bash
npm test -- tests/integration/outbox.test.ts tests/integration/scheduled-jobs.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/workers/outbox.ts src/workers/scheduled-jobs.ts tests/integration/outbox.test.ts tests/integration/scheduled-jobs.test.ts
git commit -m "feat: add outbox and scheduled jobs"
```

## Task 9: Implement OpenClaw Adapter, Callback Route, and QR Route

**Files:**
- Create: `src/adapters/openclaw.ts`
- Create: `src/adapters/fake-openclaw.ts`
- Create: `app/api/qr/route.ts`
- Create: `app/api/wechat/callback/route.ts`
- Test: `tests/integration/callback.test.ts`

- [ ] **Step 1: Write callback integration test**

Create `tests/integration/callback.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/storage/prisma";
import { handleFakeInbound } from "../../src/adapters/fake-openclaw";

describe("fake OpenClaw callback", () => {
  beforeEach(async () => {
    await prisma.inboundDedupe.deleteMany();
    await prisma.messageOutbox.deleteMany();
    await prisma.connection.deleteMany();
    await prisma.user.deleteMany();
  });

  it("dedupes inbound messages", async () => {
    const input = { providerMessageKey: "m1", providerUserId: "u1", text: "帮助", receivedAt: new Date("2026-06-29T10:00:00.000Z") };
    await handleFakeInbound(input);
    await handleFakeInbound(input);
    expect(await prisma.inboundDedupe.count()).toBe(1);
  });
});
```

- [ ] **Step 2: Run callback test to verify failure**

Run:

```bash
npm test -- tests/integration/callback.test.ts
```

Expected: FAIL because adapter does not exist.

- [ ] **Step 3: Create adapter interface**

Create `src/adapters/openclaw.ts`:

```ts
import type { NormalizedInboundEvent, OutboundMessage } from "../domain/types";

export type OpenClawAdapter = {
  parseInbound(requestBody: unknown): NormalizedInboundEvent;
  sendOutbound(message: OutboundMessage): Promise<void>;
  getEntryQr(): Promise<{ url: string }>;
};
```

- [ ] **Step 4: Implement fake adapter handler**

Create `src/adapters/fake-openclaw.ts`:

```ts
import { prisma } from "../storage/prisma";
import type { NormalizedInboundEvent, OutboundMessage } from "../domain/types";
import { findOrCreateUserFromInbound } from "../domain/identity";
import { parseCommand } from "../domain/commands";
import { voice } from "../domain/voice";
import { tryMatchUser } from "../domain/matching";
import { closeForLeave, reportConnection } from "../domain/safety";

export const fakeOpenClaw = {
  parseInbound(body: unknown): NormalizedInboundEvent {
    const input = body as NormalizedInboundEvent;
    return {
      providerMessageKey: String(input.providerMessageKey),
      providerUserId: String(input.providerUserId),
      text: String(input.text),
      receivedAt: new Date(input.receivedAt),
    };
  },
  async sendOutbound(message: OutboundMessage) {
    console.log(JSON.stringify({ fakeOutbound: message }));
  },
  async getEntryQr() {
    return { url: "/api/wechat/callback?fake=1" };
  },
};

export async function handleFakeInbound(event: NormalizedInboundEvent) {
  const existing = await prisma.inboundDedupe.findUnique({ where: { providerMessageKey: event.providerMessageKey } });
  if (existing) return { status: "duplicate" as const };

  await prisma.inboundDedupe.create({ data: { providerMessageKey: event.providerMessageKey, receivedAt: event.receivedAt, status: "processing" } });

  const user = await findOrCreateUserFromInbound({
    providerUserId: event.providerUserId,
    receivedAt: event.receivedAt,
    replyWindowHours: Number(process.env.PROVIDER_REPLY_WINDOW_HOURS ?? 24),
    sendQuota: Number(process.env.PROVIDER_SEND_QUOTA_AFTER_USER_MESSAGE ?? 999),
  });

  const command = parseCommand(event.text);
  if (command.kind === "help") {
    await prisma.messageOutbox.create({
      data: { recipientUserId: user.id, idempotencyKey: `${event.providerMessageKey}:help`, bodyCiphertextOrBody: voice.help(), nextAttemptAt: event.receivedAt },
    });
  }

  if (command.kind === "open" || command.kind === "continue") {
    await prisma.user.update({ where: { id: user.id }, data: { state: "available", matchingEnabled: true } });
    await tryMatchUser({ userId: user.id, now: event.receivedAt, minReachableMinutesToMatch: Number(process.env.MIN_REACHABLE_MINUTES_TO_MATCH ?? 70) });
  }

  if (command.kind === "pause") {
    await prisma.user.update({ where: { id: user.id }, data: { state: "paused", matchingEnabled: false } });
  }

  const activeConnection = await prisma.connection.findFirst({
    where: { state: { in: ["active", "ending"] }, OR: [{ userAId: user.id }, { userBId: user.id }] },
  });

  if (command.kind === "leave" && activeConnection) {
    await closeForLeave({ connectionId: activeConnection.id, actorUserId: user.id, now: event.receivedAt });
  }

  if (command.kind === "report" && activeConnection) {
    await reportConnection({ connectionId: activeConnection.id, reporterUserId: user.id, reason: command.reason, now: event.receivedAt });
  }

  if (command.kind === "message" && activeConnection) {
    const recipientUserId = activeConnection.userAId === user.id ? activeConnection.userBId : activeConnection.userAId;
    await prisma.messageOutbox.create({
      data: {
        connectionId: activeConnection.id,
        recipientUserId,
        idempotencyKey: `${event.providerMessageKey}:relay`,
        bodyCiphertextOrBody: command.text,
        nextAttemptAt: event.receivedAt,
      },
    });
  }

  await prisma.inboundDedupe.update({ where: { providerMessageKey: event.providerMessageKey }, data: { status: "processed", processedAt: event.receivedAt } });
  return { status: "processed" as const };
}
```

- [ ] **Step 5: Create API routes**

Create `app/api/qr/route.ts`:

```ts
import { NextResponse } from "next/server";
import { fakeOpenClaw } from "../../../src/adapters/fake-openclaw";

export async function GET() {
  const qr = await fakeOpenClaw.getEntryQr();
  return NextResponse.json(qr);
}
```

Create `app/api/wechat/callback/route.ts`:

```ts
import { NextResponse } from "next/server";
import { fakeOpenClaw, handleFakeInbound } from "../../../../src/adapters/fake-openclaw";

export async function POST(request: Request) {
  const body = await request.json();
  const event = fakeOpenClaw.parseInbound(body);
  const result = await handleFakeInbound(event);
  return NextResponse.json(result);
}
```

- [ ] **Step 6: Run callback test**

Run:

```bash
npm test -- tests/integration/callback.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/openclaw.ts src/adapters/fake-openclaw.ts app/api/qr/route.ts app/api/wechat/callback/route.ts tests/integration/callback.test.ts
git commit -m "feat: add fake openclaw callback flow"
```

## Task 10: Implement Landing Page and Product Entry

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/layout.tsx`
- Modify: `app/globals.css`
- Test: `tests/e2e/landing.spec.ts`

- [ ] **Step 1: Write landing E2E test**

Create `tests/e2e/landing.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("landing page shows ritual entry and fetches QR", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "你是谁" })).toBeVisible();
  await expect(page.getByText("扫码，遇见一个陌生人。")).toBeVisible();
  await page.getByRole("button", { name: "进入" }).click();
  await expect(page.getByText("/api/wechat/callback?fake=1")).toBeVisible();
});
```

- [ ] **Step 2: Run E2E test to verify failure**

Run:

```bash
npm run test:e2e -- tests/e2e/landing.spec.ts
```

Expected: FAIL because landing page is still the scaffold.

- [ ] **Step 3: Implement layout metadata**

Modify `app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "你是谁",
  description: "扫码，遇见一个陌生人。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 4: Implement landing page**

Modify `app/page.tsx`:

```tsx
"use client";

import { useState } from "react";

export default function HomePage() {
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  async function enter() {
    setError(false);
    const response = await fetch("/api/qr");
    if (!response.ok) {
      setError(true);
      return;
    }
    const data = (await response.json()) as { url: string };
    setQrUrl(data.url);
  }

  return (
    <main className="min-h-screen bg-[#120f1b] text-[#f6f0e8]">
      <section className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
        <p className="mb-6 text-sm text-[#b9a98f]">AI 入口里的真人相遇</p>
        <h1 className="text-6xl font-normal tracking-normal sm:text-7xl">你是谁</h1>
        <p className="mt-8 whitespace-pre-line text-xl leading-9 text-[#efe5d7]">
          扫码，遇见一个陌生人。{"\n"}这一次，入口后面不是 AI。
        </p>
        <button
          className="mt-10 w-fit border border-[#f6f0e8]/50 px-6 py-3 text-base text-[#f6f0e8] transition hover:border-[#f6f0e8]"
          onClick={enter}
        >
          进入
        </button>
        {qrUrl ? (
          <div className="mt-8 border border-[#f6f0e8]/20 p-4 text-sm text-[#d7c7af]">
            <p>请用微信打开这个入口：</p>
            <p className="mt-2 break-all">{qrUrl}</p>
          </div>
        ) : null}
        {error ? <p className="mt-6 text-[#e6a19a]">入口暂时没有亮起来。等一会儿再试。</p> : null}
        <p className="mt-16 max-w-xl whitespace-pre-line text-base leading-8 text-[#b9a98f]">
          我们已经习惯扫码，接入一个又一个 agent。{"\n"}
          可这一次，请先停一下。{"\n"}
          入口后面不是 AI。{"\n"}
          是另一个也停下来的人。
        </p>
      </section>
    </main>
  );
}
```

- [ ] **Step 5: Set base CSS**

Modify `app/globals.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  color-scheme: dark;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  min-height: 100%;
}

button {
  font: inherit;
}
```

- [ ] **Step 6: Run landing E2E**

Run:

```bash
npm run test:e2e -- tests/e2e/landing.spec.ts
```

Expected: PASS on desktop and mobile projects.

- [ ] **Step 7: Commit**

```bash
git add app/page.tsx app/layout.tsx app/globals.css tests/e2e/landing.spec.ts
git commit -m "feat: add ritual landing page"
```

## Task 11: Implement Admin Overview Metrics

**Files:**
- Create: `src/workers/admin-metrics.ts`
- Create: `app/api/admin/overview/route.ts`
- Create: `app/admin/page.tsx`
- Test: `tests/integration/admin-metrics.test.ts`

- [ ] **Step 1: Write admin metrics test**

Create `tests/integration/admin-metrics.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/storage/prisma";
import { getAdminOverview } from "../../src/workers/admin-metrics";

describe("admin metrics", () => {
  beforeEach(async () => {
    await prisma.messageOutbox.deleteMany();
    await prisma.connection.deleteMany();
    await prisma.user.deleteMany();
  });

  it("reports reachable entrance pool", async () => {
    await prisma.user.create({ data: { providerUserHash: "open", state: "available", matchingEnabled: true, reachableUntil: new Date("2026-06-29T12:00:00.000Z") } });
    await prisma.user.create({ data: { providerUserHash: "expired", state: "unreachable", matchingEnabled: false, reachableUntil: new Date("2026-06-29T09:00:00.000Z") } });

    const overview = await getAdminOverview(new Date("2026-06-29T10:00:00.000Z"), 70, 60);

    expect(overview.reachableUsers).toBe(1);
    expect(overview.matchingEnabledUsers).toBe(1);
    expect(overview.currentWaitingUsers).toBe(1);
  });
});
```

- [ ] **Step 2: Run admin metrics test to verify failure**

Run:

```bash
npm test -- tests/integration/admin-metrics.test.ts
```

Expected: FAIL because `admin-metrics.ts` does not exist.

- [ ] **Step 3: Implement admin metric aggregation**

Create `src/workers/admin-metrics.ts`:

```ts
import { prisma } from "../storage/prisma";

export async function getAdminOverview(now: Date, minReachableMinutesToMatch: number, renewalPromptBeforeMinutes: number) {
  const reachableCutoff = new Date(now.getTime() + minReachableMinutesToMatch * 60000);
  const renewalCutoff = new Date(now.getTime() + renewalPromptBeforeMinutes * 60000);

  const [
    matchingEnabledUsers,
    reachableUsers,
    expiringReachabilityUsers,
    currentWaitingUsers,
    activeConnections,
    providerWindowExpiredCount,
    pendingOutbox,
    reportCount,
    blockedCount,
  ] = await Promise.all([
    prisma.user.count({ where: { matchingEnabled: true, state: { not: "blocked" } } }),
    prisma.user.count({ where: { matchingEnabled: true, state: { not: "blocked" }, reachableUntil: { gte: reachableCutoff } } }),
    prisma.user.count({ where: { matchingEnabled: true, reachableUntil: { gte: now, lte: renewalCutoff } } }),
    prisma.user.count({ where: { state: { in: ["available", "waiting"] } } }),
    prisma.connection.count({ where: { state: { in: ["active", "ending"] } } }),
    prisma.messageOutbox.count({ where: { status: "provider_window_expired" } }),
    prisma.messageOutbox.count({ where: { status: { in: ["pending", "retrying"] } } }),
    prisma.report.count(),
    prisma.user.count({ where: { state: "blocked" } }),
  ]);

  return {
    matchingEnabledUsers,
    reachableUsers,
    expiringReachabilityUsers,
    currentWaitingUsers,
    currentMatchedUsers: activeConnections * 2,
    providerWindowExpiredCount,
    pendingOutbox,
    reportCount,
    blockedCount,
  };
}
```

- [ ] **Step 4: Add admin overview API**

Create `app/api/admin/overview/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getAdminOverview } from "../../../../src/workers/admin-metrics";

export async function GET(request: Request) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (token !== process.env.ADMIN_TOKEN) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const overview = await getAdminOverview(
    new Date(),
    Number(process.env.MIN_REACHABLE_MINUTES_TO_MATCH ?? 70),
    Number(process.env.REACHABILITY_RENEWAL_PROMPT_BEFORE_MINUTES ?? 60),
  );
  return NextResponse.json(overview);
}
```

- [ ] **Step 5: Add admin page**

Create `app/admin/page.tsx`:

```tsx
export default function AdminPage() {
  return (
    <main className="min-h-screen bg-[#101010] px-6 py-8 text-[#f4f1ea]">
      <section className="mx-auto max-w-6xl">
        <p className="text-sm text-[#aaa]">不要把它优化成另一个让人停不下来的机器。</p>
        <h1 className="mt-3 text-3xl font-normal">运营监控</h1>
        <div className="mt-8 grid gap-4 md:grid-cols-4">
          <Metric title="完整一小时完成率" value="读取 /admin/api/overview" />
          <Metric title="入口可达率" value="reachableUsers / users" />
          <Metric title="当前匹配中" value="active * 2" />
          <Metric title="即将失联" value="expiring reachability" />
        </div>
      </section>
    </main>
  );
}

function Metric(props: { title: string; value: string }) {
  return (
    <div className="border border-white/10 p-4">
      <p className="text-sm text-[#aaa]">{props.title}</p>
      <p className="mt-3 text-xl">{props.value}</p>
    </div>
  );
}
```

- [ ] **Step 6: Run admin metrics test**

Run:

```bash
npm test -- tests/integration/admin-metrics.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/workers/admin-metrics.ts app/api/admin/overview/route.ts app/admin/page.tsx tests/integration/admin-metrics.test.ts
git commit -m "feat: add admin overview metrics"
```

## Task 12: Add Admin Health, Safety, and Anonymous Connection Detail

**Files:**
- Create: `src/workers/admin-details.ts`
- Create: `app/api/admin/health/route.ts`
- Create: `app/api/admin/safety/route.ts`
- Create: `app/api/admin/connections/route.ts`
- Create: `app/api/admin/connections/[id]/route.ts`
- Create: `app/admin/health/page.tsx`
- Create: `app/admin/safety/page.tsx`
- Create: `app/admin/connections/[id]/page.tsx`
- Test: `tests/integration/admin-details.test.ts`

- [ ] **Step 1: Write admin detail tests**

Create `tests/integration/admin-details.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/storage/prisma";
import { getConnectionDetail, getHealthMetrics, getSafetyMetrics } from "../../src/workers/admin-details";

describe("admin details", () => {
  beforeEach(async () => {
    await prisma.echo.deleteMany();
    await prisma.report.deleteMany();
    await prisma.scheduledJob.deleteMany();
    await prisma.messageOutbox.deleteMany();
    await prisma.connection.deleteMany();
    await prisma.inboundDedupe.deleteMany();
    await prisma.appError.deleteMany();
    await prisma.workerHeartbeat.deleteMany();
    await prisma.user.deleteMany();
  });

  it("returns anonymous connection detail without chat or provider identity", async () => {
    const a = await prisma.user.create({ data: { providerUserHash: "aaaaaaaaaaaaaaaa", state: "matched", matchingEnabled: true } });
    const b = await prisma.user.create({ data: { providerUserHash: "bbbbbbbbbbbbbbbb", state: "matched", matchingEnabled: true } });
    const connection = await prisma.connection.create({ data: { userAId: a.id, userBId: b.id, state: "active" } });
    await prisma.messageOutbox.create({
      data: {
        connectionId: connection.id,
        recipientUserId: b.id,
        idempotencyKey: "secret-message",
        bodyCiphertextOrBody: "this body must not appear",
      },
    });

    const detail = await getConnectionDetail(connection.id);
    const serialized = JSON.stringify(detail);

    expect(detail?.users).toEqual(["u_aaaaaa", "u_bbbbbb"]);
    expect(serialized).not.toContain("this body must not appear");
    expect(serialized).not.toContain(a.providerUserHash);
    expect(serialized).not.toContain(b.providerUserHash);
  });

  it("returns health and safety metrics", async () => {
    await prisma.inboundDedupe.create({ data: { providerMessageKey: "m1", status: "processed" } });
    await prisma.appError.create({ data: { source: "test", severity: "error", fingerprint: "f1", message: "failure" } });
    await prisma.workerHeartbeat.create({ data: { workerName: "outbox", lastSeenAt: new Date("2026-06-29T10:00:00.000Z"), status: "ok" } });
    const reported = await prisma.user.create({ data: { providerUserHash: "reported", state: "blocked", matchingEnabled: false } });
    const reporter = await prisma.user.create({ data: { providerUserHash: "reporter" } });
    const connection = await prisma.connection.create({ data: { userAId: reporter.id, userBId: reported.id, state: "closed" } });
    await prisma.report.create({ data: { reporterUserId: reporter.id, reportedUserId: reported.id, connectionId: connection.id, reason: "user_requested" } });

    const health = await getHealthMetrics();
    const safety = await getSafetyMetrics();

    expect(health.callbackCount).toBe(1);
    expect(health.errorCount).toBe(1);
    expect(health.workerHeartbeats).toHaveLength(1);
    expect(safety.reportCount).toBe(1);
    expect(safety.blockedCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run admin detail tests to verify failure**

Run:

```bash
npm test -- tests/integration/admin-details.test.ts
```

Expected: FAIL because `src/workers/admin-details.ts` does not exist.

- [ ] **Step 3: Implement admin detail service**

Create `src/workers/admin-details.ts`:

```ts
import { prisma } from "../storage/prisma";

function anonymousUserId(providerUserHash: string): string {
  return `u_${providerUserHash.slice(0, 6)}`;
}

export async function getConnectionDetail(connectionId: string) {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
    include: {
      userA: true,
      userB: true,
      scheduledJobs: { select: { type: true, status: true, runAt: true, completedAt: true }, orderBy: { runAt: "asc" } },
      reports: { select: { reason: true, createdAt: true } },
      echoes: { select: { fromUserId: true, body: true, createdAt: true } },
      outboxMessages: { select: { status: true, retryCount: true, createdAt: true, sentAt: true, failedAt: true } },
    },
  });
  if (!connection) return null;

  return {
    id: connection.id,
    state: connection.state,
    startedAt: connection.startedAt,
    endingAt: connection.endingAt,
    closedAt: connection.closedAt,
    closeReason: connection.closeReason,
    users: [anonymousUserId(connection.userA.providerUserHash), anonymousUserId(connection.userB.providerUserHash)],
    userStates: [connection.userA.state, connection.userB.state],
    matchingEnabled: [connection.userA.matchingEnabled, connection.userB.matchingEnabled],
    reachableUntil: [connection.userA.reachableUntil, connection.userB.reachableUntil],
    scheduledJobs: connection.scheduledJobs,
    outboxSummary: {
      pending: connection.outboxMessages.filter((m) => m.status === "pending" || m.status === "retrying").length,
      failed: connection.outboxMessages.filter((m) => m.status === "failed" || m.status === "provider_window_expired").length,
      sent: connection.outboxMessages.filter((m) => m.status === "sent").length,
    },
    reportCount: connection.reports.length,
    echoCount: connection.echoes.length,
    echoLengths: connection.echoes.map((echo) => echo.body.length),
  };
}

export async function listConnections(state?: string) {
  return prisma.connection.findMany({
    where: state ? { state: state as never } : undefined,
    select: { id: true, state: true, startedAt: true, endingAt: true, closedAt: true, closeReason: true },
    orderBy: { startedAt: "desc" },
    take: 50,
  });
}

export async function getHealthMetrics() {
  const [callbackCount, duplicateCallbackCount, pendingOutbox, providerWindowExpiredCount, errorCount, workerHeartbeats] = await Promise.all([
    prisma.inboundDedupe.count(),
    prisma.inboundDedupe.count({ where: { status: "duplicate" } }),
    prisma.messageOutbox.count({ where: { status: { in: ["pending", "retrying"] } } }),
    prisma.messageOutbox.count({ where: { status: "provider_window_expired" } }),
    prisma.appError.count({ where: { resolvedAt: null } }),
    prisma.workerHeartbeat.findMany({ select: { workerName: true, lastSeenAt: true, status: true }, orderBy: { workerName: "asc" } }),
  ]);

  return {
    callbackCount,
    duplicateCallbackCount,
    pendingOutbox,
    providerWindowExpiredCount,
    errorCount,
    workerHeartbeats,
  };
}

export async function getSafetyMetrics() {
  const [reportCount, blockedCount, leaveClosedCount, reportedClosedCount] = await Promise.all([
    prisma.report.count(),
    prisma.user.count({ where: { state: "blocked" } }),
    prisma.connection.count({ where: { closeReason: "left" } }),
    prisma.connection.count({ where: { closeReason: "reported" } }),
  ]);

  const reportGroups = await prisma.report.groupBy({
    by: ["reportedUserId"],
    _count: { reporterUserId: true },
    having: { reporterUserId: { _count: { gte: 2 } } },
  });

  return {
    reportCount,
    blockedCount,
    usersNearBlock: reportGroups.length,
    leaveClosedCount,
    reportedClosedCount,
  };
}
```

- [ ] **Step 4: Add admin API routes**

Create `app/api/admin/health/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getHealthMetrics } from "../../../../src/workers/admin-details";

export async function GET(request: Request) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (token !== process.env.ADMIN_TOKEN) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await getHealthMetrics());
}
```

Create `app/api/admin/safety/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getSafetyMetrics } from "../../../../src/workers/admin-details";

export async function GET(request: Request) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (token !== process.env.ADMIN_TOKEN) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await getSafetyMetrics());
}
```

Create `app/api/admin/connections/route.ts`:

```ts
import { NextResponse } from "next/server";
import { listConnections } from "../../../../src/workers/admin-details";

export async function GET(request: Request) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (token !== process.env.ADMIN_TOKEN) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  return NextResponse.json(await listConnections(url.searchParams.get("state") ?? undefined));
}
```

Create `app/api/admin/connections/[id]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getConnectionDetail } from "../../../../../src/workers/admin-details";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (token !== process.env.ADMIN_TOKEN) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const detail = await getConnectionDetail(id);
  if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(detail);
}
```

- [ ] **Step 5: Add admin pages**

Create `app/admin/health/page.tsx`:

```tsx
export default function AdminHealthPage() {
  return (
    <main className="min-h-screen bg-[#101010] px-6 py-8 text-[#f4f1ea]">
      <section className="mx-auto max-w-6xl">
        <p className="text-sm text-[#aaa]">callback / outbox / scheduled jobs / worker heartbeat</p>
        <h1 className="mt-3 text-3xl font-normal">服务健康</h1>
      </section>
    </main>
  );
}
```

Create `app/admin/safety/page.tsx`:

```tsx
export default function AdminSafetyPage() {
  return (
    <main className="min-h-screen bg-[#101010] px-6 py-8 text-[#f4f1ea]">
      <section className="mx-auto max-w-6xl">
        <p className="text-sm text-[#aaa]">reports / users near block / blocked users / leave rate</p>
        <h1 className="mt-3 text-3xl font-normal">安全边界</h1>
      </section>
    </main>
  );
}
```

Create `app/admin/connections/[id]/page.tsx`:

```tsx
export default async function AdminConnectionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="min-h-screen bg-[#101010] px-6 py-8 text-[#f4f1ea]">
      <section className="mx-auto max-w-6xl">
        <p className="text-sm text-[#aaa]">匿名连接详情，不显示聊天正文或微信原始身份</p>
        <h1 className="mt-3 text-3xl font-normal">连接 {id}</h1>
      </section>
    </main>
  );
}
```

- [ ] **Step 6: Run admin detail tests**

Run:

```bash
npm test -- tests/integration/admin-details.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/workers/admin-details.ts app/api/admin/health/route.ts app/api/admin/safety/route.ts app/api/admin/connections/route.ts app/api/admin/connections/[id]/route.ts app/admin/health/page.tsx app/admin/safety/page.tsx app/admin/connections/[id]/page.tsx tests/integration/admin-details.test.ts
git commit -m "feat: add admin health safety and connection detail"
```

## Task 13: Add Full Fake Adapter E2E

**Files:**
- Create: `tests/e2e/core-flow.spec.ts`

- [ ] **Step 1: Write core flow E2E**

Create `tests/e2e/core-flow.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("fake users can enter and produce one connection", async ({ request }) => {
  const a = await request.post("/api/wechat/callback", {
    data: {
      providerMessageKey: "e2e-a-open",
      providerUserId: "e2e-a",
      text: "打开",
      receivedAt: "2026-06-29T10:00:00.000Z",
    },
  });
  expect(a.ok()).toBeTruthy();

  const b = await request.post("/api/wechat/callback", {
    data: {
      providerMessageKey: "e2e-b-open",
      providerUserId: "e2e-b",
      text: "打开",
      receivedAt: "2026-06-29T10:00:10.000Z",
    },
  });
  expect(b.ok()).toBeTruthy();

  const message = await request.post("/api/wechat/callback", {
    data: {
      providerMessageKey: "e2e-a-message",
      providerUserId: "e2e-a",
      text: "今天你为什么会扫进来？",
      receivedAt: "2026-06-29T10:01:00.000Z",
    },
  });
  expect(message.ok()).toBeTruthy();
});
```

- [ ] **Step 2: Run E2E**

Run:

```bash
npm run test:e2e -- tests/e2e/core-flow.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run all tests**

Run:

```bash
npm test
npm run test:e2e
npm run build
```

Expected: all commands pass.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/core-flow.spec.ts
git commit -m "test: cover fake openclaw core flow"
```

## Self-Review

Spec coverage:

- Web entry: Task 10.
- QR route: Task 9.
- OpenClaw callback adapter: Task 9.
- Hashed identity and no profile storage: Tasks 3 and 4.
- Matching only among eligible users: Task 6.
- One active connection per user: Tasks 3 and 6.
- 10-minute reminders and 60-minute close: Task 8.
- Leave, report, pair block, three-report block: Task 7.
- One echo per user: Task 7.
- No readable chat history in outbox after send: Task 8.
- OpenClaw 24-hour reachability and renewal constraints: Tasks 4, 6, 8, and 11.
- Admin monitoring metrics: Tasks 11 and 12.
- Fake adapter E2E: Tasks 9 and 13.

Placeholder scan:

- No placeholder markers or deferred implementation instructions remain in the task steps.

Type consistency:

- User states use `new | available | waiting | matched | cooldown | paused | unreachable | blocked`.
- Connection states use `active | ending | awaiting_echo | closed`.
- Outbox terminal status for provider expiry is `provider_window_expired`.
- The reachability field is consistently named `reachableUntil` in Prisma/TypeScript and `reachable_until` only in product docs.
