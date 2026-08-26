#!/usr/bin/env bash
# Record the real Minecraft client window to video.
#
#   tools/record_client.sh [seconds] [fps] [outfile]
#
# Why grim and not ffmpeg's screen grabbers: this is a Hyprland/Wayland session, so x11grab
# only sees XWayland surfaces unreliably and kmsgrab needs root. grim talks the compositor's
# own screencopy protocol, captures a named region, and measured 33ms per 1920x1080 frame -
# fast enough for ~15fps. Frames are piped straight into ffmpeg so nothing is written to disk
# except the finished video.
#
# The client renders on the GTX 1070, so unlike tools/timelapse.mjs this costs almost nothing
# and the textures are correct by definition - it IS Minecraft.
set -euo pipefail

SECONDS_TO_RECORD="${1:-120}"
FPS="${2:-15}"
OUT="${3:-recordings/client-$(date +%Y%m%d-%H%M%S).mp4}"

# Find the game window's current geometry from the compositor, so the recording follows a
# resize instead of hard-coding a rectangle.
GEO=$(hyprctl clients -j | python3 -c "
import json,sys
w=[c for c in json.load(sys.stdin) if 'inecraft' in str(c.get('class',''))]
if not w: raise SystemExit('no minecraft window')
c=w[0]; x,y=c['at']; ww,hh=c['size']
# even dimensions: libx264 yuv420p requires them
print(f\"{x},{y} {ww - ww%2}x{hh - hh%2}\")
")
echo "[record] window region: $GEO  ${SECONDS_TO_RECORD}s @ ${FPS}fps -> $OUT"
mkdir -p "$(dirname "$OUT")"

FRAMES=$(( SECONDS_TO_RECORD * FPS ))
DELAY=$(python3 -c "print(1.0/$FPS)")

{
  for ((i=0; i<FRAMES; i++)); do
    grim -l 0 -t ppm -g "$GEO" - || break
    sleep "$DELAY"
  done
} | ffmpeg -hide_banner -loglevel error -y -f image2pipe -framerate "$FPS" -i - \
      -c:v libx264 -preset veryfast -pix_fmt yuv420p -movflags +faststart "$OUT"

echo "[record] wrote $OUT ($(du -h "$OUT" | cut -f1))"
