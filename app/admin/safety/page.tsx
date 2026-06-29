"use client";

import Link from "next/link";
import type { FormEvent } from "react";
import { useCallback, useState } from "react";
import type { SafetyMetrics } from "../../../src/workers/admin-details";

type PageStatus = "locked" | "loading" | "ready" | "unauthorized" | "error";

export default function AdminSafetyPage() {
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<PageStatus>("locked");
  const [safety, setSafety] = useState<SafetyMetrics | null>(null);

  const fetchSafety = useCallback(async (adminToken: string) => {
    setStatus("loading");

    try {
      const response = await fetch("/api/admin/safety", {
        cache: "no-store",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      if (response.status === 401 || response.status === 403) {
        setSafety(null);
        setStatus("unauthorized");
        return;
      }
      if (!response.ok) throw new Error("safety_unavailable");

      setSafety((await response.json()) as SafetyMetrics);
      setStatus("ready");
    } catch {
      setSafety(null);
      setStatus("error");
    }
  }, []);

  async function submitToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextToken = token.trim();
    if (!nextToken) {
      setSafety(null);
      setStatus("locked");
      return;
    }
    await fetchSafety(nextToken);
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
              <h1 className="text-2xl font-normal text-[#f7f2e7]">安全边界</h1>
              <p className="mt-2 text-xs text-[#8f9691]">{safety ? formatTimestamp(safety.generatedAt) : statusLabel(status)}</p>
            </div>
            <form className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end" onSubmit={submitToken}>
              <label className="flex min-w-64 flex-col gap-1 text-xs text-[#9da39e]" htmlFor="admin-safety-token">
                Admin token
                <input
                  autoComplete="off"
                  className="h-10 border border-[#38403b] bg-[#171918] px-3 text-sm text-[#f0eee6] outline-none focus:border-[#8f9691]"
                  id="admin-safety-token"
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
                {status === "loading" ? "连接中" : safety ? "刷新" : "连接"}
              </button>
            </form>
          </div>
          {status === "unauthorized" ? <p className="mt-3 text-sm text-[#f0b6a8]">unauthorized</p> : null}
          {status === "error" ? <p className="mt-3 text-sm text-[#f0b6a8]">safety unavailable</p> : null}
        </header>

        <section className="grid gap-3 md:grid-cols-4">
          <Metric label="reports" value={valueOrDash(safety?.totalReports)} />
          <Metric label="blocked users" tone={safety && safety.blockedUsers > 0 ? "warn" : "neutral"} value={valueOrDash(safety?.blockedUsers)} />
          <Metric
            label="near block"
            tone={safety && safety.nearBlockReportedUserCount > 0 ? "warn" : "neutral"}
            value={valueOrDash(safety?.nearBlockReportedUserCount)}
          />
          <Metric label="block threshold" value={valueOrDash(safety?.nearBlockThreshold)} />
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Reports">
            <MetricTable rows={(safety?.reportsByReason ?? []).map((row) => [row.reason, row.count])} empty={!safety || safety.reportsByReason.length === 0} />
          </Panel>

          <Panel title="Connection close reasons">
            <MetricTable
              rows={[
                ["timeout", valueOrDash(safety?.connectionCloseReasons.timeout)],
                ["left", valueOrDash(safety?.connectionCloseReasons.left)],
                ["reported", valueOrDash(safety?.connectionCloseReasons.reported)],
                ["provider expired", valueOrDash(safety?.connectionCloseReasons.providerExpired)],
              ]}
            />
          </Panel>
        </div>

        <Panel title="Near-block anonymous users">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-left text-sm">
              <thead className="border-b border-[#2f3432] text-xs text-[#9da39e]">
                <tr>
                  <th className="px-4 py-3 font-normal">anonymous id</th>
                  <th className="px-4 py-3 font-normal">report count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2a2f2c]">
                {(safety?.nearBlockReportedUsers ?? []).map((user) => (
                  <tr key={user.anonymousId}>
                    <td className="px-4 py-3 font-mono text-xs text-[#f0eee6]">{user.anonymousId}</td>
                    <td className="px-4 py-3 text-[#f0eee6]">{user.reportCount}</td>
                  </tr>
                ))}
                {safety && safety.nearBlockReportedUsers.length === 0 ? (
                  <tr>
                    <td className="px-4 py-3 text-[#8f9691]" colSpan={2}>
                      no near-block users
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

function MetricTable(props: { rows: Array<[string, number | string]>; empty?: boolean }) {
  if (props.empty) return <p className="px-4 py-3 text-sm text-[#8f9691]">no data</p>;

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
