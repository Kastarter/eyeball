import type { SVGProps } from "react";

export type IconName =
  | "bolt"
  | "brackets-curly"
  | "check"
  | "chevron-left"
  | "chevron-right"
  | "close"
  | "copy"
  | "frame"
  | "github"
  | "info"
  | "magnifying-glass"
  | "menu"
  | "moon"
  | "rocket"
  | "search"
  | "sun"
  | "table-list"
  | "thumbs-down"
  | "thumbs-up"
  | "tip"
  | "warning";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName | (string & {});
  size?: number;
}

function IconPaths({ name }: { name: string }) {
  switch (name) {
    case "bolt":
      return <path d="m13 2-8 11h6l-1 9 8-12h-6l1-8Z" />;
    case "brackets-curly":
      return (
        <path d="M8 3H6a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v6a2 2 0 0 0 2 2h2M16 3h2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v6a2 2 0 0 1-2 2h-2" />
      );
    case "check":
      return <path d="m5 12 4 4L19 6" />;
    case "chevron-left":
      return <path d="m15 18-6-6 6-6" />;
    case "chevron-right":
      return <path d="m9 18 6-6-6-6" />;
    case "close":
      return <path d="m6 6 12 12M18 6 6 18" />;
    case "copy":
      return (
        <>
          <rect x="8" y="8" width="12" height="12" rx="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        </>
      );
    case "frame":
      return (
        <>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M8 3v18M16 3v18M3 8h18M3 16h18" />
        </>
      );
    case "github":
      return (
        <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7.4A5.8 5.8 0 0 0 19.3 3 5.4 5.4 0 0 0 19.1 0S17.9-.4 15 1.5a13.4 13.4 0 0 0-6 0C6.1-.4 4.9 0 4.9 0a5.4 5.4 0 0 0-.2 3A5.8 5.8 0 0 0 3.2 7.1c0 5.8 3.5 7 6.8 7.4a4.8 4.8 0 0 0-1 3.5v4M9 19c-3 .9-3-1.5-4.2-2" />
      );
    case "info":
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </>
      );
    case "menu":
      return <path d="M4 7h16M4 12h16M4 17h16" />;
    case "moon":
      return <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />;
    case "rocket":
      return (
        <>
          <path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.8-.9.8-2.3-.1-3.1a2.2 2.2 0 0 0-2.9.1ZM12 15l-3-3a22 22 0 0 1 2-3.9A12.7 12.7 0 0 1 22 2c0 2.7-.8 7.5-6.1 11a22 22 0 0 1-3.9 2Z" />
          <path d="M9 12H4s.5-2.8 2-4c1.7-1.3 5 0 5 0M12 15v5s2.8-.5 4-2c1.3-1.7 0-5 0-5" />
          <circle cx="16" cy="8" r="1" />
        </>
      );
    case "sun":
      return (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </>
      );
    case "table-list":
      return (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18M8 4v16M12 13h5M12 16h5" />
        </>
      );
    case "thumbs-down":
      return (
        <>
          <path d="M17 14V2M9 18.1 10 14H4.2a2 2 0 0 1-1.9-2.6l2.3-7A2 2 0 0 1 6.5 3H17v11h-2.8a2 2 0 0 0-1.8 1.1L10 20a2 2 0 0 1-1-1.9Z" />
          <path d="M17 3h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3" />
        </>
      );
    case "thumbs-up":
      return (
        <>
          <path d="M7 10v12M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 7a2 2 0 0 1-1.9 1.4H7V10h2.8a2 2 0 0 0 1.8-1.1L14 4a2 2 0 0 1 1 1.9Z" />
          <path d="M7 21H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
        </>
      );
    case "tip":
      return (
        <>
          <path d="M9 18h6M10 22h4" />
          <path d="M8.5 14.5A7 7 0 1 1 15.5 14.5c-.9.7-1.5 1.5-1.5 2.5h-4c0-1-.6-1.8-1.5-2.5Z" />
        </>
      );
    case "warning":
      return (
        <>
          <path d="M10.3 3.7 2.5 17.2A2 2 0 0 0 4.2 20h15.6a2 2 0 0 0 1.7-2.8L13.7 3.7a2 2 0 0 0-3.4 0Z" />
          <path d="M12 9v4M12 17h.01" />
        </>
      );
    default:
      return (
        <>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-4-4" />
        </>
      );
  }
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      <IconPaths name={name} />
    </svg>
  );
}
