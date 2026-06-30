"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";

type QrResponse = {
  provider: "openclaw-weixin";
  mode: "fake" | "openclaw";
  sessionId: string;
  status: QrStatus;
  expiresAt: string;
  qr: {
    imageSrc: string;
    payloadUrl: string;
  };
  statusUrl: string;
};

type QrStatus =
  | "waiting_to_scan"
  | "scan_confirming"
  | "confirmed"
  | "verification_required"
  | "expired"
  | "provider_error";
type QrPhase = "idle" | "loading" | "ready" | "expired" | "connected" | "error";
type ConnectedEntry = {
  provider: QrResponse["provider"];
  mode: QrResponse["mode"];
  connectedAt: string;
  expiresAt: string;
};
type QrStatusResponse = Pick<QrResponse, "expiresAt" | "sessionId"> & {
  status: unknown;
};
type Locale = "zh" | "en";

const githubUrl = "https://github.com/samwang0041-star/whoareyou";
const contactEmail = "12191628@qq.com";
const pageCopy = {
  zh: {
    localeName: "中文",
    switchLabel: "EN",
    switchAria: "Switch to English",
    topLine: "一个 AI 爱好者的小玩具",
    hour: "one hour",
    title: "UNKNOWN",
    lead: "你以为又要接入一个 agent。\n这一次，入口后面只是一个人。",
    subLead: "扫码，把这个微信入口留给一个也停下来的人。也许没有结论，但会有一小时是真的。",
    enterIdle: "进入",
    enterLoading: "入口亮起中",
    enterConnected: "入口已亮",
    enterHelper: "扫码后，回到微信发「打开」。",
    connectedHelper: "回到微信，发「打开」。",
    sideNote: "不是匿名社交，也不是一个新社区。只是 vibe coding 太久以后，做出来的一个开源小玩具。",
    whyTitle: "为什么做这个",
    whyLeft:
      "AI 时代，我们不停地和 AI 对话。五小时窗口、week 窗口、token 焦虑，像一条看不见的倒计时，把人推着往前走。",
    whyRight:
      "AI 工具一天迭代 N 个版本，我们仿佛成了给它们做回归测试的人。工具越来越快，时间却越来越不够用。",
    whyEnd:
      "所以这一次，还是同一个入口，还是扫码，还是在微信里说话。但入口后面不是一个永远在线的模型，而是另一个也停下来的人。",
    footerLine:
      "开源，不保存昵称、头像、手机号或明文聊天记录。只是想在 vibe coding 这么久后，真的做一个自己觉得有意思的产品。",
    github: "GitHub",
    experience: "体验入口",
    contactPrefix: "如有侵权，联系",
    contactSuffix: "，我会关闭本网站。",
    modal: {
      errorTitle: "入口没有亮起",
      localTitle: "入口预演",
      wechatTitle: "微信里见",
      connected: "已经靠近。",
      known: "我知道了",
      rescan: "重新扫码",
      loading: "入口亮起中...",
      loadingSr: "入口亮起中",
      expiredPrompt: "这一盏已经熄了",
      scanConfirmingPrompt: "回到微信，发「打开」",
      verificationPrompt: "微信里还有一步",
      providerErrorPrompt: "入口卡住了",
      localPrompt: "本地预演入口",
      realPrompt: "用微信扫一扫",
      expiredHelper: "换一个二维码，再用微信扫一次。",
      scanConfirmingHelper: "发出那两个字，入口会亮起来。",
      verificationHelper: "照着微信里的提示走。",
      providerErrorHelper: "换一个二维码，再试一次。",
      localHelper: "这不是微信服务器二维码，只用于本地模拟扫码。",
      realHelper: "扫完，回到微信发「打开」。",
      expiredStatus: "已熄灭",
      waitingStatus: "等你靠近",
      scanConfirmingStatus: "等你开口",
      verificationStatus: "等你回来",
      providerErrorStatus: "需要重开",
      readyStatus: "入口已亮起",
      qrAltLocal: "本地预演二维码",
      qrAltReal: "微信二维码",
      refreshQr: "换一个二维码",
      errorBody: "入口暂时没有亮起来。",
      errorHelp: "等一会儿，再靠近一次。",
      retry: "再试一次",
      close: "关闭入口",
    },
  },
  en: {
    localeName: "English",
    switchLabel: "中",
    switchAria: "切换到中文",
    topLine: "a small toy by an AI hobbyist",
    hour: "one hour",
    title: "UNKNOWN",
    lead: "You think this is another agent endpoint.\nThis time, there is only a person behind it.",
    subLead: "Scan with WeChat and leave the entrance open for someone else who also stopped. It may not solve anything, but the hour is real.",
    enterIdle: "Enter",
    enterLoading: "Lighting up",
    enterConnected: "Entrance lit",
    enterHelper: "After scanning, return to WeChat and send “打开”.",
    connectedHelper: "Return to WeChat and send “打开”.",
    sideNote: "Not anonymous social networking, not a new community. Just a small open-source toy made after too much vibe coding.",
    whyTitle: "Why this exists",
    whyLeft:
      "In the AI era, we keep talking to models. Five-hour windows, week windows, token anxiety, and context limits become a quiet countdown.",
    whyRight:
      "AI tools iterate many times a day. We start to feel like regression testers for the tools that were supposed to help us.",
    whyEnd:
      "So this uses the same entrance, the same scan, and the same WeChat conversation. But behind it is not an always-online model. It is someone else who stopped.",
    footerLine:
      "Open source. No nicknames, avatars, phone numbers, or readable chat history are stored. I just wanted to build something personally interesting after a long stretch of vibe coding.",
    github: "GitHub",
    experience: "Try it",
    contactPrefix: "If this infringes your rights, contact",
    contactSuffix: "and I will close the site.",
    modal: {
      errorTitle: "The entrance did not light up",
      localTitle: "Local preview",
      wechatTitle: "See you in WeChat",
      connected: "You are close.",
      known: "Got it",
      rescan: "Scan again",
      loading: "Lighting the entrance...",
      loadingSr: "Lighting the entrance",
      expiredPrompt: "This one has gone out",
      scanConfirmingPrompt: "Return to WeChat and send “打开”",
      verificationPrompt: "One more step in WeChat",
      providerErrorPrompt: "The entrance got stuck",
      localPrompt: "Local preview entrance",
      realPrompt: "Scan with WeChat",
      expiredHelper: "Get a new QR code and scan again.",
      scanConfirmingHelper: "Send those two characters and the entrance will light up.",
      verificationHelper: "Follow the prompt in WeChat.",
      providerErrorHelper: "Get a new QR code and try again.",
      localHelper: "This is not a WeChat server QR code. It is only for local simulation.",
      realHelper: "After scanning, return to WeChat and send “打开”.",
      expiredStatus: "Expired",
      waitingStatus: "Waiting",
      scanConfirmingStatus: "Waiting for words",
      verificationStatus: "Waiting for return",
      providerErrorStatus: "Needs reset",
      readyStatus: "Entrance lit",
      qrAltLocal: "Local preview QR code",
      qrAltReal: "WeChat QR code",
      refreshQr: "New QR code",
      errorBody: "The entrance did not light up.",
      errorHelp: "Wait a moment, then come close again.",
      retry: "Try again",
      close: "Close entrance",
    },
  },
} as const;

