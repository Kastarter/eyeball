import type { Metadata, Viewport } from "next";
import Script from "next/script";
import type { ReactNode } from "react";
import { DocsShell } from "@/src/components/docs-shell";
import {
  getDocsConfig,
  getPageTitleMap,
  getSearchIndex,
} from "@/src/lib/content";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "eyeball documentation",
    template: "%s — eyeball docs",
  },
  description: "Typed, authenticated tools for production AI agents.",
};

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: [
    { color: "#07070a", media: "(prefers-color-scheme: dark)" },
    { color: "#f7f7fa", media: "(prefers-color-scheme: light)" },
  ],
};

const themeScript = `
try {
  const saved = localStorage.getItem("eyeball-docs-theme");
  document.documentElement.dataset.theme = saved === "light" ? "light" : "dark";
} catch (_) {
  document.documentElement.dataset.theme = "dark";
}
`;

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html data-theme="dark" lang="en" suppressHydrationWarning>
      <body>
        <Script id="eyeball-docs-theme" strategy="beforeInteractive">
          {themeScript}
        </Script>
        <DocsShell
          config={getDocsConfig()}
          searchIndex={getSearchIndex()}
          titles={getPageTitleMap()}
        >
          {children}
        </DocsShell>
      </body>
    </html>
  );
}
