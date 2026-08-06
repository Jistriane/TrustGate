import { Composition, Folder } from "remotion";
import "./index.css";
import "./fonts";
import { ClosingScene } from "./trustgate/ClosingScene";
import { Opening } from "./trustgate/Opening";
import { ResultScene } from "./trustgate/ResultScene";
import { RunScene } from "./trustgate/RunScene";
import { TrustGateDemo } from "./trustgate/TrustGateDemo";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="TrustGateDemo"
        component={TrustGateDemo}
        durationInFrames={825}
        fps={30}
        width={1920}
        height={1080}
      />
      <Folder name="Scenes">
        <Composition
          id="Opening"
          component={Opening}
          durationInFrames={105}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="Run"
          component={RunScene}
          durationInFrames={495}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="Result"
          component={ResultScene}
          durationInFrames={165}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="Closing"
          component={ClosingScene}
          durationInFrames={105}
          fps={30}
          width={1920}
          height={1080}
        />
      </Folder>
    </>
  );
};
