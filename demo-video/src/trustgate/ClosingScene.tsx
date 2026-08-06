import {
  AbsoluteFill,
  Easing,
  Interactive,
  interpolate,
  useCurrentFrame,
} from "remotion";

export const ClosingScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill
      name="Closing"
      style={{
        backgroundColor: "#062A26",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "Inter",
      }}
    >
      <Interactive.Div
        name="Glow"
        style={{
          position: "absolute",
          width: 1900,
          height: 1900,
          borderRadius: 9999,
          background:
            "radial-gradient(circle, rgba(20,148,107,0.28) 0%, rgba(6,42,38,0) 62%)",
        }}
      />

      <Interactive.Div
        name="Metric · stages"
        style={{
          position: "absolute",
          left: 180,
          top: 336,
          width: 480,
          textAlign: "center",
          opacity: interpolate(frame, [0, 16], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [0, 22], ["0px 26px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <div style={{ fontSize: 136, fontWeight: 700, letterSpacing: -5, color: "#FFFFFF" }}>
          6/6
        </div>
        <div style={{ fontSize: 36, fontWeight: 400, color: "#93C4BC", marginTop: 8 }}>
          stages completed
        </div>
      </Interactive.Div>

      <Interactive.Div
        name="Metric · time"
        style={{
          position: "absolute",
          left: 720,
          top: 336,
          width: 480,
          textAlign: "center",
          opacity: interpolate(frame, [8, 24], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [8, 30], ["0px 26px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <div style={{ fontSize: 136, fontWeight: 700, letterSpacing: -5, color: "#5FD9BC" }}>
          38.3s
        </div>
        <div style={{ fontSize: 36, fontWeight: 400, color: "#93C4BC", marginTop: 8 }}>
          registration to settlement
        </div>
      </Interactive.Div>

      <Interactive.Div
        name="Metric · automation"
        style={{
          position: "absolute",
          left: 1260,
          top: 336,
          width: 480,
          textAlign: "center",
          opacity: interpolate(frame, [16, 32], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [16, 38], ["0px 26px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <div style={{ fontSize: 136, fontWeight: 700, letterSpacing: -5, color: "#FFFFFF" }}>
          zero
        </div>
        <div style={{ fontSize: 36, fontWeight: 400, color: "#93C4BC", marginTop: 8 }}>
          manual bid selection
        </div>
      </Interactive.Div>

      <Interactive.Div
        name="Signature"
        style={{
          position: "absolute",
          top: 706,
          display: "flex",
          alignItems: "center",
          gap: 26,
          opacity: interpolate(frame, [34, 52], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <span
          style={{
            width: 74,
            height: 74,
            borderRadius: 18,
            backgroundColor: "#0A6D60",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg
            width={44}
            height={44}
            viewBox="0 0 24 24"
            fill="none"
            stroke="#EAFBF5"
            strokeWidth={1.9}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 3 4.5 6v5.6c0 4.3 3 8.3 7.5 9.4 4.5-1.1 7.5-5.1 7.5-9.4V6z" />
            <path d="m9 12 2.2 2.2L15.2 10" />
          </svg>
        </span>
        <span style={{ fontSize: 76, fontWeight: 700, letterSpacing: -3, color: "#FFFFFF" }}>
          TrustGate
        </span>
      </Interactive.Div>

      <Interactive.Div
        name="Footer"
        style={{
          position: "absolute",
          top: 830,
          fontFamily: "JetBrains Mono",
          fontSize: 30,
          letterSpacing: 2,
          color: "#5F958D",
          opacity: interpolate(frame, [46, 66], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        Stellar · Soroban · on-chain escrow
      </Interactive.Div>
    </AbsoluteFill>
  );
};
