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
  description: "一个 AI 爱好者的小玩具：扫码，把这个微信入口留给一个也停下来的人。",
  openGraph: {
    title: "UNKNOWN",
    description: "扫码，把这个微信入口留给一个也停下来的人。",
    url: "https://ai.wangyuzhao.cn/",
    siteName: "UNKNOWN",
    images: [
      {
        url: "/whoareyou-main-visual.png",
        width: 1792,
        height: 1024,
        alt: "UNKNOWN main visual",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "UNKNOWN",
    description: "扫码，把这个微信入口留给一个也停下来的人。",
    images: ["/whoareyou-main-visual.png"],
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
