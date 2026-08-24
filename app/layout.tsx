import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "UC-Share Media Extractor",
  description:
    "Resolve direct media links from uc-share.com pages — inline video preview, one-click download, zero ads. Runs fully serverless on Vercel.",
  metadataBase: new URL("https://ucshare-extractor.vercel.app"),
  openGraph: {
    title: "UC-Share Media Extractor",
    description:
      "Paste a uc-share.com link and get its direct media URL — instantly, serverless, no ads.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} font-sans`}>{children}</body>
    </html>
  );
}
