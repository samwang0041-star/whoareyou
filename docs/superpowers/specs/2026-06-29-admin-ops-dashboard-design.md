# Design: 运营监控后台

Date: 2026-06-29
Status: APPROVED
Product: 你是谁
Related docs:
- `/Users/yuriwong/.gstack/projects/whoareyou/yuriwong-unknown-design-20260629-224429.md`
- `/Users/yuriwong/.gstack/projects/whoareyou/yuriwong-unknown-eng-review-20260629-231041.md`
- `/Users/yuriwong/.gstack/projects/whoareyou/yuriwong-unknown-eng-review-test-plan-20260629-231041.md`

## Goal

Build a private admin dashboard that lets the operator understand whether the product is alive, whether people are getting stuck, whether one-hour encounters are completing, and whether service or safety issues need attention.

This is not a CRM, moderation console, or chat viewer. It is an operating room for a small, privacy-respecting demo.

## Product Principle

The dashboard must preserve the product's deeper thesis:

> In the AI era, people are pushed by five-hour limits, seven-day token windows, context budgets, queues, vibe coding loops, and endless conversations. Efficiency goes up, but people get more tired. The product should help people stop serving the machine for a moment and meet another human being.

The dashboard should not optimize only for more usage, more sessions, or more time spent. It should help optimize for complete, intentional, bounded encounters, while keeping the random entrance available for unexpected human contact.

Backend principle shown at the top of `/admin`:

```text
不要把它优化成另一个让人停不下来的机器。
```

## Chosen Approach

Use **运营总览 + 匿名下钻**.

The first version has a real-time overview page plus detail pages for anonymous connections, service health, and safety. It can inspect state, timing, queues, errors, reports, and capacity. It cannot inspect chat content or real WeChat identity.

## Information Architecture

Routes:

```text
/admin
/admin/connections/:id
/admin/health
/admin/safety
```

Top-level layout:

```text
/admin
  Principle bar
  North-star metrics
  Live status
  Active/ending/recent connections
  Service health
  Safety summary
```

Detailed pages:

```text
/admin/connections/:id
  Anonymous connection timeline
  Two anonymous users
  State transitions
  Reminder jobs
  Outbox summary
  Report/leave/echo metadata
  No chat body

/admin/health
  WeChat/OpenClaw callbacks
  inbound dedupe
  message outbox
  scheduled jobs
  app errors
  worker heartbeat

/admin/safety
  reports
  users at 2 reports
  blocked users
  leave/report rates
  rate-limit events
```

## Dashboard Metrics

Default provider policy for V1:

```text
PROVIDER_REPLY_WINDOW_HOURS=24
REACHABILITY_RENEWAL_PROMPT_BEFORE_MINUTES=60
MIN_REACHABLE_MINUTES_TO_MATCH=70
```

### North-Star Metrics

Primary:

```text
完整一小时完成率
= timeout-closed connections / all closed connections
```

Secondary:

```text
有效相遇数
= connections that became active

入口可达率
= users with matching_enabled=true and reachable_until >= now + MIN_REACHABLE_MINUTES_TO_MATCH
   / non-blocked users

当前匹配中人数
= active/ending connections * 2

当前等待人数
= users in available/waiting
```

### Product Experience Metrics

```text
当前扫码人数
= users created or active in the last 10 minutes

当前等待人数
= users.state in available/waiting

入口打开人数
= users.matching_enabled = true

可随机匹配人数
= users.matching_enabled = true
  and users.state in available/waiting
  and users.reachable_until >= now + MIN_REACHABLE_MINUTES_TO_MATCH
  and users not blocked

即将失联人数
= users.matching_enabled = true
  and users.reachable_until between now and now + REACHABILITY_RENEWAL_PROMPT_BEFORE_MINUTES

续期响应率
= renewal prompts answered / renewal prompts sent

当前匹配中人数
= count(active/ending connections) * 2

今日有效相遇数
= connections that became active today

完整一小时完成率
= close_reason = timeout / all closed connections

回声率
= closed connections with at least one echo / closed connections

平均等待时间
= time from available/waiting to matched

中途离开率
= close_reason = left / closed connections

举报率
= close_reason = reported / closed connections
```

