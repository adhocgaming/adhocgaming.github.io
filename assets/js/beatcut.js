/*
 * Ad Hoc Gaming — beat-cut background
 *
 * Fast-cuts between shots of muted gameplay footage, locked to the beat of the theme song.
 *
 *  - The song plays in the SoundCloud embed. That's a cross-origin iframe, so the page can't listen
 *    to the audio; instead the SoundCloud Widget API reports the playback position a few times a
 *    second and we keep a clock from it. Because the clock follows the song's position (not a timer
 *    started at page load) it stays in sync through loops, pauses, seeks and buffering.
 *  - Two <video> elements take turns: one is on screen while the other is cued to a random spot in a
 *    random clip. On every cut they swap (a hard cut, no fade).
 *  - Tempo and beat position come from data attributes on .bg (data-bpm, data-offset, data-cut-beats).
 *    Open the page with ?tune to measure them by tapping along to the song.
 *  - No clips listed in clips.json → nothing happens and the page looks exactly as it did before.
 */
(() => {
  'use strict';

  const root = document.querySelector('.bg');
  if (!root) return;

  const html = document.documentElement;
  const vids = [...root.querySelectorAll('video')];
  const frame = document.querySelector('.player__frame iframe');
  const hint = document.querySelector('.sound-hint');

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const net = navigator.connection || {};
  const dataSaver = !!net.saveData || /2g/.test(net.effectiveType || '');

  /* ---------------------------------------------------------------- config */

  const read = (name, fallback) => {
    const n = parseFloat(root.dataset[name]);
    return Number.isFinite(n) ? n : fallback;
  };
  const cfg = {
    bpm: Math.max(30, read('bpm', 120)),
    offset: read('offset', 0), // ms into the track where a beat lands
    cutBeats: Math.max(0.25, read('cutBeats', 1)), // cut every N beats
  };

  // Photosensitivity guard: never cut faster than ~3 times a second, however fast the song is.
  // The cut length is always a whole multiple of cutBeats, so it stays on the beat grid.
  const MIN_CUT_MS = 330;
  const cutMs = () => {
    const unit = (60000 / cfg.bpm) * cfg.cutBeats;
    return unit * Math.ceil(MIN_CUT_MS / unit - 1e-9);
  };

  /* ----------------------------------------------------------------- clock */

  let mode = 'free'; // free: song hasn't started, run on our own · locked: following the song · paused: listener paused it
  let hasPlayed = false;
  let samples = [];
  let skew = 0; // performance.now() minus the song position
  const t0 = performance.now();

  const songPos = () => performance.now() - (mode === 'locked' ? skew : t0);

  function onProgress(posMs) {
    const s = performance.now() - posMs;
    // Widget messages can arrive late but never early, so the least-late recent sample is the closest to the truth.
    if (samples.length && Math.abs(s - skew) > 750) samples = []; // the song was seeked or looped
    samples.push(s);
    if (samples.length > 16) samples.shift();
    skew = Math.min(...samples);
    mode = 'locked';
  }

  /* ----------------------------------------------------------------- clips */

  let clips = [];
  let live = false;
  let lastClip = -1;
  const stats = { cuts: 0, skipped: 0 };
  let front = vids[0];
  let back = vids[1];

  async function loadClips() {
    const url = new URL(root.dataset.clips, location.href);
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    return (Array.isArray(json) ? json : json.clips || [])
      .map((c) => (typeof c === 'string' ? { src: c } : c))
      .filter((c) => c && c.src)
      .map((c) => ({ ...c, src: new URL(c.src, url).href }));
  }

  const ready = (v) => !!v.dataset.src && v.readyState >= 2 && !v.seeking;

  // Cue a video to a random spot in a random clip (never the same clip twice in a row).
  function cue(v) {
    let i;
    do {
      i = Math.floor(Math.random() * clips.length);
    } while (clips.length > 1 && i === lastClip);
    lastClip = i;
    const clip = clips[i];

    const seek = () => {
      const need = cutMs() / 1000 + 0.3; // the shot has to last until the next cut
      const end = Math.min(clip.end ?? Infinity, Number.isFinite(v.duration) ? v.duration : Infinity);
      const hi = end - need;
      const lo = Math.min(clip.start ?? 0, hi);
      v.currentTime = Number.isFinite(hi) ? Math.max(0, lo + Math.random() * Math.max(0, hi - lo)) : clip.start ?? 0;
    };

    if (v.dataset.src !== clip.src) {
      v.dataset.src = clip.src;
      v.onloadedmetadata = seek;
      v.src = clip.src;
    } else if (v.readyState >= 1) {
      seek();
    } else {
      v.onloadedmetadata = seek;
    }
  }

  function dropClip(v) {
    clips = clips.filter((c) => c.src !== v.dataset.src);
    v.removeAttribute('src');
    v.dataset.src = '';
    if (!clips.length) {
      live = false;
      html.classList.remove('has-bg');
    } else {
      cue(v);
    }
  }

  function swap() {
    back.classList.add('is-front');
    front.classList.remove('is-front');
    back.play().catch(() => {}); // muted, so allowed; if a browser still refuses, the frame just holds
    front.pause();
    [front, back] = [back, front];
    lastSwap = performance.now();
    stats.cuts++;
    cue(back);
  }

  /* ------------------------------------------------------------- main loop */

  const LATE_OK_MS = 120; // a cut this late is still on the beat as far as anyone can tell
  let lastIdx = NaN;
  let lastSwap = -Infinity;
  let pending = false;

  function tick() {
    requestAnimationFrame(tick);
    if (!clips.length || document.hidden) return;

    if (!live) {
      if (!ready(front)) return;
      live = true;
      front.classList.add('is-front');
      if (!reduceMotion) front.play().catch(() => {});
      html.classList.add('has-bg');
    }
    if (reduceMotion || mode === 'paused') return;

    const len = cutMs();
    const t = songPos() - cfg.offset;
    const idx = Math.floor(t / len);
    if (idx !== lastIdx) {
      lastIdx = idx;
      pending = true;
    }
    if (!pending) return;
    if (t - idx * len > LATE_OK_MS) {
      // missed the window (the next shot wasn't loaded in time): hold this shot rather than flash black
      pending = false;
      stats.skipped++;
    } else if (performance.now() - lastSwap < MIN_CUT_MS * 0.85) {
      // the clock just locked onto the song (or the song looped) and a beat landed right after a cut:
      // hold the shot so the guard on cut speed holds even at those moments
      pending = false;
    } else if (ready(back)) {
      pending = false;
      swap();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) front.pause();
  });

  async function start() {
    if (dataSaver || vids.length < 2) return;
    try {
      clips = await loadClips();
    } catch {
      clips = [];
    }
    if (!clips.length) return;
    // reduced motion shows one still frame, so there's no second shot to cue
    (reduceMotion ? vids.slice(0, 1) : vids).forEach((v) => {
      v.muted = true;
      v.addEventListener('error', () => dropClip(v));
      cue(v);
    });
    requestAnimationFrame(tick);
  }

  /* --------------------------------------------- theme song (SoundCloud) */

  function bindSong() {
    if (!frame || !window.SC || !SC.Widget) return; // blocked or offline: cuts just run on their own clock
    const widget = SC.Widget(frame);
    const E = SC.Widget.Events;
    let playing = false;
    let kicked = false;
    let stopAsking = () => {};

    widget.bind(E.PLAY_PROGRESS, (e) => {
      // progress only arrives while the song is playing, so this also covers a PLAY we weren't listening for yet
      if (!playing) {
        playing = hasPlayed = true;
        stopAsking();
      }
      onProgress(e.currentPosition);
    });
    widget.bind(E.PLAY, () => {
      playing = hasPlayed = true;
      samples = [];
      if (mode === 'paused') mode = 'free';
      stopAsking();
    });
    widget.bind(E.PAUSE, () => {
      playing = false;
      samples = [];
      if (hasPlayed) {
        mode = 'paused';
        front.pause();
      }
    });
    // loop forever
    widget.bind(E.FINISH, () => {
      widget.seek(0);
      widget.play();
    });

    // Try to start the song on load. Browsers usually refuse sound before the first tap, so if it hasn't
    // started shortly, show a hint and start it on the first tap / key press instead.
    const kick = () => {
      if (kicked) return;
      kicked = true;
      widget.play();
      setTimeout(() => {
        if (playing) return;
        const go = () => widget.play();
        const events = ['pointerup', 'mousedown', 'touchend', 'keydown'];
        events.forEach((n) => addEventListener(n, go, { capture: true, passive: true }));
        if (hint) hint.hidden = false;
        stopAsking = () => {
          events.forEach((n) => removeEventListener(n, go, true));
          if (hint) hint.hidden = true;
        };
      }, 2500);
    };
    widget.bind(E.READY, kick);
    setTimeout(kick, 3000); // in case READY fired before we were listening
  }

  /* ------------------------------------------------ ?tune: find bpm/offset */

  function tune() {
    const hud = document.createElement('pre');
    hud.className = 'tune-hud';
    document.body.append(hud);
    const taps = [];
    const phases = [];

    const draw = () => {
      const beat = 60000 / cfg.bpm;
      hud.textContent = [
        `TUNE   ${mode}   cuts ${stats.cuts}   skipped ${stats.skipped}`,
        `cut every ${Math.round(cutMs())}ms  (beat ${Math.round(beat)}ms)`,
        '',
        `data-bpm="${cfg.bpm.toFixed(1)}" data-offset="${Math.round(cfg.offset)}"`,
        '',
        'T  tap along with the beat (8+ taps)',
        'B  tap on a strong beat / downbeat (needs the song playing)',
        'R  start over',
      ].join('\n');
    };

    addEventListener('keydown', (e) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 't') {
        const now = performance.now();
        if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
        taps.push(now);
        if (taps.length > 16) taps.shift();
        if (taps.length > 2) cfg.bpm = 60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1));
      } else if (key === 'b' && mode === 'locked') {
        // average the phases on a circle, so taps either side of the beat boundary don't cancel out
        const period = cutMs();
        phases.push(((songPos() % period) / period) * 2 * Math.PI);
        if (phases.length > 12) phases.shift();
        const sin = phases.reduce((a, p) => a + Math.sin(p), 0);
        const cos = phases.reduce((a, p) => a + Math.cos(p), 0);
        cfg.offset = (((Math.atan2(sin, cos) / (2 * Math.PI)) * period) % period + period) % period;
      } else if (key === 'r') {
        taps.length = phases.length = 0;
      }
      draw();
    });
    draw();
    setInterval(draw, 500);
  }

  if (new URLSearchParams(location.search).has('tune')) tune();
  bindSong();
  start();
})();
