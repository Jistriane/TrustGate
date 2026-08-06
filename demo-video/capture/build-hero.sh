#!/usr/bin/env bash
# Re-paces the raw recording into public/hero.mp4.
#
# A real run is badly paced for video: the five fast stages finish in ~1.8s
# (unreadable) and the escrow settlement then takes ~36s (dead air). This cuts
# the take into four segments and gives each its own speed, producing a
# constant-30fps clip whose timeline the Remotion overlays are keyed to.
#
# The boundaries below come from capture/out/timings.json of the take that is
# currently in public/. Re-record => re-read timings.json => update these.
#
#   ready 1.65  click 3.23  register 3.24  create 3.65  bid 4.06
#   assign 4.56  publish 4.98  complete 41.51  result 41.51
#   scrollStart 42.92  scrollEnd 45.74  end 47.75
#
# Segments (source seconds -> speed -> output seconds):
#   A  1.70 - 3.26   1x      0.00 - 1.56   idle, cursor to the button
#   B  3.26 - 5.30   0.35x   1.56 - 7.39   the five stages, slowed to be read
#   C  5.30 - 40.90  10x     7.39 - 10.95  escrow settlement, compressed
#   D 40.90 - 46.60  1x     10.95 - 16.65  result panel + scroll
#
# RunScene.tsx keys its overlays to the output column: stage marks at frames
# 47 / 80 / 115 / 158 / 194, settlement 222-328, result 347.
set -euo pipefail

cd "$(dirname "$0")"
SRC=$(ls out/video/*.webm | head -1)
DEST="../public/hero.mp4"

ffmpeg -y -loglevel error -i "$SRC" -filter_complex "\
[0:v]trim=start=1.70:end=3.26,setpts=PTS-STARTPTS[a];\
[0:v]trim=start=3.26:end=5.30,setpts=(PTS-STARTPTS)/0.35[b];\
[0:v]trim=start=5.30:end=40.90,setpts=(PTS-STARTPTS)/10[c];\
[0:v]trim=start=40.90:end=46.60,setpts=PTS-STARTPTS[d];\
[a][b][c][d]concat=n=4:v=1:a=0,fps=30,format=yuv420p[v]" \
  -map "[v]" -c:v libx264 -crf 17 -preset medium -movflags +faststart "$DEST"

echo "wrote $DEST"
ffprobe -v error -show_entries stream=width,height,nb_frames -show_entries format=duration \
  -of default=noprint_wrappers=1 "$DEST"
echo "If the frame count moved, update durationInFrames in RunScene.tsx (currently 499)."
