import type { SVGProps } from "react";

export type IconName =
  | "activity"
  | "arrowRight"
  | "catalog"
  | "check"
  | "chevronDown"
  | "close"
  | "command"
  | "connections"
  | "copy"
  | "executions"
  | "key"
  | "moon"
  | "overview"
  | "plus"
  | "search"
  | "settings"
  | "sun"
  | "terminal"
  | "voice";

const iconPaths: Record<IconName, React.ReactNode> = {
  activity: <path d="M2 8h2.4l1.4-4.2 3 8.4 1.5-4.2H14" />,
  arrowRight: <path d="m6 3 5 5-5 5M2 8h9" />,
  catalog: (
    <>
      <rect x="2.5" y="2.5" width="4" height="4" rx="1" />
      <rect x="9.5" y="2.5" width="4" height="4" rx="1" />
      <rect x="2.5" y="9.5" width="4" height="4" rx="1" />
      <rect x="9.5" y="9.5" width="4" height="4" rx="1" />
    </>
  ),
  check: <path d="m3 8 3 3 7-7" />,
  chevronDown: <path d="m4 6 4 4 4-4" />,
  close: <path d="m4 4 8 8m0-8-8 8" />,
  command: (
    <path d="M5.5 5.5H4a2 2 0 1 1 2-2v9a2 2 0 1 1-2-2h8a2 2 0 1 1-2 2v-9a2 2 0 1 1 2 2H5.5Z" />
  ),
  connections: (
    <>
      <path d="M6 5.5 4.8 4.3a2.1 2.1 0 0 0-3 3L4 9.5a2.1 2.1 0 0 0 3 0L8 8.6" />
      <path d="m10 10.5 1.2 1.2a2.1 2.1 0 0 0 3-3L12 6.5a2.1 2.1 0 0 0-3 0L8 7.4" />
    </>
  ),
  copy: (
    <>
      <rect x="5" y="5" width="8" height="8" rx="1.5" />
      <path d="M3 10.5H2.8A1.8 1.8 0 0 1 1 8.7V2.8A1.8 1.8 0 0 1 2.8 1h5.9A1.8 1.8 0 0 1 10.5 2.8V3" />
    </>
  ),
  executions: (
    <>
      <path d="M3 3.5h10M3 8h10M3 12.5h10" />
      <circle cx="5" cy="3.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="11" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="7" cy="12.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  key: (
    <>
      <circle cx="5" cy="8" r="3" />
      <path d="M8 8h6m-2 0v2m-2-2v2" />
    </>
  ),
  moon: <path d="M13 10.2A5.5 5.5 0 0 1 5.8 3 5.5 5.5 0 1 0 13 10.2Z" />,
  overview: (
    <>
      <path d="M2.5 7.2 8 2.5l5.5 4.7v6.3H9.8V9.8H6.2v3.7H2.5Z" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M6.8 2.2h2.4l.5 1.7 1.5.9 1.7-.4 1.2 2.1-1.2 1.2v1.7l1.2 1.2-1.2 2.1-1.7-.4-1.5.9-.5 1.7H6.8l-.5-1.7-1.5-.9-1.7.4-1.2-2.1 1.2-1.2V7.7L1.9 6.5l1.2-2.1 1.7.4 1.5-.9Z" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="2.7" />
      <path d="M8 1.5v1.2m0 10.6v1.2M1.5 8h1.2m10.6 0h1.2M3.4 3.4l.9.9m7.4 7.4.9.9m0-9.2-.9.9m-7.4 7.4-.9.9" />
    </>
  ),
  terminal: <path d="m2.5 4 3.5 4-3.5 4M8 12h5.5" />,
  voice: (
    <>
      <path d="M3 9.5V6.5M6 12V4M9 13.5v-11M12 11V5M15 9V7" />
    </>
  ),
};

export function Icon({
  name,
  ...props
}: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="16"
      viewBox="0 0 16 16"
      width="16"
      {...props}
    >
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      >
        {iconPaths[name]}
      </g>
    </svg>
  );
}
