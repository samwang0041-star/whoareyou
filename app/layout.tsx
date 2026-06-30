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
  description: "不是新的 agent，也不是匿名社交。把入口留在微信里，等一个未知的信号靠近。",
  openGraph: {
    title: "UNKNOWN",
    description: "把入口留在微信里，等一个未知的信号靠近。",
    url: "https://ai.wangyuzhao.cn/",
    siteName: "UNKNOWN",
    images: [
      {
        url: "/whoareyou-main-visual.png",
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
    description: "把入口留在微信里，等一个未知的信号靠近。",
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
