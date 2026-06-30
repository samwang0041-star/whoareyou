import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://ai.wangyuzhao.cn"),
  title: "UNKNOWN",
  description: "一个被遗弃很久的微信 AI 入口，突然传来一段陌生的声音。也许这个 bug 只会存在一小时。",
  openGraph: {
    title: "UNKNOWN",
    description: "一个被遗弃很久的微信 AI 入口，突然传来一段陌生的声音。",
    url: "https://ai.wangyuzhao.cn/",
    siteName: "UNKNOWN",
    images: [
      {
        url: "/whoareyou-main-visual-abstract.png",
        width: 1672,
        height: 941,
        alt: "UNKNOWN main visual",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "UNKNOWN",
    description: "一个被遗弃很久的微信 AI 入口，突然传来一段陌生的声音。",
    images: ["/whoareyou-main-visual-abstract.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