const CONNECTED_ENTRY_COOKIE = "whoareyou_entry_connected";
const CONNECTED_ENTRY_MAX_AGE_SECONDS = 24 * 60 * 60;
function isConnectedEntry(value: unknown): value is ConnectedEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ConnectedEntry>;
  if (candidate.provider !== "openclaw-weixin") return false;
  if (candidate.mode !== "fake" && candidate.mode !== "openclaw") return false;
  if (typeof candidate.connectedAt !== "string") return false;
  if (typeof candidate.expiresAt !== "string") return false;
  return !Number.isNaN(Date.parse(candidate.expiresAt));
}

function clearConnectedEntryCookie() {
  document.cookie = `${CONNECTED_ENTRY_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
}

function readConnectedEntryCookie() {
  const rawCookie = document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(`${CONNECTED_ENTRY_COOKIE}=`));
  if (!rawCookie) return null;

  try {
    const [, rawValue] = rawCookie.split("=");
    const parsed = JSON.parse(decodeURIComponent(rawValue ?? ""));
    if (!isConnectedEntry(parsed)) {
      clearConnectedEntryCookie();
      return null;
    }
    if (Date.parse(parsed.expiresAt) <= Date.now()) {
      clearConnectedEntryCookie();
      return null;
    }
    return parsed;
  } catch {
    clearConnectedEntryCookie();
    return null;
  }
}

function writeConnectedEntryCookie(entry: ConnectedEntry) {
  document.cookie = `${CONNECTED_ENTRY_COOKIE}=${encodeURIComponent(
    JSON.stringify(entry),
  )}; Max-Age=${CONNECTED_ENTRY_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
}

function buildConnectedEntry(source: QrResponse): ConnectedEntry {
  const connectedAt = new Date();
  const expiresAt = new Date(
    connectedAt.getTime() + CONNECTED_ENTRY_MAX_AGE_SECONDS * 1_000,
  );
  return {
    provider: source.provider,
    mode: source.mode,
    connectedAt: connectedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

function secondsUntilExpiry(expiresAt: string) {
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) return 0;
  return Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000));
}

