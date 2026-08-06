import { Video } from "@remotion/media";
import {
  AbsoluteFill,
  Easing,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

/**
 * The footage is one real run against the live API, re-paced before import:
 * the five fast stages play at 0.35x so they can be read, and the 36s escrow
 * settlement plays at 10x. All frame numbers below are frames of that clip.
 *
 * The camera keyframes move between three framings — whole app, step list,
 * and the run header where the elapsed timer races — while the left panel
 * keeps the narration off the UI.
 */
export const RunScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill name="Run" style={{ backgroundColor: "#062A26", fontFamily: "Inter" }}>
      <Video
        name="Run recording"
        src={staticFile("hero.mp4")}
        durationInFrames={499}
        style={{
          position: "absolute",
          left: 160,
          top: 40,
          width: 1600,
          height: 1000,
          scale: interpolate(
            frame,
            [0, 50, 80, 212, 240, 320, 350],
            [1.1, 1.1, 1.55, 1.55, 2.1, 2.1, 1.1],
            {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.33, 0, 0.15, 1),
              output: "perceptual-scale",
            }
          ),
          translate: interpolate(
            frame,
            [0, 50, 80, 212, 240, 320, 350],
            [
              "330px -10px",
              "330px -10px",
              "628px -235px",
              "628px -235px",
              "-406px 510px",
              "-406px 510px",
              "330px -10px",
            ],
            {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.33, 0, 0.15, 1),
            }
          ),
        }}
      />

      <Interactive.Div
        name="Narration panel"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 700,
          height: 1080,
          backgroundColor: "#062A26",
          borderRight: "1px solid rgba(255,255,255,0.1)",
          boxShadow: "40px 0 90px rgba(6,42,38,0.55)",
        }}
      />

      <Interactive.Div
        name="Caption · intro"
        style={{
          position: "absolute",
          left: 72,
          top: 92,
          width: 556,
          opacity: interpolate(frame, [0, 1, 44, 56], [1, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <Interactive.Div
          name="Kicker · intro"
          style={{
            fontFamily: "JetBrains Mono",
            fontSize: 24,
            fontWeight: 500,
            letterSpacing: 3.5,
            color: "#5FD9BC",
            marginBottom: 18,
          }}
        >
          LIVE
        </Interactive.Div>
        <Interactive.Div
          name="Title · intro"
          style={{
            fontSize: 52,
            fontWeight: 600,
            letterSpacing: -1.2,
            lineHeight: 1.14,
            color: "#FFFFFF",
          }}
        >
          A full job, against the live API
        </Interactive.Div>
      </Interactive.Div>

      <Interactive.Div
        name="Caption · stages"
        style={{
          position: "absolute",
          left: 72,
          top: 92,
          width: 556,
          opacity: interpolate(frame, [48, 60, 210, 222], [0, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <Interactive.Div
          name="Kicker · stages"
          style={{
            fontFamily: "JetBrains Mono",
            fontSize: 24,
            fontWeight: 500,
            letterSpacing: 3.5,
            color: "#5FD9BC",
            marginBottom: 18,
          }}
        >
          0.35× SLOW-MO
        </Interactive.Div>
        <Interactive.Div
          name="Title · stages"
          style={{
            fontSize: 52,
            fontWeight: 600,
            letterSpacing: -1.2,
            lineHeight: 1.14,
            color: "#FFFFFF",
          }}
        >
          Five stages in under two seconds
        </Interactive.Div>
      </Interactive.Div>

      <Interactive.Div
        name="Caption · settlement"
        style={{
          position: "absolute",
          left: 72,
          top: 92,
          width: 556,
          opacity: interpolate(frame, [214, 226, 324, 336], [0, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <Interactive.Div
          name="Kicker · settlement"
          style={{
            fontFamily: "JetBrains Mono",
            fontSize: 24,
            fontWeight: 500,
            letterSpacing: 3.5,
            color: "#FFC46B",
            marginBottom: 18,
          }}
        >
          10× FAST-FORWARD
        </Interactive.Div>
        <Interactive.Div
          name="Title · settlement"
          style={{
            fontSize: 52,
            fontWeight: 600,
            letterSpacing: -1.2,
            lineHeight: 1.14,
            color: "#FFFFFF",
          }}
        >
          The worker settles the escrow
        </Interactive.Div>
      </Interactive.Div>

      <Interactive.Div
        name="Support · settlement"
        style={{
          position: "absolute",
          left: 72,
          top: 864,
          width: 556,
          fontSize: 30,
          fontWeight: 400,
          lineHeight: 1.4,
          color: "#93C4BC",
          opacity: interpolate(frame, [226, 240, 324, 336], [0, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        36 real seconds of waiting, compressed here.
      </Interactive.Div>

      <Interactive.Div
        name="Caption · completed"
        style={{
          position: "absolute",
          left: 72,
          top: 92,
          width: 556,
          opacity: interpolate(frame, [330, 344], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <Interactive.Div
          name="Kicker · completed"
          style={{
            fontFamily: "JetBrains Mono",
            fontSize: 24,
            fontWeight: 500,
            letterSpacing: 3.5,
            color: "#5FD9BC",
            marginBottom: 18,
          }}
        >
          FINAL STATE
        </Interactive.Div>
        <Interactive.Div
          name="Title · completed"
          style={{
            fontSize: 52,
            fontWeight: 600,
            letterSpacing: -1.2,
            lineHeight: 1.14,
            color: "#FFFFFF",
          }}
        >
          COMPLETED — payment released
        </Interactive.Div>
      </Interactive.Div>

      <Interactive.Div
        name="Stage 1"
        style={{
          position: "absolute",
          left: 72,
          top: 372,
          display: "flex",
          alignItems: "center",
          gap: 22,
          opacity: interpolate(frame, [47, 59], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [47, 63], ["-26px 0px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <span
          style={{
            width: 46,
            height: 46,
            borderRadius: 9999,
            backgroundColor: "#14946B",
            color: "#FFFFFF",
            fontSize: 24,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          1
        </span>
        <span style={{ fontSize: 31, fontWeight: 500, color: "#FFFFFF" }}>
          Executor registered
        </span>
      </Interactive.Div>

      <Interactive.Div
        name="Stage 2"
        style={{
          position: "absolute",
          left: 72,
          top: 452,
          display: "flex",
          alignItems: "center",
          gap: 22,
          opacity: interpolate(frame, [80, 92], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [80, 96], ["-26px 0px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <span
          style={{
            width: 46,
            height: 46,
            borderRadius: 9999,
            backgroundColor: "#14946B",
            color: "#FFFFFF",
            fontSize: 24,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          2
        </span>
        <span style={{ fontSize: 31, fontWeight: 500, color: "#FFFFFF" }}>
          Task created · $10 reserve
        </span>
      </Interactive.Div>

      <Interactive.Div
        name="Stage 3"
        style={{
          position: "absolute",
          left: 72,
          top: 532,
          display: "flex",
          alignItems: "center",
          gap: 22,
          opacity: interpolate(frame, [115, 127], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [115, 131], ["-26px 0px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <span
          style={{
            width: 46,
            height: 46,
            borderRadius: 9999,
            backgroundColor: "#14946B",
            color: "#FFFFFF",
            fontSize: 24,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          3
        </span>
        <span style={{ fontSize: 31, fontWeight: 500, color: "#FFFFFF" }}>
          Bid $9 · $10 collateral locked
        </span>
      </Interactive.Div>

      <Interactive.Div
        name="Stage 4"
        style={{
          position: "absolute",
          left: 72,
          top: 612,
          display: "flex",
          alignItems: "center",
          gap: 22,
          opacity: interpolate(frame, [158, 170], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [158, 174], ["-26px 0px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <span
          style={{
            width: 46,
            height: 46,
            borderRadius: 9999,
            backgroundColor: "#3B6EE0",
            color: "#FFFFFF",
            fontSize: 24,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          4
        </span>
        <span style={{ fontSize: 31, fontWeight: 500, color: "#FFFFFF" }}>
          Automatic assignment
        </span>
      </Interactive.Div>

      <Interactive.Div
        name="Stage 5"
        style={{
          position: "absolute",
          left: 72,
          top: 692,
          display: "flex",
          alignItems: "center",
          gap: 22,
          opacity: interpolate(frame, [194, 206], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [194, 210], ["-26px 0px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <span
          style={{
            width: 46,
            height: 46,
            borderRadius: 9999,
            backgroundColor: "#14946B",
            color: "#FFFFFF",
            fontSize: 24,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          5
        </span>
        <span style={{ fontSize: 31, fontWeight: 500, color: "#FFFFFF" }}>
          Result + SHA-256 hash
        </span>
      </Interactive.Div>

      <Interactive.Div
        name="Stage 6"
        style={{
          position: "absolute",
          left: 72,
          top: 772,
          display: "flex",
          alignItems: "center",
          gap: 22,
          opacity: interpolate(frame, [347, 359], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [347, 363], ["-26px 0px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <span
          style={{
            width: 46,
            height: 46,
            borderRadius: 9999,
            backgroundColor: "#EAFBF5",
            color: "#0A6D60",
            fontSize: 24,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          6
        </span>
        <span style={{ fontSize: 31, fontWeight: 500, color: "#5FD9BC" }}>
          Escrow settled
        </span>
      </Interactive.Div>

      <Interactive.Div
        name="Panel footer"
        style={{
          position: "absolute",
          left: 72,
          top: 1000,
          fontFamily: "JetBrains Mono",
          fontSize: 22,
          letterSpacing: 1.5,
          color: "#4F827B",
        }}
      >
        localhost:5173
      </Interactive.Div>

      <Interactive.Div
        name="Cursor"
        style={{
          position: "absolute",
          left: 1829,
          top: 206,
          opacity: interpolate(frame, [6, 16, 46, 56], [0, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [8, 44], ["-647px 594px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.4, 0, 0.2, 1),
          }),
        }}
      >
        <svg
          width={54}
          height={54}
          viewBox="0 0 24 24"
          fill="#FFFFFF"
          stroke="#062A26"
          strokeWidth={1.1}
        >
          <path d="M5 2.5 5 19.2 9.3 15.1 11.9 21.3 14.6 20.1 12 14 17.8 13.6z" />
        </svg>
      </Interactive.Div>

      <Interactive.Div
        name="Click pulse"
        style={{
          position: "absolute",
          left: 1775,
          top: 152,
          width: 108,
          height: 108,
          borderRadius: 9999,
          border: "5px solid #5FD9BC",
          opacity: interpolate(frame, [44, 50, 68], [0, 0.85, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          scale: interpolate(frame, [44, 68], [0.35, 1.5], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
            output: "perceptual-scale",
          }),
        }}
      />
    </AbsoluteFill>
  );
};
