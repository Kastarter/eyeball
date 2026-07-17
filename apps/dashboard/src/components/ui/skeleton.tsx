import type { CSSProperties } from "react";

export interface SkeletonProps {
  height?: number | string;
  label?: string;
  width?: number | string;
}

export function Skeleton({
  height = 16,
  label = "Loading",
  width = "100%",
}: SkeletonProps) {
  const style: CSSProperties = { height, width };
  return (
    <span aria-label={label} className="skeleton" role="status" style={style}>
      <span className="visually-hidden">{label}</span>
    </span>
  );
}
