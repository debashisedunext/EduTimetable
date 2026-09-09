/**
 * §24 — marking a completed step: a burst of colour and a short sound.
 *
 * Eleven steps is a long way, and the thing that gets somebody to the end of a
 * long form is knowing that the last bit worked. So each committed step gets a
 * half-second of celebration.
 *
 * Four rules keep it from becoming the thing people mute the tab over:
 *
 *  - **`prefers-reduced-motion` turns off the animation entirely**, and the
 *    sound with it. Somebody who has told their operating system that motion
 *    makes them unwell has already answered this question, and asking again
 *    with a toggle in our UI would be ignoring the answer.
 *  - **Sound is off unless it has been asked for.** A browser blocks autoplay
 *    for good reasons, and a school office is a shared room. It is opt-in and
 *    remembered, and the wizard shows the switch.
 *  - **No asset files.** The burst is canvas, the sound is two oscillators.
 *    A confetti library and an mp3 for a half-second flourish is weight on
 *    every page load for something most people see eleven times, ever.
 *  - **It never blocks.** Everything is fire-and-forget: a browser that refuses
 *    audio, a canvas that will not paint, a tab in the background — the step
 *    still completed, and the setup carries on.
 */

const SOUND_KEY = "edutt.setupSound";

export const soundEnabled = (): boolean => {
  try {
    return localStorage.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
};

export const setSoundEnabled = (on: boolean): void => {
  try {
    localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    /* a browser refusing storage should still be usable */
  }
};

const reducedMotion = (): boolean => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

/**
 * Two short notes, a fifth apart, on a fast decay.
 *
 * Built rather than played: an oscillator costs nothing to ship and cannot fail
 * to load. Triangle rather than sine because a pure tone at this length reads
 * as a system error; a rising interval reads as "done".
 */
function chime(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    // A step advances on a click, so the context is allowed to start. If the
    // browser disagrees, nothing happens and nothing breaks.
    const now = ctx.currentTime;
    [
      { freq: 587.33, at: 0 },      // D5
      { freq: 880.0, at: 0.09 },    // A5
    ].forEach(({ freq, at }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      // Quiet, and quick. Loud enough to notice in a room with people in it,
      // not loud enough to make somebody reach for the volume key.
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.09, now + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.26);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.3);
    });
    // Release the hardware rather than leaving a context open per step.
    window.setTimeout(() => void ctx.close().catch(() => undefined), 700);
  } catch {
    /* no audio is not a failure worth reporting */
  }
}

interface Bit {
  x: number; y: number; vx: number; vy: number;
  size: number; spin: number; angle: number; color: string;
}

/** The app's own palette — a celebration in colours the product does not use reads as someone else's. */
const COLOURS = ["#2563EB", "#0891B2", "#B9791A", "#5578A8", "#1E4FC4"];

/**
 * A burst of paper from a point, under gravity, gone in about a second.
 *
 * Drawn on a canvas laid over everything and removed when it finishes, so
 * nothing is left in the DOM and nothing can intercept a click while it runs.
 */
export function sparkle(origin?: { x: number; y: number }): void {
  if (reducedMotion()) return;
  try {
    const canvas = document.createElement("canvas");
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    Object.assign(canvas.style, {
      position: "fixed", inset: "0", width: `${w}px`, height: `${h}px`,
      pointerEvents: "none", zIndex: "9999",
    } as CSSStyleDeclaration);
    document.body.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    if (!ctx) { canvas.remove(); return; }
    ctx.scale(dpr, dpr);

    const from = origin ?? { x: w / 2, y: h * 0.38 };
    const bits: Bit[] = Array.from({ length: 90 }, () => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 3 + Math.random() * 7;
      return {
        x: from.x, y: from.y,
        vx: Math.cos(angle) * speed,
        // Biased upward, so it arcs rather than falling straight out.
        vy: Math.sin(angle) * speed - 3.5,
        size: 4 + Math.random() * 5,
        spin: (Math.random() - 0.5) * 0.35,
        angle: Math.random() * Math.PI,
        color: COLOURS[Math.floor(Math.random() * COLOURS.length)],
      };
    });

    const started = performance.now();
    const DURATION = 1100;
    const tick = (now: number) => {
      const elapsed = now - started;
      if (elapsed > DURATION) { canvas.remove(); return; }
      ctx.clearRect(0, 0, w, h);
      // Fade the whole burst out rather than letting pieces vanish mid-air.
      ctx.globalAlpha = Math.max(0, 1 - elapsed / DURATION);
      for (const b of bits) {
        b.x += b.vx;
        b.y += b.vy;
        b.vy += 0.22;      // gravity
        b.vx *= 0.99;      // drag
        b.angle += b.spin;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.angle);
        ctx.fillStyle = b.color;
        ctx.fillRect(-b.size / 2, -b.size / 2, b.size, b.size * 0.6);
        ctx.restore();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch {
    /* a celebration that fails is not an error */
  }
}

/** The whole flourish: colour, and sound if it was asked for. */
export function celebrate(origin?: { x: number; y: number }): void {
  sparkle(origin);
  if (soundEnabled() && !reducedMotion()) chime();
}