### Service Health Metrics

```text
OpenClaw/WeChat 回调成功率
= successfully processed callbacks / total callbacks

重复回调数
= inbound_dedupe duplicate hits

outbox 积压
= message_outbox where status in pending/retrying

outbox 最老等待时间
= now - oldest pending outbox.created_at

scheduled jobs 延迟
= now - oldest due scheduled_jobs.run_at

发送失败率
= failed outbox / sent + failed outbox

OpenClaw 触达窗口过期数
= message_outbox.status = provider_window_expired

续期询问发送数
= scheduled_jobs/outbox events where type = reachability_renewal_prompt

任务执行失败数
= scheduled_jobs failed count

worker heartbeat
= most recent outbox/scheduler worker heartbeat timestamp

app errors
= app_errors by severity and source
```

### Safety Metrics

```text
今日举报数
= reports created today

今日封禁数
= users moved to blocked today

接近封禁用户
= users with reports from 2 distinct matched reporters

离开率
= close_reason = left / closed connections

举报率
= close_reason = reported / closed connections

频控命中数
= rate_limit_events count
```

## Alerts

The dashboard should show red/yellow states on the first screen. It does not need external paging in V1.

P0 red:

- OpenClaw/WeChat callback processing continuously fails.
- Scheduled job lag exceeds 2 minutes.
- Oldest pending outbox exceeds 2 minutes.
- Outbox has a spike of `provider_window_expired`, meaning the system tried to speak after OpenClaw reachability was gone.
- Active connection count exceeds `MAX_ACTIVE_CONNECTIONS`.
- A user has more than one active connection.
- A connection is active while either user is paused or blocked.
- A connection is active while either user's `reachable_until` cannot cover the remaining encounter and final product messages.
- Worker heartbeat is stale.

P1 yellow:

- Waiting users exist for more than 5 minutes without matching.
- One-hour completion rate drops below 30%.
- Leave rate spikes compared with recent baseline.
- Report rate spikes compared with recent baseline.
- Users at 2 reports increase.
- Echo rate falls below expected baseline.
- QR fetch failures increase.
- 即将失联人数 rises, but renewal prompts are not being sent.
- 续期响应率 drops compared with recent baseline.

## Anonymous Detail Views

Connection detail may show:

```text
connection id
state
started_at
ending_at
closed_at
close_reason
anonymous user display ids
current remaining time
user matching_enabled flags
user reachable_until timestamps
reachability renewal prompt status
scheduled reminder status
outbox pending/retry/failed counts
whether echo exists
echo length
whether leave/report happened
report reason enum
state transition timeline
```

Connection detail must not show:

```text
raw WeChat ID
nickname
avatar
phone number
chat body
outbox body after successful send
full identity history
```

Anonymous user display id:

```text
u_<first 4-6 chars of internal hash>
```

Example detail:

```text
connection_123
状态：ending
开始：22:10
剩余：08:32
用户：u_8f31 / u_a92c
入口：open / open
可触达：23h12m / 21h40m
提醒：10/20/30/40/50 已发送
关闭原因：未关闭
outbox：0 pending, 0 failed
reports：0
echo：未到阶段
```

## Data Model

The dashboard should primarily aggregate existing product tables.

Existing tables used:

```text
users
connections
pair_blocks
reports
message_outbox
scheduled_jobs
inbound_dedupe
echoes
```

Additional tables:

```text
admin_audit_events
  id
  admin_id
  action
  target_type
  target_id
  created_at

rate_limit_events
  id
  user_id
  event_type
  created_at

app_errors
  id
  source
  severity
  fingerprint
  message
  context_json
  created_at
  resolved_at

worker_heartbeats
  id
  worker_name
  last_seen_at
  status
  metadata_json

metric_snapshots
  id
  bucket_start
  bucket_size
  active_users
  waiting_users
  active_connections
  matching_enabled_users
  reachable_users
  expiring_reachability_users
  completed_connections
  one_hour_completion_rate
  renewal_prompt_sent_count
  renewal_prompt_answered_count
  outbox_pending
  provider_window_expired_count
  scheduled_job_lag_seconds
  report_count
  blocked_count
  error_count
```

Notes:

