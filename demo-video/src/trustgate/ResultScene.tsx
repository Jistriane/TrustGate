import {
  AbsoluteFill,
  CanvasImage,
  Easing,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

/** The settled-task card, straight from the run — captured at 2x so the
 *  addresses and the payload hash stay sharp at this size. */
export const ResultScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill name="Result" style={{ backgroundColor: "#062A26", fontFamily: "Inter" }}>
      <Interactive.Div
        name="Glow"
        style={{
          position: "absolute",
          left: 210,
          top: -420,
          width: 1500,
          height: 1500,
          borderRadius: 9999,
          background:
            "radial-gradient(circle, rgba(20,148,107,0.26) 0%, rgba(6,42,38,0) 64%)",
        }}
      />

      <Interactive.Div
        name="Kicker"
        style={{
          position: "absolute",
          left: 180,
          top: 96,
          fontFamily: "JetBrains Mono",
          fontSize: 26,
          fontWeight: 500,
          letterSpacing: 4,
          color: "#5FD9BC",
          opacity: interpolate(frame, [0, 14], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        PROOF OF EXECUTION
      </Interactive.Div>

      <Interactive.Div
        name="Title"
        style={{
          position: "absolute",
          left: 180,
          top: 142,
          fontSize: 88,
          fontWeight: 600,
          letterSpacing: -2.5,
          color: "#FFFFFF",
          opacity: interpolate(frame, [4, 20], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [4, 26], ["0px 22px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        Settled, and verifiable
      </Interactive.Div>

      <CanvasImage
        name="Result card"
        src={staticFile("result.png")}
        style={{
          position: "absolute",
          left: 180,
          top: 300,
          width: 1560,
          height: 551,
          borderRadius: 22,
          boxShadow: "0 40px 110px rgba(0,0,0,0.45)",
          opacity: interpolate(frame, [8, 24], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          scale: interpolate(frame, [8, 38], [0.965, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
            output: "perceptual-scale",
          }),
        }}
      />

      <Interactive.Div
        name="Hash highlight"
        style={{
          position: "absolute",
          left: 370,
          top: 436,
          width: 780,
          height: 66,
          borderRadius: 14,
          border: "3px solid #14946B",
          boxShadow: "0 0 0 8px rgba(20,148,107,0.16)",
          opacity: interpolate(frame, [40, 54], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          scale: interpolate(frame, [40, 62], [1.07, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
            output: "perceptual-scale",
          }),
        }}
      />

      <Interactive.Div
        name="Hash note"
        style={{
          position: "absolute",
          left: 180,
          top: 896,
          width: 1560,
          fontSize: 38,
          fontWeight: 400,
          lineHeight: 1.4,
          color: "#93C4BC",
          opacity: interpolate(frame, [56, 74], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [56, 78], ["0px 18px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        The SHA-256 hash of the deliverable is stored with the task — any party can
        verify the result later.
      </Interactive.Div>
    </AbsoluteFill>
  );
};
