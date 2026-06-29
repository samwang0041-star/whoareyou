"use client";

import Link from "next/link";
import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import type { AdminOverview } from "../../src/workers/admin-metrics";
import type { ConnectionListItem } from "../../src/workers/admin-details";

type DashboardStatus = "locked" | "loading" | "ready" | "error";

export default function AdminPage() {
  const [token, setToken] = useState("");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [connections, setConnections] = useState<ConnectionListItem[]>([]);
  const [status, setStatus] = useState<DashboardStatus>("locked");

  const fetchOverview = useCallback(async (adminToken: string, quiet = false) => {
    if (!quiet) setStatus("loading");

    try {
      const response = await fetch("/api/admin/overview", {
        cache: "no-store",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      if (response.status === 401 || response.status === 403) {
        setOverview(null);
        setConnections([]);
        setStatus("error");
        return;
      }
      if (!response.ok) {
        if (quiet) return;
        throw new Error("overview_unavailable");
      }

      const nextOverview = (await response.json()) as AdminOverview;
      const connectionsResponse = await fetch("/api/admin/connections", {
        cache: "no-store",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      if (connectionsResponse.status === 401 || connectionsResponse.status === 403) {
        setOverview(null);
        setConnections([]);
        setStatus("error");
        return;
      }
      if (!connectionsResponse.ok) {
        if (quiet) return;
        throw new Error("connections_unavailable");
      }

      setOverview(nextOverview);
      setConnections((await connectionsResponse.json()) as ConnectionListItem[]);
      setStatus("ready");
    } catch {
      if (quiet) return;
      setOverview(null);
      setConnections([]);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    if (status !== "ready" || !token.trim()) return;

    const interval = window.setInterval(() => {
      void fetchOverview(token.trim(), true);
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [fetchOverview, status, token]);

  async function submitToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextToken = token.trim();
    if (!nextToken) {
      setStatus("locked");
      setOverview(null);
      setConnections([]);
      return;
    }

    await fetchOverview(nextToken);
  }

  return (
    <main className="min-h-screen bg-[#111111] text-[#eeeeea]">
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-6 sm:px-8">
        <div className="border-b border-[#2f3432] pb-4">
          <p className="text-sm text-[#bdb5a4]">不要把它优化成另一个让人停不下来的机器。</p>
          <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-2xl font-normal text-[#f7f2e7]">运营监控</h1>
              <p className="mt-2 text-xs text-[#8f9691]">{overview ? formatTimestamp(overview.generatedAt) : statusLabel(status)}</p>
            </div>
            <form className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end" onSubmit={submitToken}>
              <label className="flex min-w-64 flex-col gap-1 text-xs text-[#9da39e]" htmlFor="admin-token">
                Admin token
                <input
                  autoComplete="off"
                  className="h-10 border border-[#38403b] bg-[#171918] px-3 text-sm text-[#f0eee6] outline-none focus:border-[#8f9691]"
                  id="admin-token"
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
                {status === "loading" ? "连接中" : "连接"}
              </button>
            </form>
          </div>
          {status === "error" ? <p className="mt-3 text-sm text-[#f0b6a8]">unauthorized</p> : null}
        </div>

        <section aria-label="North star metrics" className="grid gap-3 md:grid-cols-5">
          <Metric
            label="完整一小时完成率"
            tone={overview && overview.oneHourCompletionRate < 0.3 ? "warn" : "ok"}
            value={overview ? formatPercent(overview.oneHourCompletionRate) : "-"}
          />
          <Metric
            label="有效相遇数"
            value={overview ? overview.closedConnections + overview.activeOrEndingConnections : "-"}
          />
          <Metric
            label="入口可达率"
            tone={overview && overview.reachableEntranceRate < 0.3 ? "warn" : "ok"}
            value={overview ? formatPercent(overview.reachableEntranceRate) : "-"}
          />
          <Metric
            label="当前匹配中"
            tone={overview && overview.currentMatchedUsers > 0 ? "ok" : "neutral"}
            value={overview ? overview.currentMatchedUsers : "-"}
          />
          <Metric
            label="当前等待"
            tone={overview && overview.waitingUsers > 0 ? "warn" : "neutral"}
            value={overview ? overview.waitingUsers : "-"}
          />
        </section>

        <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <Panel title="实时入口">
            <MetricTable
              rows={[
                ["当前扫码人数", valueOrDash(overview?.scannedUsers)],
                ["最近活跃人数", valueOrDash(overview?.recentUsers)],
                ["入口打开人数", valueOrDash(overview?.matchingEnabledUsers)],
                ["入口可匹配人数", valueOrDash(overview?.openUsers)],
                ["可随机匹配人数", valueOrDash(overview?.reachableUsers)],
                ["即将失联人数", valueOrDash(overview?.expiringReachabilityUsers)],
              ]}
            />
          </Panel>

          <Panel title="连接">
            <MetricTable
              rows={[
                ["active connections", valueOrDash(overview?.activeConnections)],
                ["ending connections", valueOrDash(overview?.endingConnections)],
                ["当前匹配中人数", valueOrDash(overview?.currentMatchedUsers)],
                ["已关闭连接", valueOrDash(overview?.closedConnections)],
                ["完整一小时关闭", valueOrDash(overview?.timeoutClosedConnections)],
                ["回声率", overview ? formatPercent(overview.echoRate) : "-"],
              ]}
            />
          </Panel>
        </div>

        <Panel title="连接列表">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left text-sm">
              <thead className="border-b border-[#2f3432] text-xs text-[#9da39e]">
                <tr>
                  <th className="px-4 py-3 font-normal">connection</th>
                  <th className="px-4 py-3 font-normal">state</th>
                  <th className="px-4 py-3 font-normal">started</th>
                  <th className="px-4 py-3 font-normal">closed</th>
                  <th className="px-4 py-3 font-normal">signals</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2a2f2c]">
                {connections.map((connection) => (
                  <tr key={connection.id}>
                    <td className="px-4 py-3">
                      <Link
                        className="font-mono text-xs text-[#f0eee6] underline-offset-4 transition hover:text-[#d4ccb9] hover:underline"
                        href={`/admin/connections/${connection.id}`}
                      >
                        {connection.id}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-[#f0eee6]">{connection.state}</td>
                    <td className="px-4 py-3 text-[#9da39e]">{formatTimestamp(connection.startedAt)}</td>
                    <td className="px-4 py-3 text-[#9da39e]">{connection.closedAt ? formatTimestamp(connection.closedAt) : "-"}</td>
                    <td className="px-4 py-3 text-[#9da39e]">
                      outbox {connection.outboxMessageCount} / reports {connection.reportCount} / echoes {connection.echoCount}
                    </td>
                  </tr>
                ))}
                {overview && connections.length === 0 ? (
                  <tr>
                    <td className="px-4 py-3 text-[#8f9691]" colSpan={5}>
                      no connections
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="服务健康">
            <MetricTable
              rows={[
                ["outbox pending", valueOrDash(overview?.outboxPending)],
                ["outbox sending", valueOrDash(overview?.outboxSending)],
                ["outbox retrying", valueOrDash(overview?.outboxRetrying)],
                ["provider window expired", valueOrDash(overview?.providerWindowExpiredCount)],
                ["scheduled job lag", overview ? formatLag(overview.scheduledJobLagSeconds) : "-"],
              ]}
            />
          </Panel>

          <Panel title="安全">
            <MetricTable
              rows={[
                ["reports total", valueOrDash(overview?.reportCount)],
                ["reports today", valueOrDash(overview?.reportsToday)],
                ["blocked users", valueOrDash(overview?.blockedUsers)],
                ["blocked today", valueOrDash(overview?.blockedToday)],
              ]}
            />
          </Panel>
        </div>
      </section>
    </main>
  );
}

function Metric(props: { label: string; value: number | string; tone?: "neutral" | "ok" | "warn" }) {
  const tone = props.tone ?? "neutral";
  const toneClass =
    tone === "ok"
      ? "border-[#3a6a4f] bg-[#142019] text-[#dff3df]"
      : tone === "warn"
        ? "border-[#76592d] bg-[#241b11] text-[#f4dfb8]"
        : "border-[#303532] bg-[#171918] text-[#eeeeea]";

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

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatLag(seconds: number): string {
  if (seconds <= 0) return "0s";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function statusLabel(status: DashboardStatus): string {
  if (status === "loading") return "loading";
  if (status === "error") return "unauthorized";
  if (status === "ready") return "live";
  return "locked";
}
