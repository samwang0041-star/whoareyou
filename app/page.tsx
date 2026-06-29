"use client";

import { useEffect, useState } from "react";

type QrResponse = {
  url: string;
};

export default function HomePage() {
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const readyTimer = window.setTimeout(() => setIsReady(true), 0);
    return () => window.clearTimeout(readyTimer);
  }, []);

  async function enter() {
    setIsLoading(true);
    setHasError(false);

    try {
      const response = await fetch("/api/qr");
      if (!response.ok) throw new Error("qr_unavailable");
      const data = (await response.json()) as QrResponse;
      setQrUrl(data.url);
    } catch {
      setHasError(true);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#0c0b10] text-[#f7f1e8]">
      <section className="mx-auto flex min-h-screen w-full max-w-4xl flex-col justify-between px-6 py-10 sm:px-10 sm:py-14">
        <div className="flex items-center justify-between text-xs text-[#9b9388]">
          <span>AI 入口里的真人相遇</span>
          <span>one hour</span>
        </div>

        <div className="py-16 sm:py-20">
          <p className="text-sm text-[#b8aa96]">这一次，入口后面不是 AI。</p>
          <h1 className="mt-5 text-6xl font-normal leading-none text-[#fff8ed] sm:text-8xl">
            你是谁
          </h1>
          <p className="mt-8 whitespace-pre-line text-xl leading-9 text-[#eadfce] sm:text-2xl sm:leading-10">
            扫码，遇见一个陌生人。{"\n"}把你的入口，留给一次不期而遇。
          </p>

          <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:items-center">
            <button
              className="h-12 w-full border border-[#f7f1e8]/55 px-6 text-base text-[#fff8ed] transition hover:border-[#fff8ed] disabled:cursor-wait disabled:opacity-60 sm:w-auto"
              disabled={!isReady || isLoading}
              onClick={enter}
            >
              {isLoading ? "正在靠近" : "进入"}
            </button>
            {qrUrl ? <p className="text-sm text-[#9b9388]">请用微信打开这个入口。</p> : null}
          </div>

          {qrUrl ? (
            <div className="mt-8 max-w-xl border border-[#f7f1e8]/15 bg-[#17131d] p-5 text-sm leading-7 text-[#d9c9b2]">
              <p>入口已经亮起。</p>
              <p className="mt-2 break-all text-[#fff8ed]">{qrUrl}</p>
            </div>
          ) : null}

          {hasError ? (
            <p className="mt-6 text-sm text-[#f0a59b]">入口暂时没有亮起来。等一会儿再试。</p>
          ) : null}
        </div>

        <div className="grid gap-8 border-t border-[#f7f1e8]/12 pt-8 text-sm leading-7 text-[#b8aa96] md:grid-cols-[1.2fr_0.8fr]">
          <p>
            我们已经习惯扫码，接入一个又一个 agent。问它问题，等它回答，让它陪我们把工作继续推进。
            可这一次，请先停一下。入口后面不是 AI，是另一个也停下来的人。
          </p>
          <p>
            你们只有一小时。时间到了，就只能留下一句回声。因为稀缺，所以这一小时更值得被认真对待。
          </p>
        </div>
      </section>
    </main>
  );
}
