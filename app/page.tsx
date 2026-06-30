"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";

type QrResponse = {
  provider: "openclaw-weixin";
  mode: "fake" | "openclaw";
  sessionId: string;
  status: string;
  expiresAt: string;
  qr: {
    imageSrc: string;
    payloadUrl: string;
  };
  statusUrl: string;
};

type RelayInviteResponse = {
  inviteId: string;
  state: "a_qr_issued";
  aQr: QrResponse;
};

type RelayStatusResponse = {
  state:
    | "a_waiting_to_scan"
    | "a_scan_confirming"
    | "a_bound"
    | "waiting_for_b_scan"
    | "b_qr_expired"
    | "connected"
    | "closed"
    | "expired";
  canIssuePeerQr?: boolean;
};

type RelayPeerQrResponse = {
  state: "waiting_for_b_scan";
  bQr: QrResponse;
};

type RelayStage =
  | "idle"
  | "creating"
  | "a_waiting_to_scan"
  | "a_scan_confirming"
  | "a_bound"
  | "issuing_b_qr"
  | "waiting_for_b_scan"
  | "b_qr_expired"
  | "connected"
  | "closed"
  | "expired"
  | "error";

type Locale = "zh" | "en";

const githubUrl = "https://github.com/samwang0041-star/whoareyou";
const contactEmail = "samwang0041@gmail.com";

const copy = {
  zh: {
    switchAria: "Switch to English",
    switchLabel: "EN",
    product: "UNKNOWN RELAY",
    eyebrow: "披着 AI 入口的 1 对 1 隐身转发",
    intro: "生成一张入口图。A 先扫。入口认得 A 之后，会出现另一张图。",
    intro2: "把那张图交给 B。B 扫进来，你们就在同一个微信 AI 入口里说话。发 /断开，关系会消失。",
    ctaIdle: "生成入口",
    ctaLoading: "生成中",
    reset: "重新生成",
    github: "GitHub",
    footer: "开源。不保存昵称、头像、手机号或明文聊天。只是一次很小的转发实验。",
    contactPrefix: "如有侵权或不适，联系",
    contactSuffix: "，我会关闭本网站。",
    states: {
      idleTitle: "先生成 A 的入口",
      idleBody: "这不是聊天室注册，也不是好友关系。它只会为这一次连接准备两张入口图。",
      aWaitingTitle: "先让 A 扫这张入口图",
      aWaitingBody: "A 扫进去之前，B 的入口不会出现。真正的流程从 A 被认出来之后开始。",
      aConfirmingTitle: "A 已经靠近",
      aConfirmingBody: "微信确认可能慢一点。这里会等它亮起，不需要重复点击。",
      aBoundTitle: "A 已经接入",
      aBoundBody: "正在生成另一张入口图。它只属于这次连接。",
      issuingTitle: "正在生成 B 的入口图",
      issuingBody: "不要着急。微信的二维码有时会慢几秒。",
      bWaitingTitle: "把这张图交给 B",
      bWaitingBody: "不是分享按钮，是一张只属于这次连接的入口图。",
      bWaitingMobile: "让 B 长按识别这张入口图",
      bWaitingDesktop: "让 B 用微信扫一扫这张入口图",
      gap: "等 B 扫进来",
      connectedTitle: "已经接通",
      connectedBody: "回到微信说话。发 /断开，关系会消失。",
      expiredTitle: "入口过期了",
      expiredBody: "二维码只有很短的有效时间。重新生成一组入口图。",
      closedTitle: "连接已经消失",
      closedBody: "如果还想继续，需要重新生成、重新扫码、重新交给对方。",
      errorTitle: "入口没有生成",
      errorBody: "等一会儿再试。这个实验接受失败，但不应该让你困在这里。",
    },
  },
  en: {
    switchAria: "切换到中文",
    switchLabel: "中",
    product: "UNKNOWN RELAY",
    eyebrow: "a hidden 1:1 relay wearing an AI entrance",
    intro: "Generate an entrance image. A scans first. Only after A is recognized does the second image appear.",
    intro2: "Give that image to B. When B scans it, both sides speak through the same WeChat AI entrance. Send /断开 and the relation disappears.",
    ctaIdle: "Generate",
    ctaLoading: "Generating",
    reset: "Generate again",
    github: "GitHub",
    footer: "Open source. No nicknames, avatars, phone numbers, or readable chat history. Just a small relay experiment.",
    contactPrefix: "If this infringes your rights, contact",
    contactSuffix: "and I will close the site.",
    states: {
      idleTitle: "Generate A's entrance first",
      idleBody: "This is not chat registration or a friend relation. It only prepares two entrance images for this one connection.",
      aWaitingTitle: "Let A scan this entrance image",
      aWaitingBody: "B's entrance will not appear before A is recognized. The real flow starts after A is known.",
      aConfirmingTitle: "A is close",
      aConfirmingBody: "WeChat confirmation can lag. This page will wait for it.",
      aBoundTitle: "A is connected",
      aBoundBody: "Generating the second entrance image. It belongs only to this connection.",
      issuingTitle: "Generating B's entrance image",
      issuingBody: "Do not rush it. WeChat QR generation can take a few seconds.",
      bWaitingTitle: "Give this image to B",
      bWaitingBody: "This is not a share button. It is an entrance image that belongs only to this connection.",
      bWaitingMobile: "Ask B to long-press this entrance image",
      bWaitingDesktop: "Ask B to scan this entrance image with WeChat",
      gap: "Waiting for B to scan",
      connectedTitle: "Connected",
      connectedBody: "Return to WeChat. Send /断开 and the relation disappears.",
      expiredTitle: "The entrance expired",
      expiredBody: "QR codes only live briefly. Generate a fresh pair.",
      closedTitle: "The connection disappeared",
      closedBody: "To continue, generate again, scan again, and hand a new image to the other side.",
      errorTitle: "The entrance was not generated",
      errorBody: "Wait a moment and try again. This experiment can fail, but it should not trap you.",
    },
  },
} as const;

