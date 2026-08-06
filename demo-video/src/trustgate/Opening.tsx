import {
  AbsoluteFill,
  Easing,
  Interactive,
  interpolate,
  useCurrentFrame,
} from "remotion";

export const Opening: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill
      name="Opening"
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
            "radial-gradient(circle, rgba(20,148,107,0.34) 0%, rgba(6,42,38,0) 62%)",
          opacity: interpolate(frame, [0, 30], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      />

      <Interactive.Div
        name="Mark"
        style={{
          width: 148,
          height: 148,
          marginBottom: 52,
          borderRadius: 34,
          backgroundColor: "#0A6D60",
          alignItems: "center",
          justifyContent: "center",
          display: "flex",
          boxShadow: "0 34px 90px rgba(10,109,96,0.45)",
          scale: interpolate(frame, [4, 30], [0.7, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.spring({ damping: 200 }),
            output: "perceptual-scale",
          }),
          opacity: interpolate(frame, [4, 20], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <svg
          width={86}
          height={86}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#EAFBF5"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path
            d="M12 3 4.5 6v5.6c0 4.3 3 8.3 7.5 9.4 4.5-1.1 7.5-5.1 7.5-9.4V6z"
            strokeDasharray={70}
            strokeDashoffset={interpolate(frame, [8, 42], [70, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            })}
          />
          <path
            d="m9 12 2.2 2.2L15.2 10"
            strokeDasharray={13}
            strokeDashoffset={interpolate(frame, [34, 52], [13, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            })}
          />
        </svg>
      </Interactive.Div>

      <Interactive.Div
        name="Title"
        style={{
          fontSize: 168,
          fontWeight: 700,
          letterSpacing: -7,
          color: "#FFFFFF",
          lineHeight: 1,
          opacity: interpolate(frame, [18, 40], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [18, 46], ["0px 34px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        TrustGate
      </Interactive.Div>

      <Interactive.Div
        name="Subtitle"
        style={{
          fontSize: 56,
          fontWeight: 400,
          color: "#93C4BC",
          lineHeight: 1.35,
          marginTop: 30,
          textAlign: "center",
          opacity: interpolate(frame, [34, 58], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [34, 62], ["0px 24px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        Task marketplace on Stellar
        <br />
        trust-minimized, on-chain escrow
      </Interactive.Div>

      <Interactive.Div
        name="Environment chip"
        style={{
          position: "absolute",
          bottom: 96,
          fontFamily: "JetBrains Mono",
          fontSize: 30,
          color: "#5F958D",
          letterSpacing: 1,
          border: "1px solid rgba(147,196,188,0.28)",
          borderRadius: 9999,
          padding: "16px 34px",
          opacity: interpolate(frame, [52, 76], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        live demo · localhost:5173
      </Interactive.Div>
    </AbsoluteFill>
  );
};
