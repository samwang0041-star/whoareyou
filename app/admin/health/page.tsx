"use client";

import Link from "next/link";
import type { FormEvent } from "react";
import { useCallback, useState } from "react";
import type { HealthMetrics } from "../../../src/workers/admin-details";

type PageStatus = "locked" | "loading" | "ready" | "unauthorized" | "error";

export default function AdminHealthPage() {
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<PageStatus>("locked");
  const [health, setHealth] = useState<HealthMetrics | null>(null);

  const fetchHealth = useCallback(async (adminToken: string) => {
    setStatus("loading");

    try {
      const response = await fetch("/api/admin/health", {
        cache: "no-store",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      if (response.status === 401 || response.status === 403) {
        setHealth(null);
        setStatus("unauthorized");
        return;
      }
      if (!response.ok) throw new Error("health_unavailable");

      setHealth((await response.json()) as HealthMetrics);
      setStatus("ready");
    } catch {
      setHealth(null);
      setStatus("error");
    }
  }, []);

  async function submitToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextToken = token.trim();
    if (!nextToken) {
      setHealth(null);
      setStatus("locked");
      return;
    }
    await fetchHealth(nextToken);
  }

  return (
    <main className="min-h-screen bg-[#111111] text-[#eeeeea]">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-6 sm:px-8">
        <header className="border-b border-[#2f3432] pb-4">
          <Link className="text-sm text-[#bdb5a4] transition hover:text-[#f7f2e7]" href="/admin">
            返回运营监控
          </Link>
          <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-2xl font-normal text-[#f7f2e7]">服务健康</h1>
              <p className="mt-2 text-xs text-[#8f9691]">{health ? formatTimestamp(health.generatedAt) : statusLabel(status)}</p>
            </div>
            <form className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end" onSubmit={submitToken}>
              <label className="flex min-w-64 flex-col gap-1 text-xs text-[#9da39e]" htmlFor="admin-health-token">
                Admin token
                <input
                  autoComplete="off"
                  className="h-10 border border-[#38403b] bg-[#171918] px-3 text-sm text-[#f0eee6] outline-none focus:border-[#8f9691]"
                  id="admin-health-token"
                  onChange={(event) => setToken(event.target.value)}
                  type="password"
                  value={token}
                />
              </label>
              <button
                className="h-10 border border-[#5c625c] px-4 text-sm text-[#f0eee6] transition hover:border-[#d4ccb9] disabled:cursor-wait disabled:opacity-60"
                disabled={status === "loading"}
                type="submit"
              >
                {status === "loading" ? "连接中" : health ? "刷新" : "连接"}
              </button>
            </form>
          </div>
          {status === "unauthorized" ? <p className="mt-3 text-sm text-[#f0b6a8]">unauthorized</p> : null}
          {status === "error" ? <p className="mt-3 text-sm text-[#f0b6a8]">health unavailable</p> : null}
        </header>

        <section className="grid gap-3 md:grid-cols-4">
          <Metric label="callbacks" value={valueOrDash(health?.callbacksTotal)} />
          <Metric label="callback failed" tone={health && health.callbackFailed > 0 ? "warn" : "neutral"} value={valueOrDash(health?.callbackFailed)} />
          <Metric label="outbox backlog" tone={health && health.outbox.backlog > 0 ? "warn" : "neutral"} value={valueOrDash(health?.outbox.backlog)} />
          <Metric label="active errors" tone={health && health.activeAppErrors > 0 ? "warn" : "neutral"} value={valueOrDash(health?.activeAppErrors)} />
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Callback">
            <MetricTable
              rows={[
                ["total", valueOrDash(health?.callbacksTotal)],
                ["duplicate", valueOrDash(health?.callbackDuplicates)],
                ["failed", valueOrDash(health?.callbackFailed)],
                ["statuses", health ? health.callbacksByStatus.map((row) => `${row.status}:${row.count}`).join(" / ") || "-" : "-"],
              ]}
            />
          </Panel>

          <Panel title="Outbox">
            <MetricTable
              rows={[
                ["pending", valueOrDash(health?.outbox.pending)],
                ["retrying", valueOrDash(health?.outbox.retrying)],
                ["sending", valueOrDash(health?.outbox.sending)],
                ["sent", valueOrDash(health?.outbox.sent)],
                ["failed", valueOrDash(health?.outbox.failed)],
                ["provider window expired", valueOrDash(health?.providerWindowExpiredCount)],
              ]}
            />
          </Panel>
        </div>

        <Panel title="Workers">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse text-left text-sm">
              <thead className="border-b border-[#2f3432] text-xs text-[#9da39e]">
                <tr>
                  <th className="px-4 py-3 font-normal">worker</th>
                  <th className="px-4 py-3 font-normal">status</th>
                  <th className="px-4 py-3 font-normal">last seen</th>
                  <th className="px-4 py-3 font-normal">metadata</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2a2f2c]">
                {(health?.workerHeartbeats ?? []).map((heartbeat) => (
                  <tr key={heartbeat.workerName}>
                    <td className="px-4 py-3 text-[#f0eee6]">{heartbeat.workerName}</td>
                    <td className="px-4 py-3 text-[#f0eee6]">{heartbeat.status}</td>
                    <td className="px-4 py-3 text-[#9da39e]">{formatTimestamp(heartbeat.lastSeenAt)}</td>
                    <td className="px-4 py-3 text-[#9da39e]">{heartbeat.metadataPresent ? "present" : "-"}</td>
                  </tr>
                ))}
                {health && health.workerHeartbeats.length === 0 ? (
                  <tr>
                    <td className="px-4 py-3 text-[#8f9691]" colSpan={4}>
                      no heartbeat
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Panel>
      </section>
    </main>
  );
}

function Metric(props: { label: string; value: number | string; tone?: "neutral" | "warn" }) {
  const toneClass =
    props.tone === "warn" ? "border-[#76592d] bg-[#241b11] text-[#f4dfb8]" : "border-[#303532] bg-[#171918] text-[#eeeeea]";

  return (
    <div className={`min-h-24 border p-4 ${toneClass}`}>
      <p className="text-xs text-[#9da39e]">{props.label}</p>
      <p className="mt-3 text-2xl font-normal tabular-nums">{props.value}</p>
    </div>
  );
}

function Panel(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="border border-[#2f3432]">
      <h2 className="border-b border-[#2f3432] px-4 py-3 text-sm font-normal text-[#cfc7b6]">{props.title}</h2>
      <div>{props.children}</div>
    </section>
  );
}

function MetricTable(props: { rows: Array<[string, number | string]> }) {
  return (
    <dl className="divide-y divide-[#2a2f2c]">
      {props.rows.map(([label, value]) => (
        <div className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-2" key={label}>
          <dt className="truncate text-sm text-[#9da39e]">{label}</dt>
          <dd className="text-right text-sm tabular-nums text-[#f0eee6]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function valueOrDash(value: number | undefined): number | string {
  return value ?? "-";
}

function formatTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function statusLabel(status: PageStatus): string {
  if (status === "loading") return "loading";
  if (status === "unauthorized") return "unauthorized";
  if (status === "error") return "error";
  if (status === "ready") return "live";
  return "locked";
}