function secondsUntilExpiry(expiresAt: string | null) {
  if (!expiresAt) return null;
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) return null;
  return Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000));
}

function formatRemaining(seconds: number | null) {
  if (seconds === null) return "";
  const minutes = Math.floor(seconds / 60);
  const nextSeconds = seconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${nextSeconds.toString().padStart(2, "0")}`;
}

export default function HomePage() {
  const [locale, setLocale] = useState<Locale>("zh");
  const [stage, setStage] = useState<RelayStage>("idle");
  const [inviteId, setInviteId] = useState<string | null>(null);
  const [aQr, setAQr] = useState<QrResponse | null>(null);
  const [bQr, setBQr] = useState<QrResponse | null>(null);
  const [isIssuingPeerQr, setIsIssuingPeerQr] = useState(false);
  const [isCompactViewport, setIsCompactViewport] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const t = copy[locale];
  const nextLocale: Locale = locale === "zh" ? "en" : "zh";

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const updateViewport = () => setIsCompactViewport(query.matches);
    updateViewport();
    query.addEventListener("change", updateViewport);
    return () => query.removeEventListener("change", updateViewport);
  }, []);

  const issuePeerQr = useCallback(async (id: string) => {
    setIsIssuingPeerQr(true);
    setStage("issuing_b_qr");
    try {
      const response = await fetch(`/api/relay/invites/${id}/peer-qr`, {
        method: "POST",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("peer_qr_failed");
      const data = (await response.json()) as RelayPeerQrResponse;
      setBQr(data.bQr);
      setStage("waiting_for_b_scan");
    } catch {
      setStage("error");
    } finally {
      setIsIssuingPeerQr(false);
    }
  }, []);

  useEffect(() => {
    if (!inviteId || stage === "idle" || stage === "creating" || stage === "connected" || stage === "closed" || stage === "expired" || stage === "error") {
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    async function poll() {
      if (!inviteId) return;
      try {
        const response = await fetch(`/api/relay/invites/${inviteId}/status`, { cache: "no-store" });
        if (!response.ok) throw new Error("status_failed");
        const data = (await response.json()) as RelayStatusResponse;
        if (cancelled) return;

        if (data.state === "a_bound") {
          setStage("a_bound");
          if (!bQr && !isIssuingPeerQr) {
            await issuePeerQr(inviteId);
          }
        } else {
          setStage(data.state);
        }

        if (!cancelled && data.state !== "connected" && data.state !== "closed" && data.state !== "expired") {
          timer = window.setTimeout(poll, 1_500);
        }
      } catch {
        if (!cancelled) setStage("error");
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [bQr, inviteId, isIssuingPeerQr, issuePeerQr, stage]);

  useEffect(() => {
    const expiresAt = bQr?.expiresAt ?? aQr?.expiresAt ?? null;
    if (!expiresAt || stage === "idle" || stage === "connected" || stage === "closed" || stage === "error") {
      return;
    }

    const tick = () => {
      const nextRemaining = secondsUntilExpiry(expiresAt);
      setRemainingSeconds(nextRemaining);
      if (nextRemaining === 0) setStage("expired");
    };
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [aQr?.expiresAt, bQr?.expiresAt, stage]);

  async function startRelay() {
    setStage("creating");
    setInviteId(null);
    setAQr(null);
    setBQr(null);
    setRemainingSeconds(null);

    try {
      const response = await fetch("/api/relay/invites", {
        method: "POST",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("invite_failed");
      const data = (await response.json()) as RelayInviteResponse;
      setInviteId(data.inviteId);
      setAQr(data.aQr);
      setStage("a_waiting_to_scan");
    } catch {
      setStage("error");
    }
  }

  const stateCopy = stage === "creating"
    ? { title: t.states.idleTitle, body: t.states.idleBody }
    : stage === "a_waiting_to_scan"
      ? { title: t.states.aWaitingTitle, body: t.states.aWaitingBody }
      : stage === "a_scan_confirming"
        ? { title: t.states.aConfirmingTitle, body: t.states.aConfirmingBody }
        : stage === "a_bound"
          ? { title: t.states.aBoundTitle, body: t.states.aBoundBody }
          : stage === "issuing_b_qr"
            ? { title: t.states.issuingTitle, body: t.states.issuingBody }
            : stage === "waiting_for_b_scan"
              ? { title: t.states.bWaitingTitle, body: t.states.bWaitingBody }
              : stage === "connected"
                ? { title: t.states.connectedTitle, body: t.states.connectedBody }
                : stage === "expired" || stage === "b_qr_expired"
                  ? { title: t.states.expiredTitle, body: t.states.expiredBody }
                  : stage === "closed"
                    ? { title: t.states.closedTitle, body: t.states.closedBody }
                    : stage === "error"
                      ? { title: t.states.errorTitle, body: t.states.errorBody }
                      : { title: t.states.idleTitle, body: t.states.idleBody };

  const canStart = stage !== "creating" && stage !== "issuing_b_qr";
  const showReset = stage === "expired" || stage === "b_qr_expired" || stage === "closed" || stage === "error";
  const shouldShowCountdown =
    remainingSeconds !== null &&
    (stage === "a_waiting_to_scan" ||
      stage === "a_scan_confirming" ||
      stage === "a_bound" ||
      stage === "issuing_b_qr" ||
      stage === "waiting_for_b_scan" ||
      stage === "b_qr_expired" ||
      stage === "expired");

  return (
    <main className="relative min-h-[100svh] overflow-hidden bg-[#0c0b10] text-[#f7f1e8]">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 h-[100svh]">
        <Image
          alt=""
          className="object-cover object-[52%_center] brightness-110 saturate-110"
          data-testid="hero-main-visual"
          fill
          priority
          sizes="100vw"
          src="/whoareyou-main-visual-abstract.png"
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,#0c0b10_0%,rgba(12,11,16,0.92)_32%,rgba(12,11,16,0.52)_58%,rgba(12,11,16,0.16)_100%)]" />
        <div className="absolute inset-x-0 bottom-0 h-64 bg-[linear-gradient(180deg,rgba(12,11,16,0)_0%,#0c0b10_92%)]" />
      </div>

      <section className="relative z-10 mx-auto grid min-h-[100svh] w-full max-w-6xl grid-rows-[auto_1fr_auto] px-6 py-7 sm:px-10 sm:py-10">
        <header className="flex items-center justify-between gap-5 text-xs text-[#9b9388]">
          <span>{t.eyebrow}</span>
          <div className="flex items-center gap-4">
            <a className="transition hover:text-[#fff8ed]" href={githubUrl} rel="noreferrer" target="_blank">
              {t.github}
            </a>
            <button
              aria-label={t.switchAria}
              className="border border-[#f7f1e8]/20 px-3 py-1 text-[#d7cab8] transition hover:border-[#f7f1e8]/45 hover:text-[#fff8ed]"
              onClick={() => setLocale(nextLocale)}
              type="button"
            >
              {t.switchLabel}
            </button>
          </div>
        </header>

        <div className="grid items-center gap-10 py-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(360px,0.75fr)]">
          <section className="max-w-2xl">
            <h1 className="text-5xl font-normal leading-none text-[#fff8ed] sm:text-7xl md:text-8xl">
              {t.product}
            </h1>
            <p className="mt-7 max-w-xl text-xl leading-8 text-[#eadfce] sm:text-2xl sm:leading-9">
              {t.intro}
            </p>
            <p className="mt-4 max-w-xl text-sm leading-7 text-[#b8aa96] sm:text-base">
              {t.intro2}
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                className="h-12 w-full border border-[#f7f1e8]/55 px-7 text-base text-[#fff8ed] transition hover:border-[#fff8ed] hover:bg-[#fff8ed]/5 disabled:cursor-wait disabled:opacity-60 sm:w-auto"
                disabled={!canStart}
                onClick={startRelay}
                type="button"
              >
                {stage === "creating" ? t.ctaLoading : showReset ? t.reset : t.ctaIdle}
              </button>
              <span className="text-sm leading-6 text-[#9b9388]">
                {shouldShowCountdown ? `QR ${formatRemaining(remainingSeconds)}` : "one connection"}
              </span>
            </div>
          </section>

          <section className="border border-[#f7f1e8]/24 bg-[#0f0d14]/78 p-5 shadow-2xl shadow-black/25 backdrop-blur-md sm:p-6">
            <div className="flex items-start justify-between gap-5 border-b border-[#f7f1e8]/16 pb-4">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-[#9b9388]">relay state</p>
                <h2 className="mt-3 text-2xl font-normal text-[#fff8ed]">{stateCopy.title}</h2>
              </div>
              <span className="border border-[#f7f1e8]/20 px-3 py-1 text-xs text-[#d7cab8]">
                {stage.replaceAll("_", " ")}
              </span>
            </div>

            <p className="mt-5 min-h-12 text-sm leading-7 text-[#c7baa8]">{stateCopy.body}</p>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <QrPanel
                alt="A entry QR"
                imageSrc={aQr?.qr.imageSrc}
                label="A"
                testId="relay-a-qr"
                title={t.states.aWaitingTitle}
              />
              <QrPanel
                alt="B entry QR"
                imageSrc={bQr?.qr.imageSrc}
                label="B"
                testId="relay-b-qr"
                title={isCompactViewport ? t.states.bWaitingMobile : t.states.bWaitingDesktop}
              />
            </div>

            {stage === "waiting_for_b_scan" ? (
              <div className="mt-5 border-t border-[#f7f1e8]/16 pt-4">
                <p className="text-base text-[#fff8ed]">{t.states.bWaitingTitle}</p>
                <p className="mt-2 text-sm leading-6 text-[#b8aa96]">{t.states.bWaitingBody}</p>
                <p className="mt-3 text-sm text-[#d7cab8]">{t.states.gap}</p>
              </div>
            ) : null}

            {stage === "connected" ? (
              <div className="mt-5 border border-[#f7f1e8]/24 px-4 py-4">
                <p className="text-xl text-[#fff8ed]">{t.states.connectedTitle}</p>
                <p className="mt-2 text-sm leading-6 text-[#d7cab8]">{t.states.connectedBody}</p>
              </div>
            ) : null}
          </section>
        </div>

        <footer className="flex flex-col gap-2 border-t border-[#f7f1e8]/16 pt-5 text-xs leading-6 text-[#8d8478] sm:flex-row sm:items-center sm:justify-between">
          <span>{t.footer}</span>
          <span>
            {t.contactPrefix}{" "}
            <a className="text-[#d7cab8] hover:text-[#fff8ed]" href={`mailto:${contactEmail}`}>
              {contactEmail}
            </a>
            {locale === "zh" ? t.contactSuffix : ` ${t.contactSuffix}`}
          </span>
        </footer>
      </section>
    </main>
  );
}

function QrPanel(input: {
  alt: string;
  imageSrc?: string;
  label: string;
  testId: string;
  title: string;
}) {
  return (
    <div className="min-h-64 border border-[#f7f1e8]/18 p-4">
      <div className="flex items-center justify-between text-xs text-[#9b9388]">
        <span>{input.label}</span>
        <span>{input.imageSrc ? "ready" : "waiting"}</span>
      </div>
      <div className="mt-4 flex aspect-square items-center justify-center bg-[#fffaf3] p-3">
        {input.imageSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt={input.alt}
            className="h-full w-full object-contain"
            data-testid={input.testId}
            src={input.imageSrc}
          />
        ) : (
          <div className="h-full w-full border border-dashed border-[#0c0b10]/20" />
        )}
      </div>
      <p className="mt-4 text-sm leading-6 text-[#d7cab8]">{input.title}</p>
    </div>
  );
}
