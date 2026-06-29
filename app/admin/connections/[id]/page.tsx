"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { FormEvent } from "react";
import { useCallback, useState } from "react";
import type { ConnectionDetail } from "../../../../src/workers/admin-details";

type PageStatus = "locked" | "loading" | "ready" | "unauthorized" | "not_found" | "error";

export default function AdminConnectionDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<PageStatus>("locked");
  const [detail, setDetail] = useState<ConnectionDetail | null>(null);

  const fetchDetail = useCallback(async (adminToken: string) => {
    setStatus("loading");

    try {
      const response = await fetch(`/api/admin/connections/${encodeURIComponent(id)}`, {
        cache: "no-store",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      if (response.status === 401 || response.status === 403) {
        setDetail(null);
        setStatus("unauthorized");
        return;
      }
      if (response.status === 404) {
        setDetail(null);
        setStatus("not_found");
        return;
      }
      if (!response.ok) throw new Error("connection_unavailable");

      setDetail((await response.json()) as ConnectionDetail);
      setStatus("ready");
    } catch {
      setDetail(null);
      setStatus("error");
    }
  }, [id]);

  async function submitToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextToken = token.trim();
    if (!nextToken) {
      setDetail(null);
      setStatus("locked");
      return;
    }
    await fetchDetail(nextToken);
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
              <h1 className="break-all text-2xl font-normal text-[#f7f2e7]">连接 {id}</h1>
              <p className="mt-2 text-xs text-[#8f9691]">{detail ? detail.state : statusLabel(status)}</p>
            </div>
            <form className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end" onSubmit={submitToken}>
              <label className="flex min-w-64 flex-col gap-1 text-xs text-[#9da39e]" htmlFor="admin-connection-token">
                Admin token
                <input
                  autoComplete="off"
                  className="h-10 border border-[#38403b] bg-[#171918] px-3 text-sm text-[#f0eee6] outline-none focus:border-[#8f9691]"
                  id="admin-connection-token"
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
                {status === "loading" ? "连接中" : detail ? "刷新" : "连接"}
              </button>
            </form>
          </div>
          {status === "unauthorized" ? <p className="mt-3 text-sm text-[#f0b6a8]">unauthorized</p> : null}
          {status === "not_found" ? <p className="mt-3 text-sm text-[#f0b6a8]">connection not found</p> : null}
          {status === "error" ? <p className="mt-3 text-sm text-[#f0b6a8]">connection unavailable</p> : null}
        </header>

        <section className="grid gap-3 md:grid-cols-4">
          <Metric label="state" value={detail?.state ?? "-"} />
          <Metric label="outbox backlog" value={valueOrDash(detail?.outboxSummary.backlog)} />
          <Metric label="reports" tone={detail && detail.reportCount > 0 ? "warn" : "neutral"} value={valueOrDash(detail?.reportCount)} />
          <Metric label="echoes" value={valueOrDash(detail?.echoCount)} />
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Participants">
            <MetricTable
              rows={(detail?.participants ?? []).map((participant) => [
                `${participant.role} / ${participant.anonymousId}`,
                `${participant.state} / ${participant.matchingEnabled ? "open" : "closed"}`,
              ])}
              empty={!detail}
            />
          </Panel>

          <Panel title="Timeline">
            <MetricTable
              rows={[
                ["started", detail ? formatTimestamp(detail.startedAt) : "-"],
                ["ending", detail?.endingAt ? formatTimestamp(detail.endingAt) : "-"],
                ["closed", detail?.closedAt ? formatTimestamp(detail.closedAt) : "-"],
                ["close reason", detail?.closeReason ?? "-"],
              ]}
            />
          </Panel>
        </div>

        <Panel title="Outbox summary">
          <MetricTable
            rows={[
              ["pending", valueOrDash(detail?.outboxSummary.pending)],
              ["retrying", valueOrDash(detail?.outboxSummary.retrying)],
              ["sending", valueOrDash(detail?.outboxSummary.sending)],
              ["sent", valueOrDash(detail?.outboxSummary.sent)],
              ["failed", valueOrDash(detail?.outboxSummary.failed)],
              ["provider window expired", valueOrDash(detail?.outboxSummary.providerWindowExpired)],
            ]}
          />
        </Panel>

        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="Scheduled jobs">
            <MetricTable
              rows={(detail?.scheduledJobs ?? []).slice(0, 8).map((job) => [`${job.type} / ${job.status}`, formatTimestamp(job.runAt)])}
              empty={!detail || detail.scheduledJobs.length === 0}
            />
          </Panel>

          <Panel title="Reports">
            <MetricTable
              rows={(detail?.reports ?? []).slice(0, 8).map((report) => [`${report.reporterAnonymousId} -> ${report.reportedAnonymousId}`, report.reason])}
              empty={!detail || detail.reports.length === 0}
            />
          </Panel>

          <Panel title="Echoes">
            <MetricTable
              rows={(detail?.echoes ?? []).slice(0, 8).map((echo) => [`${echo.fromAnonymousId} -> ${echo.toAnonymousId}`, formatTimestamp(echo.createdAt)])}
              empty={!detail || detail.echoes.length === 0}
            />
          </Panel>
        </div>
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
      <p className="mt-3 break-all text-2xl font-normal tabular-nums">{props.value}</p>
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
          <dt className="break-all text-sm text-[#9da39e]">{label}</dt>
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
  if (status === "not_found") return "not found";
  if (status === "error") return "error";
  if (status === "ready") return "live";
  return "locked";
}