function formatRemaining(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const nextSeconds = seconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${nextSeconds.toString().padStart(2, "0")}`;
}

function normalizeQrStatus(status: unknown): QrStatus {
  if (
    status === "waiting_to_scan" ||
    status === "scan_confirming" ||
    status === "confirmed" ||
    status === "verification_required" ||
    status === "expired" ||
    status === "provider_error"
  ) {
    return status;
  }

  if (status === "scaned") return "scan_confirming";

  return "provider_error";
}

export default function HomePage() {
  const [locale, setLocale] = useState<Locale>("zh");
  const [entryQr, setEntryQr] = useState<QrResponse | null>(null);
  const [phase, setPhase] = useState<QrPhase>("idle");
  const [qrStatus, setQrStatus] = useState<QrStatus | null>(null);
  const [connectedEntry, setConnectedEntry] = useState<ConnectedEntry | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [isReady, setIsReady] = useState(false);
  const t = pageCopy[locale];
  const modalCopy = t.modal;
  const nextLocale: Locale = locale === "zh" ? "en" : "zh";

  useEffect(() => {
    const readyTimer = window.setTimeout(() => {
      setConnectedEntry(readConnectedEntryCookie());
      setIsReady(true);
    }, 0);
    return () => window.clearTimeout(readyTimer);
  }, []);

  const markEntryConnected = useCallback((source: QrResponse) => {
    const nextConnectedEntry = buildConnectedEntry(source);
    writeConnectedEntryCookie(nextConnectedEntry);
    setConnectedEntry(nextConnectedEntry);
    setQrStatus("confirmed");
    setRemainingSeconds(null);
    setPhase("connected");
  }, []);

  const recordProviderError = useCallback(() => {
    setQrStatus("provider_error");
  }, []);

  useEffect(() => {
    if (!isModalOpen || !entryQr || phase !== "ready") return;

    let isCancelled = false;
    let timer: number | null = null;

    async function pollStatus() {
      if (!entryQr) return;
      let shouldContinuePolling = true;
      if (secondsUntilExpiry(entryQr.expiresAt) === 0) {
        setPhase("expired");
        setQrStatus("expired");
        shouldContinuePolling = false;
        return;
      }

      try {
        const response = await fetch(entryQr.statusUrl, { cache: "no-store" });
        const data = (await response.json()) as QrStatusResponse;
        if (isCancelled) return;
        if (!response.ok) {
          shouldContinuePolling = false;
          recordProviderError();
          return;
        }
        const nextStatus = normalizeQrStatus(data.status);
        setQrStatus(nextStatus);
        if (nextStatus === "provider_error") {
          shouldContinuePolling = false;
        }
        if (nextStatus === "confirmed") {
          shouldContinuePolling = false;
          markEntryConnected(entryQr);
        }
        if (nextStatus === "expired") {
          shouldContinuePolling = false;
          setPhase("expired");
        }
      } catch {
        shouldContinuePolling = false;
        if (!isCancelled) recordProviderError();
      } finally {
        if (!isCancelled && shouldContinuePolling) {
          timer = window.setTimeout(pollStatus, 3_000);
        }
      }
    }

    void pollStatus();
    return () => {
      isCancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [entryQr, isModalOpen, markEntryConnected, phase, recordProviderError]);

  useEffect(() => {
    if (!isModalOpen || !entryQr || (phase !== "ready" && phase !== "expired")) return;

    function tick() {
      if (!entryQr) return;
      const nextRemainingSeconds = secondsUntilExpiry(entryQr.expiresAt);
      setRemainingSeconds(nextRemainingSeconds);
      if (nextRemainingSeconds === 0) {
        setPhase("expired");
        setQrStatus("expired");
      }
    }

    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [entryQr, isModalOpen, phase]);

  async function loadQr() {
    setIsModalOpen(true);
    setIsLoading(true);
    setPhase("loading");
    setEntryQr(null);
    setQrStatus(null);
    setRemainingSeconds(null);

    try {
      const response = await fetch("/api/qr", { cache: "no-store" });
      if (!response.ok) throw new Error("qr_unavailable");
      const data = (await response.json()) as QrResponse;
      const nextQr = {
        ...data,
        status: normalizeQrStatus(data.status),
      };
      setEntryQr(nextQr);
      setQrStatus(nextQr.status);
      setRemainingSeconds(secondsUntilExpiry(nextQr.expiresAt));
      if (nextQr.status === "confirmed") {
        markEntryConnected(nextQr);
        return;
      }
      setPhase(nextQr.status === "expired" ? "expired" : "ready");
    } catch {
      setPhase("error");
    } finally {
      setIsLoading(false);
    }
  }

  function enter() {
    const existingConnectedEntry = readConnectedEntryCookie();
    if (existingConnectedEntry) {
      setConnectedEntry(existingConnectedEntry);
      setEntryQr(null);
      setQrStatus("confirmed");
      setRemainingSeconds(null);
      setPhase("connected");
      setIsModalOpen(true);
      return;
    }

    void loadQr();
  }

  function rescan() {
    clearConnectedEntryCookie();
    setConnectedEntry(null);
    void loadQr();
  }

  function closeModal() {
    setIsModalOpen(false);
  }

  const isQrExpired = phase === "expired" || qrStatus === "expired" || remainingSeconds === 0;
  const qrCountdown = remainingSeconds === null ? null : formatRemaining(remainingSeconds);
  const shouldShowQr = Boolean(entryQr && (phase === "ready" || phase === "expired"));
  const hasConnectedEntry = phase === "connected" || Boolean(connectedEntry);
  const isLocalQrPreview = entryQr?.mode === "fake" && shouldShowQr;
  const qrPrompt = isQrExpired
    ? modalCopy.expiredPrompt
    : qrStatus === "scan_confirming"
      ? modalCopy.scanConfirmingPrompt
      : qrStatus === "verification_required"
        ? modalCopy.verificationPrompt
        : qrStatus === "provider_error"
          ? modalCopy.providerErrorPrompt
          : isLocalQrPreview
            ? modalCopy.localPrompt
          : modalCopy.realPrompt;
  const qrHelperText = isQrExpired
    ? modalCopy.expiredHelper
    : qrStatus === "scan_confirming"
      ? modalCopy.scanConfirmingHelper
      : qrStatus === "verification_required"
        ? modalCopy.verificationHelper
        : qrStatus === "provider_error"
          ? modalCopy.providerErrorHelper
          : isLocalQrPreview
            ? modalCopy.localHelper
          : modalCopy.realHelper;
  const qrStatusLabel = isQrExpired
    ? modalCopy.expiredStatus
    : qrStatus === "waiting_to_scan"
      ? `${modalCopy.waitingStatus}${qrCountdown ? ` · ${qrCountdown}` : ""}`
      : qrStatus === "scan_confirming"
        ? modalCopy.scanConfirmingStatus
        : qrStatus === "verification_required"
        ? modalCopy.verificationStatus
        : qrStatus === "provider_error"
          ? modalCopy.providerErrorStatus
          : modalCopy.readyStatus;
  const dialogTitle =
    phase === "error" ? modalCopy.errorTitle : isLocalQrPreview ? modalCopy.localTitle : modalCopy.wechatTitle;
  const enterButtonText = connectedEntry ? t.enterConnected : isLoading ? t.enterLoading : t.enterIdle;
  const enterHelperText = connectedEntry ? t.connectedHelper : t.enterHelper;
  const canReopenAfterProviderError = qrStatus === "provider_error";

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0c0b10] text-[#f7f1e8]">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 h-[100svh] min-h-[680px]">
        <Image
          alt=""
          className="object-cover object-[50%_center] brightness-110 saturate-110 sm:object-[62%_center]"
          data-testid="hero-main-visual"
          fill
          priority
          sizes="100vw"
          src="/whoareyou-main-visual.png"
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,#0c0b10_0%,rgba(12,11,16,0.9)_28%,rgba(12,11,16,0.5)_48%,rgba(12,11,16,0.04)_72%,rgba(12,11,16,0.22)_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(12,11,16,0.7)_0%,rgba(12,11,16,0.38)_62%,rgba(12,11,16,0.1)_100%)] sm:hidden" />
        <div className="absolute inset-x-0 bottom-0 h-64 bg-[linear-gradient(180deg,rgba(12,11,16,0)_0%,#0c0b10_92%)]" />
      </div>

      <section className="relative z-10 mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-between px-6 py-8 sm:px-10 sm:py-12">
        <div className="flex items-center justify-between gap-5 text-xs text-[#9b9388]">
          <span>{t.topLine}</span>
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
            <span className="hidden sm:inline">{t.hour}</span>
          </div>
        </div>

        <div className="max-w-3xl py-12 sm:py-16">
          <h1 className="text-6xl font-normal leading-none text-[#fff8ed] sm:text-8xl md:text-9xl">
            {t.title}
          </h1>
          <p className="mt-8 max-w-2xl whitespace-pre-line text-xl leading-9 text-[#eadfce] sm:text-2xl sm:leading-10">
            {t.lead}
          </p>
          <p className="mt-5 max-w-xl text-base leading-8 text-[#b8aa96] sm:text-lg sm:leading-8">
            {t.subLead}
          </p>

          <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:items-center">
            <button
              className="h-12 w-full border border-[#f7f1e8]/55 px-7 text-base text-[#fff8ed] transition hover:border-[#fff8ed] hover:bg-[#fff8ed]/5 disabled:cursor-wait disabled:opacity-60 sm:w-auto"
              disabled={!isReady || isLoading}
              onClick={enter}
            >
              {enterButtonText}
            </button>
            <p className="max-w-lg text-sm leading-6 text-[#9b9388]">
              {enterHelperText}
            </p>
          </div>

          <div className="mt-10 max-w-xl border-l border-[#f7f1e8]/18 pl-5 text-sm leading-7 text-[#b8aa96]">
            {t.sideNote}
          </div>
        </div>

        <div className="border-t border-[#f7f1e8]/12 pt-7 text-sm leading-7 text-[#9b9388]">
          <p className="text-[#d7cab8]">{t.whyTitle}</p>
          <div className="mt-4 grid gap-5 md:grid-cols-2">
            <p>{t.whyLeft}</p>
            <p>{t.whyRight}</p>
          </div>
          <p className="mt-5 max-w-3xl text-[#b8aa96]">
            {t.whyEnd}
          </p>
          <div className="mt-7 flex flex-col gap-3 border-t border-[#f7f1e8]/10 pt-5 text-xs leading-6 text-[#8f867c] sm:flex-row sm:items-start sm:justify-between">
            <p className="max-w-3xl">{t.footerLine}</p>
            <p className="flex shrink-0 flex-wrap gap-x-4 gap-y-1">
              <a className="text-[#d7cab8] transition hover:text-[#fff8ed]" href={githubUrl} rel="noreferrer" target="_blank">
                {t.github}
              </a>
              <a className="text-[#d7cab8] transition hover:text-[#fff8ed]" href="https://ai.wangyuzhao.cn/">
                {t.experience}
              </a>
              <span>
                {t.contactPrefix}{" "}
                <a className="text-[#d7cab8] transition hover:text-[#fff8ed]" href={`mailto:${contactEmail}`}>
                  {contactEmail}
                </a>
                {t.contactSuffix}
              </span>
            </p>
          </div>
        </div>
      </section>

      {isModalOpen ? (
        <div
          aria-modal="true"
          className="fixed inset-0 z-50 flex min-h-screen items-center justify-center bg-[#08070b]/82 px-4 py-6 backdrop-blur-md"
          role="dialog"
        >
          <div
            className="max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto border border-[#f7f1e8]/18 bg-[#111017]/95 p-6 text-[#f7f1e8] shadow-2xl shadow-black/65 sm:p-7"
            data-testid="wechat-entry-dialog"
          >
            <div className="flex items-start justify-between gap-6">
              <div>
                <h2 className="mt-3 text-4xl font-normal leading-none text-[#fff8ed] sm:text-[2.75rem]">
                  {dialogTitle}
                </h2>
              </div>
              <button
                aria-label={modalCopy.close}
                className="grid h-10 w-10 place-items-center border border-[#f7f1e8]/18 text-3xl leading-none text-[#b8aa96] transition hover:border-[#f7f1e8]/45 hover:text-[#fff8ed]"
                onClick={closeModal}
                type="button"
              >
                ×
              </button>
            </div>

            <div className="mt-6 flex flex-col items-center justify-center text-center">
              {hasConnectedEntry ? (
                <>
                  <p className="text-lg text-[#fff8ed]">{modalCopy.connected}</p>
                  <p className="mt-3 max-w-sm text-sm leading-6 text-[#b8aa96]">
                    {t.connectedHelper}
                  </p>
                  <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                    <button
                      className="h-11 border border-[#f7f1e8]/45 px-6 text-sm text-[#fff8ed] transition hover:border-[#fff8ed] hover:bg-[#fff8ed]/5"
                      onClick={closeModal}
                      type="button"
                    >
                      {modalCopy.known}
                    </button>
                    <button
                      className="h-11 border border-[#f7f1e8]/18 px-6 text-sm text-[#b8aa96] transition hover:border-[#f7f1e8]/45 hover:text-[#fff8ed]"
                      disabled={isLoading}
                      onClick={rescan}
                      type="button"
                    >
                      {modalCopy.rescan}
                    </button>
                  </div>
                </>
              ) : null}

              {phase === "loading" ? (
                <>
                  <p className="text-lg text-[#fff8ed]">{modalCopy.loading}</p>
                  <div className="mt-6 grid h-60 w-60 place-items-center border border-[#f7f1e8]/18 bg-[#17131d]">
                    <div className="h-11 w-11 animate-spin rounded-full border-8 border-[#f7f1e8]/15 border-t-[#fff8ed]" />
                    <p className="sr-only">{modalCopy.loadingSr}</p>
                  </div>
                </>
              ) : null}

              {shouldShowQr && entryQr ? (
                <>
                  <p className="text-lg text-[#fff8ed]">{qrPrompt}</p>
                  <div className="relative mt-5 aspect-square w-[min(15rem,calc(100vw-7rem))] border border-[#f7f1e8]/16 bg-[#fffaf2] p-3 shadow-2xl shadow-black/30">
                    <Image
                      alt={isLocalQrPreview ? modalCopy.qrAltLocal : modalCopy.qrAltReal}
                      className={`h-full w-full object-contain transition duration-300 ${isQrExpired ? "blur-sm opacity-55" : ""}`}
                      data-testid="wechat-qr-image"
                      fill
                      sizes="240px"
                      src={entryQr.qr.imageSrc}
                      unoptimized
                    />
                    {isQrExpired ? (
                      <div className="absolute inset-0 grid place-items-center bg-[#fffaf2]/30">
                        <button
                          aria-label={modalCopy.refreshQr}
                          className="flex h-14 items-center gap-2 border border-[#111016]/25 bg-[#fffaf2] px-6 text-lg text-[#19151d] shadow-lg shadow-black/25 transition hover:border-[#111016] hover:bg-white"
                          disabled={isLoading}
                          onClick={loadQr}
                          type="button"
                        >
                          <span aria-hidden="true" className="text-2xl leading-none">
                            ↻
                          </span>
                          {modalCopy.refreshQr}
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <p className="mt-3 text-sm leading-6 text-[#9b9388]">{qrHelperText}</p>
                  <p className="mt-2 border border-[#f7f1e8]/18 px-3 py-1 text-xs text-[#b8aa96]">
                    {qrStatusLabel}
                  </p>
                  {canReopenAfterProviderError ? (
                    <button
                      className="mt-4 h-11 border border-[#f7f1e8]/45 px-5 text-sm text-[#fff8ed] transition hover:border-[#fff8ed] hover:bg-[#fff8ed]/5"
                      disabled={isLoading}
                      onClick={loadQr}
                      type="button"
                    >
                      {modalCopy.refreshQr}
                    </button>
                  ) : null}
                </>
              ) : null}

              {phase === "error" ? (
                <>
                  <p className="text-lg text-[#fff8ed]">{modalCopy.errorBody}</p>
                  <p className="mt-3 max-w-sm text-sm leading-6 text-[#9b9388]">
                    {modalCopy.errorHelp}
                  </p>
                  <button
                    className="mt-8 h-11 border border-[#f7f1e8]/45 px-5 text-sm text-[#fff8ed] transition hover:border-[#fff8ed] hover:bg-[#fff8ed]/5"
                    onClick={loadQr}
                    type="button"
                  >
                    {modalCopy.retry}
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