- `admin_audit_events` exists even if V1 is read-only, so future admin actions have a place to log.
- `rate_limit_events` is needed to understand abuse and runaway interaction loops.
- `app_errors` is a lightweight local error store. Sentry can be added later.
- `worker_heartbeats` makes worker stalls visible.
- `metric_snapshots` supports trend charts without scanning all event tables on every refresh.

## API

Admin routes:

```text
GET /admin/api/overview
GET /admin/api/connections?state=active
GET /admin/api/connections/:id
GET /admin/api/health
GET /admin/api/safety
GET /admin/api/errors
```

Refresh behavior:

- `/admin/api/overview`: poll every 5-10 seconds.
- Connection detail: poll every 10 seconds.
- Health and safety pages: poll every 10-30 seconds.
- Trend charts: read `metric_snapshots`, updated every minute.

No WebSocket in V1. Polling is enough, simpler to test, and easier to operate.

## Permissions

V1:

```text
ADMIN_TOKEN or a single administrator account
/admin/* requires authentication
dashboard is read-only by default
no raw data export
no chat content access
no raw provider identity access
```

Future actions that must write `admin_audit_events`:

- manual block
- manual unblock
- clear waiting pool
- pause all matching
- change capacity limits
- resolve error

## Privacy Rules

The dashboard can display:

- anonymous internal user id
- short provider hash display id
- connection id
- state
- timestamps
- close reason
- matching_enabled
- reachable_until / time to provider expiry
- report reason enum
- outbox/job status
- error fingerprint
- echo existence and length

The dashboard cannot display:

- raw WeChat ID
- nickname
- avatar
- phone number
- chat body
- retained outbox body after send/TTL
- full personal profile

## UI Behavior

First screen sections:

```text
Principle bar
  不要把它优化成另一个让人停不下来的机器。

North-star strip
  完整一小时完成率
  有效相遇数
  入口可达率
  当前匹配中
  当前等待

Live operations
  waiting users
  active/ending connections
  reachable entrance pool
  expiring reachability
  recently closed connections

Health strip
  callback success
  outbox pending
  provider window expired
  renewal response rate
  scheduled lag
  worker heartbeat
  app errors

Safety strip
  reports today
  users near block
  blocked today
  rate-limit events
```

Design tone:

- Dense and quiet.
- Operational, not decorative.
- No marketing copy.
- No large hero section.
- Red/yellow states should be obvious.
- Tables must be scannable.

## Tests

Unit tests:

- metric calculation for one-hour completion rate
- metric calculation for stop index
- metric calculation for waiting/current matching counts
- alert threshold evaluation
- anonymous id formatting
- privacy serializer excludes raw provider identity and chat body

Integration tests:

- overview API returns correct aggregate counts
- connection detail API returns timeline without chat body
- health API reports outbox lag and scheduled job lag
- safety API reports reports, near-block users, and blocked users
- metric snapshot worker writes expected buckets
- admin routes reject unauthenticated requests

E2E tests:

- admin overview loads with fake seeded data
- dashboard auto-refresh updates counts
- clicking an active connection opens anonymous detail
- detail page shows reminder/outbox/report status but no chat text
- health page turns red when job lag exceeds threshold
- safety page shows user at 2 reports and blocked after 3 reports

Privacy regression tests:

- no endpoint returns raw provider id
- no endpoint returns message body
- no endpoint returns outbox body after clear
- no connection detail includes chat transcript

## Out Of Scope

- Full moderation console.
- Manual block/unblock actions.
- Raw log search.
- Chat transcript viewing.
- Exporting user data.
- Sentry/Grafana/Prometheus integration.
- WebSocket live updates.
- Multi-admin role management.

## Open Implementation Choices

These are implementation choices, not product blockers:

- Whether admin auth is a single `ADMIN_TOKEN` or a minimal login.
- Whether `app_errors` is written by custom middleware or an existing error library.
- Whether metric snapshots are generated by the same worker loop as scheduled jobs or a separate cron job.
- Whether trend charts use simple inline SVG/canvas or a chart library.

Recommendation for V1:

- `ADMIN_TOKEN`
- custom lightweight `app_errors`
- same worker process writes metric snapshots every minute
- simple chart component or table-first display
