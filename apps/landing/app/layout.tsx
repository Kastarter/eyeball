import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const title = "eyeball — One API that unblocks agents";
const description =
  "Typed, authenticated tools for AI agents across email, calling, messaging, business systems, and social data.";

export const metadata: Metadata = {
  metadataBase: new URL("https://eyeball.dev"),
  title: {
    default: title,
    template: "%s — eyeball",
  },
  description,
  applicationName: "eyeball",
  openGraph: {
    type: "website",
    url: "https://eyeball.dev",
    siteName: "eyeball",
    title,
    description,
    images: [
      {
        url: "/og.svg",
        width: 1200,
        height: 630,
        alt: "eyeball — One API that unblocks agents",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/og.svg"],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0a0a0f",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html data-theme="dark" lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
