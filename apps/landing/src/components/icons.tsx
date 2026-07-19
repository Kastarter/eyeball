interface IconProps {
  size?: number;
}

export function ArrowIcon({ size = 16 }: IconProps) {
  return (
    <svg aria-hidden="true" height={size} viewBox="0 0 16 16" width={size}>
      <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" />
    </svg>
  );
}

export function CopyIcon({ size = 14 }: IconProps) {
  return (
    <svg aria-hidden="true" height={size} viewBox="0 0 16 16" width={size}>
      <rect height="9" rx="1.5" width="9" x="5" y="5" />
      <path d="M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h7A1.5 1.5 0 0 1 11 2.5V3" />
    </svg>
  );
}

export function GitHubIcon({ size = 16 }: IconProps) {
  return (
    <svg aria-hidden="true" height={size} viewBox="0 0 24 24" width={size}>
      <path d="M12 2.5a9.7 9.7 0 0 0-3.07 18.9c.48.09.66-.2.66-.46v-1.7c-2.68.58-3.25-1.14-3.25-1.14-.44-1.12-1.08-1.42-1.08-1.42-.88-.6.07-.59.07-.59.97.07 1.48 1 1.48 1 .87 1.48 2.27 1.05 2.82.8.09-.62.34-1.05.61-1.29-2.14-.24-4.39-1.07-4.39-4.77 0-1.05.38-1.91 1-2.59-.1-.24-.43-1.22.09-2.55 0 0 .81-.26 2.67.99A9.3 9.3 0 0 1 12 7.35c.83 0 1.65.11 2.43.33 1.85-1.25 2.66-.99 2.66-.99.53 1.33.2 2.31.1 2.55.62.68 1 1.54 1 2.59 0 3.71-2.26 4.52-4.41 4.76.35.3.65.89.65 1.79v2.56c0 .26.18.56.66.46A9.7 9.7 0 0 0 12 2.5Z" />
    </svg>
  );
}
