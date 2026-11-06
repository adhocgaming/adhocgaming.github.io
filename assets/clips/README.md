# Background footage

The home page fast-cuts between shots from the clips listed in `clips.json`, on the beat of the
theme song. While that list is empty (as shipped) the background stays off and the page looks as before.

## Add footage

1. **Re-encode each recording for the web**: silent, 720p, with a keyframe every half second so
   jumping to a random moment is instant.

   ```sh
   ffmpeg -ss 00:03:10 -t 60 -i recording.mp4 -an -vf "scale=-2:720,fps=30" \
     -c:v libx264 -preset slow -crf 26 -g 15 -keyint_min 15 -sc_threshold 0 \
     -pix_fmt yuv420p -movflags +faststart clip.mp4
   ```

   (`-ss` / `-t` pick the start and length to keep; drop them to use the whole recording.)

2. **Put the file in this folder and list it in `clips.json`:**

   ```json
   ["clip.mp4"]
   ```

   To skip loading screens, champ select or menus, give a clip a window (seconds) to cut from:

   ```json
   [{ "src": "clip.mp4", "start": 12, "end": 95 }]
   ```

3. **Keep it light.** Every visitor downloads these. One 30–60 second reel of highlights
   (about 10–15 MB) cuts more smoothly than many separate files. Only use footage you have the
   right to use.

## Sync to the song

The page follows the SoundCloud player's playback position, so cuts stay locked through loops,
pauses and buffering. It needs two numbers, set on the `.bg` element in `index.html`:

| attribute        | meaning                                                              | shipped |
| ---------------- | -------------------------------------------------------------------- | ------- |
| `data-bpm`       | the song's tempo                                                     | `120` (placeholder) |
| `data-offset`    | milliseconds into the track where a beat lands                       | `0` (placeholder) |
| `data-cut-beats` | cut every N beats (never faster than about 3 cuts a second, whatever the tempo) | `1` |

To find the real values, open the site with `?tune` (for example `https://…/?tune`), let the song
play, and:

- press **T** in time with the beat (8+ taps) to measure the tempo;
- press **B** on strong beats / downbeats (a handful of times) to measure the offset.

The read-out shows ready-to-paste `data-bpm="…" data-offset="…"` values. Tempo is read live, so
you can watch the cuts lock on while you tap.
