interface ApertureLogoProps {
  size?: number;
  watching?: boolean;
}

export function ApertureLogo({
  size = 28,
  watching = false,
}: ApertureLogoProps) {
  return (
    <span
      aria-label="eyeball aperture mark"
      className={`aperture-logo${watching ? " aperture-logo--watching" : ""}`}
      role="img"
      style={{ height: size, width: size }}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path
          d="M12 1.75A10.25 10.25 0 1 1 12 22.25 10.25 10.25 0 0 1 12 1.75Zm0 7.35a2.9 2.9 0 1 0 0 5.8 2.9 2.9 0 0 0 0-5.8Z"
          fill="currentColor"
          fillRule="evenodd"
        />
        <g className="aperture-logo__blades">
          {[0, 60, 120, 180, 240, 300].map((rotation) => (
            <path
              d="M12 2.15 9.2 9.75"
              key={rotation}
              transform={`rotate(${rotation} 12 12)`}
            />
          ))}
        </g>
      </svg>
    </span>
  );
}
