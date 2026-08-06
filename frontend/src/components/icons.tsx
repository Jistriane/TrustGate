type IconProps = { size?: number };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 2.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export function CheckIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="m4 12.5 5.2 5.2L20 6.9" />
    </svg>
  );
}

export function CopyIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2}>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5.5 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v.5" />
    </svg>
  );
}

/** TrustGate mark: a gate/shield outline with a check inside. */
export function GateIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2}>
      <path d="M12 3 4.5 6v5.6c0 4.3 3 8.3 7.5 9.4 4.5-1.1 7.5-5.1 7.5-9.4V6z" />
      <path d="m9 12 2.2 2.2L15.2 10" />
    </svg>
  );
}
