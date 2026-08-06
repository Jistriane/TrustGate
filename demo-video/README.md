# TrustGate — demo video

A 27.6s demo (1920×1080, 30fps) built with [Remotion](https://remotion.dev) on top of a
recording of **one real run** of the app against the live API.

Output: `out/trustgate-demo.mp4`

## Structure

| Scene     | Frames  | Shows |
|-----------|---------|-------|
| `Opening` | 0–104   | Brand card |
| `Run`     | 90–584  | The run recording, narrated from the left panel |
| `Result`  | 570–734 | The settled-task card with the SHA-256 hash highlighted |
| `Closing` | 720–824 | Run metrics and signature |

Scenes overlap by 15 frames because of the `TransitionSeries` crossfades. Each one is
also registered as its own composition under the **Scenes** folder in Studio, so a
single scene can be opened and adjusted in isolation.

## Editing

```bash
npm i
npm run dev          # opens Remotion Studio
```

Copy, colors and keyframes are inline in each `Interactive.*` element's `style`, so they
are editable straight from Studio and are written back to the code.

```bash
npx remotion render TrustGateDemo out/trustgate-demo.mp4 --crf=18
```

## Re-recording the demo

Requires the frontend on `http://localhost:5173` **with the API up** — the header has to
read "API online", otherwise the run fails halfway through.

```bash
npx playwright install ffmpeg   # once — Playwright's recorder needs that binary
npm run capture                 # records a real run -> capture/out/
npm run hero                    # re-paces the recording -> public/hero.mp4
```

After re-recording, three things need to be reconciled:

1. **`capture/out/timings.json`** holds the real milestones of the new run. The cuts in
   `capture/build-hero.sh` are hardcoded to the timings of the current recording —
   update them.
2. **The duration of `hero.mp4`** drives the `durationInFrames` of the `<Video>` in
   `src/trustgate/RunScene.tsx` (currently 499) and the length of the `Run` scene (495).
3. **The overlays** in `RunScene.tsx` are keyed to output frames of the re-paced clip
   (stages at 47/80/115/158/194, settlement 222–328, result 347). If the ratios change,
   those numbers change with them.

`capture/out/stills/10-result.png` is the source of `public/result.png` — captured at 2x,
it is what keeps the hash and the addresses sharp in the `Result` scene.

## About the secret keys

The run generates throwaway keypairs in the browser and the app prints them in the result
panel. The capture script blurs the two secret-key rows (`Requester key` / `Executor key`)
before recording, so the footage is safe to publish. Public keys, the Task ID and the
payload hash are left untouched — they are the proof of the run.

## Numbers shown in the video

All of them come from the recorded run, none are illustrative: 6/6 stages, 38.3s from
executor registration to settled escrow, $10 reserve, $9 bid, $10 collateral. The
settlement scene is labelled 10× fast-forward and the stage scene 0.35× slow-mo.
