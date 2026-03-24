import type { Metadata } from "next";
import { IBM_Plex_Sans, Space_Grotesk } from "next/font/google";
import { AppFrame } from "@/components/app-frame";
import "./globals.css";

const bodyFont = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600", "700"],
});

const displayFont = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Track Republic",
  description: "Interactive dashboard for monthly cashflow, spending, and balances.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body className={`${bodyFont.variable} ${displayFont.variable}`}>
        <AppFrame>{children}</AppFrame>
      </body>
    </html>
  );
}
