/**
 * §39 — the front door's left half.
 *
 * The sign-in page was a 440px card centred on an empty page: correct, and it
 * told a school nothing about what it was signing in to. This is the other
 * half — three slides that auto-advance, each showing one thing the product
 * actually does.
 *
 * ## Drawn, not screenshotted
 *
 * The obvious build is three PNGs of real screens. It is the wrong one here for
 * three reasons that all bite later:
 *
 * 1. **There is nowhere to put them.** §17.4a settled this for the school logo:
 *    there is no file storage, no image route, and no unauthenticated asset
 *    path — which is why a logo is a `data:` URI in a column. Three screenshots
 *    would be three megabytes of base64 in a bundle, or a new piece of
 *    infrastructure for a decorative panel.
 * 2. **A screenshot goes stale silently.** The Master Grid changed shape five
 *    times this year; a picture of it does not, and nothing fails when it stops
 *    being true. These are built from the same CSS variables as the real
 *    screens, so they follow the product rather than remembering it.
 * 3. **They cannot animate.** The first slide's whole point is that the week
 *    *fills itself in* — which is the thing a timetable product has to show
 *    rather than claim.
 *
 * ## Motion is optional, and the copy is not
 *
 * `prefers-reduced-motion` stops the auto-advance and every card animation, and
 * leaves the dots working. Somebody who has asked their machine to stop moving
 * things still gets all three slides, by pressing. The words carry the message;
 * the movement only makes the first one vivid.
 *
 * Auto-advance also pauses on hover and on focus-within — a slide that changes
 * under the pointer while somebody is reading it is worse than one that never
 * moved.
 */
import { useEffect, useRef, useState } from "react";

/* ─────────────────────────────────────────────────────────── the artefacts */

const DAYS = ["M", "T", "W", "T", "F"];

/**
 * Slide 1 — a week filling itself in.
 *
 * Deliberately a real shape rather than a pretty one: five days across,
 * six periods down, a break band, and §10.5's subject colours. The cards land
 * in a staggered sequence, which is what generation looks like from the outside.
 */
function GridArt({ animate }: { animate: boolean }) {
  const HUES = ["#7FD6C0", "#86B6F5", "#F5C07F", "#C7A6F0", "#8ED8EA", "#F09CB0"];
  /*
    Keyed by cell, with the placement ORDER kept — the stagger below reads it,
    and a lookup that had to scan a list would make the order depend on where a
    cell happened to sit in it.
  */
  const cells = new Map<string, { hue: string; order: number }>();
  let n = 0;
  for (let p = 0; p < 6; p++) {
    for (let d = 0; d < 5; d++) {
      // A few holes, so it reads as a real week rather than a full rectangle.
      if ((p * 5 + d) % 7 === 3) continue;
      cells.set(`${p}:${d}`, { hue: HUES[n % HUES.length], order: n });
      n++;
    }
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "20px repeat(5, 1fr)", gap: 5 }}>
      <div />
      {DAYS.map((d, i) => (
        <div key={i} style={{
          font: "700 9px/1 var(--font-mono)", color: "rgba(255,255,255,.55)",
          textAlign: "center", paddingBottom: 3, letterSpacing: ".06em",
        }}>{d}</div>
      ))}
      {[0, 1, 2, 3, 4, 5].map((p) => (
        <div key={`r${p}`} style={{ display: "contents" }}>
          {/* The break, spanning the week — `daySegments: [3, 3]`, the same
              shape the solver's own fixture uses. Without it this is a grid of
              squares; with it, it is a school day. */}
          {p === 3 && (
            <div style={{
              gridColumn: "1 / -1", height: 9, margin: "2px 0", borderRadius: 3,
              background: "repeating-linear-gradient(45deg, rgba(255,255,255,.1) 0 4px, transparent 4px 8px)",
              border: "1px solid rgba(255,255,255,.1)",
            }} />
          )}
          <div style={{
            font: "700 8.5px/1 var(--font-mono)", color: "rgba(255,255,255,.4)",
            display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 3,
          }}>{p + 1}</div>
          {DAYS.map((_, d) => {
            const cell = cells.get(`${p}:${d}`);
            return (
              <div key={`${p}-${d}`} style={{
                height: 26, borderRadius: 4,
                background: cell ? `${cell.hue}22` : "rgba(255,255,255,.05)",
                border: `1px solid ${cell ? `${cell.hue}55` : "rgba(255,255,255,.07)"}`,
                borderLeft: cell ? `2px solid ${cell.hue}` : "1px solid rgba(255,255,255,.07)",
                /*
                  Staggered by INDEX, so the week fills the way the solver
                  places — left to right, row by row — rather than everything
                  appearing at once, which would just be a fade.
                */
                animation: animate && cell ? "sc-drop 420ms cubic-bezier(.22,.68,.36,1) both" : undefined,
                animationDelay: animate && cell ? `${140 + cell.order * 38}ms` : undefined,
              }} />
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Slide 2 — the Readiness dial, counting up to green. */
function ReadinessArt({ animate }: { animate: boolean }) {
  const R = 42;
  const C = 2 * Math.PI * R;
  const CHECKS = [
    "Slot capacity per class-section",
    "Teacher load against true capacity",
    "Daily distribution and block packing",
    "Shared and special room contention",
  ];
  return (
    <div style={{ display: "flex", gap: 26, alignItems: "center" }}>
      <svg width="108" height="108" viewBox="0 0 108 108" aria-hidden style={{ flexShrink: 0 }}>
        <circle cx="54" cy="54" r={R} fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="8" />
        <circle
          cx="54" cy="54" r={R} fill="none" stroke="#7FD6C0" strokeWidth="8" strokeLinecap="round"
          transform="rotate(-90 54 54)"
          strokeDasharray={C}
          style={{
            // Reduced motion gets the finished dial, not a stuck empty one.
            strokeDashoffset: animate ? C : 0,
            animation: animate ? "sc-dial 1400ms cubic-bezier(.22,.68,.36,1) 200ms both" : undefined,
          }}
        />
        <text x="54" y="60" textAnchor="middle"
          style={{ font: "700 20px Inter, sans-serif", fill: "#fff" }}>100%</text>
      </svg>
      <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
        {CHECKS.map((c, i) => (
          <div key={c} style={{
            display: "flex", gap: 9, alignItems: "center", fontSize: 12.4,
            color: "rgba(255,255,255,.82)", lineHeight: 1.4,
            animation: animate ? "sc-rise 380ms ease both" : undefined,
            animationDelay: animate ? `${420 + i * 130}ms` : undefined,
          }}>
            <span aria-hidden style={{
              width: 14, height: 14, borderRadius: 4, background: "#7FD6C022",
              border: "1px solid #7FD6C0", color: "#7FD6C0", flexShrink: 0,
              display: "grid", placeItems: "center", font: "700 9px/1 Inter",
            }}>✓</span>
            {c}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Slide 3 — a cover suggested, ranked, with the reason. */
function SubstituteArt({ animate }: { animate: boolean }) {
  const PEOPLE = [
    { n: "Meera Shah", s: 94, why: "free · teaches the subject · same wing" },
    { n: "Ravi Kumar", s: 81, why: "free · light day · taught this class" },
    { n: "Nisha Rao", s: 62, why: "free · different subject" },
  ];
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "12px 13px",
        borderRadius: 8, background: "rgba(240,156,176,.12)", border: "1px solid rgba(240,156,176,.4)",
      }}>
        <span aria-hidden style={{ fontSize: 13 }}>🗓</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ font: "600 12px/1.3 Inter", color: "#fff" }}>Ajay Verma is away — Tue, 4 periods</div>
          <div style={{ fontSize: 10.6, color: "rgba(255,255,255,.6)", marginTop: 1 }}>
            Class 7-B Maths · P2, P3, P5, P6
          </div>
        </div>
      </div>
      {PEOPLE.map((p, i) => (
        <div key={p.n} style={{
          display: "flex", alignItems: "center", gap: 10, padding: "11px 13px",
          borderRadius: 8, background: "rgba(255,255,255,.06)",
          border: `1px solid ${i === 0 ? "rgba(127,214,192,.55)" : "rgba(255,255,255,.1)"}`,
          animation: animate ? "sc-rise 400ms ease both" : undefined,
          animationDelay: animate ? `${300 + i * 160}ms` : undefined,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ font: "600 12px/1.3 Inter", color: "#fff" }}>{p.n}</div>
            <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.58)", marginTop: 1 }}>{p.why}</div>
          </div>
          <div style={{
            font: "700 12px/1 var(--font-mono)", color: i === 0 ? "#7FD6C0" : "rgba(255,255,255,.5)",
            flexShrink: 0,
          }}>{p.s}</div>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────── the slides */

const SLIDES = [
  {
    key: "generate",
    eyebrow: "Phase B · the solver",
    title: "A week that builds itself",
    body: "Every class, every teacher, every room — placed at once, with no two lessons ever "
      + "competing for the same person or the same space.",
    art: GridArt,
  },
  {
    key: "readiness",
    eyebrow: "Phase A · the feasibility engine",
    title: "Know it will work before it runs",
    body: "Fourteen checks run over your master data before a single slot is placed — and each "
      + "one that fails names the exact row to fix.",
    art: ReadinessArt,
  },
  {
    key: "cover",
    eyebrow: "Every morning",
    title: "Cover an absence in seconds",
    body: "Who is free, who teaches the subject, who already knows the class — ranked, with the "
      + "reason, without touching the published week.",
    art: SubstituteArt,
  },
] as const;

/** How long each slide holds. Long enough to read the body twice. */
const DWELL_MS = 6200;

/**
 * The reading column.
 *
 * The panel takes whatever the window has left after the form, which on a wide
 * screen is 1,400px and more — far past the 65-character line the rest of this
 * app sets its prose to. Everything inside shares this width so the composition
 * reads as a column with margin, rather than as content that failed to fill.
 */
const COL = 560;

export function AuthShowcase() {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  /*
    Read from `matchMedia` in the initialiser, not from an effect.
    §8.8's lesson in a smaller frame: seeding `false` renders the animated tree
    first and swaps, so somebody who asked for no motion gets one burst of it.
  */
  const [still, setStill] = useState(
    () => typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const on = () => setStill(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  /*
    One timer, restarted whenever the slide or the pause state changes.

    An interval would drift out of step with a manual press — press a dot with
    200ms left on the tick and the new slide gets 200ms. A timeout keyed on `i`
    gives every slide its full dwell however it was reached.
  */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (still || paused) return;
    timer.current = setTimeout(() => setI((n) => (n + 1) % SLIDES.length), DWELL_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [i, paused, still]);

  return (
    <aside
      className="sc-panel"
      aria-label="What EduTimetable does"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      style={{
        position: "relative", overflow: "hidden", minWidth: 0,
        background: "var(--brand-deep)", color: "#fff",
        /*
          A three-row grid, not `justify-content: space-between` on a flex
          column.

          `space-between` pushes the three blocks to the extremes, which on a
          1,360px-wide panel left 450px of dead navy above the slide and the
          content hanging off the bottom — reported, and correctly, as "the top
          left is blank". Rows of `auto 1fr auto` pin the wordmark and the dots
          and let the SLIDE own everything between them, centred in it. The
          emptiness becomes symmetric margin instead of a gap at one end.
        */
        display: "grid",
        gridTemplateRows: "auto 1fr auto",
        padding: "36px 44px 30px",
      }}
    >
      {/*
        The ground. Two soft radial washes over the navy, plus a hairline grid —
        the same navy `--brand-deep` the signed-in rail uses, so the front door
        and the app are recognisably one product.
      */}
      <div aria-hidden style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        background:
          "radial-gradient(760px 520px at 12% 8%, rgba(37,99,235,.45), transparent 62%),"
          + "radial-gradient(620px 520px at 88% 96%, rgba(8,145,178,.38), transparent 60%)",
      }} />
      <div aria-hidden style={{
        position: "absolute", inset: 0, pointerEvents: "none", opacity: 0.5,
        backgroundImage:
          "linear-gradient(rgba(255,255,255,.045) 1px, transparent 1px),"
          + "linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px)",
        backgroundSize: "34px 34px",
        maskImage: "radial-gradient(70% 60% at 50% 40%, #000, transparent 100%)",
        WebkitMaskImage: "radial-gradient(70% 60% at 50% 40%, #000, transparent 100%)",
      }} />

      {/*
        Every row is capped at the same width and centred, so the wordmark, the
        slide and the dots share one left edge. Capped because the panel is as
        wide as the window minus the form: without it the body text ran to 1,200
        characters a line on a large screen, and the art card stretched to a
        thin band with a small dial marooned at one end.
      */}
      <div style={{ position: "relative", zIndex: 1, width: "100%", maxWidth: COL, margin: "0 auto" }}>
        <div style={{
          font: "700 11px/1 Inter", letterSpacing: ".14em", textTransform: "uppercase",
          color: "rgba(255,255,255,.5)",
        }}>
          Edu<span style={{ color: "#8ED8EA" }}>Timetable</span>
        </div>
      </div>

      {/*
        The slide. Keyed on the slide so React remounts it — which is what
        restarts the CSS animations; a re-render alone would leave them finished.
      */}
      <div style={{
        position: "relative", zIndex: 1, width: "100%", maxWidth: COL, margin: "0 auto",
        // Centred in the row it owns, and `minHeight: 0` so a short laptop
        // window shrinks the row rather than pushing the dots off the bottom.
        alignSelf: "center", minHeight: 0, padding: "24px 0",
      }}>
        {SLIDES.map((s, n) => {
          const Art = s.art;
          const on = n === i;
          return (
            <div
              key={s.key}
              // Only the visible slide is in the accessibility tree — three
              // stacked copies of the copy would be read as one run-on passage.
              aria-hidden={!on}
              style={{
                display: on ? "block" : "none",
                animation: still ? undefined : "sc-fade 460ms ease both",
              }}
            >
              <div style={{
                display: "inline-block", font: "700 10px/1 var(--font-mono)",
                letterSpacing: ".1em", textTransform: "uppercase",
                color: "#8ED8EA", background: "rgba(142,216,234,.12)",
                border: "1px solid rgba(142,216,234,.3)", borderRadius: 999,
                padding: "5px 10px", marginBottom: 14,
              }}>{s.eyebrow}</div>
              <h2 style={{
                fontFamily: "Fraunces, Georgia, serif", fontSize: 30, lineHeight: 1.12,
                margin: "0 0 10px", letterSpacing: "-.02em", textWrap: "balance",
              }}>{s.title}</h2>
              <p style={{
                fontSize: 13.6, lineHeight: 1.6, color: "rgba(255,255,255,.72)",
                margin: "0 0 24px", maxWidth: "46ch",
              }}>{s.body}</p>
              <div style={{
                background: "rgba(255,255,255,.055)", border: "1px solid rgba(255,255,255,.12)",
                borderRadius: 14, padding: 20, backdropFilter: "blur(2px)",
              }}>
                {/* Remounted with the slide, so it replays on every return. */}
                <Art key={`${s.key}-${i}`} animate={!still} />
              </div>
            </div>
          );
        })}
      </div>

      <div style={{
        position: "relative", zIndex: 1, width: "100%", maxWidth: COL, margin: "0 auto",
        display: "flex", alignItems: "center", gap: 14,
      }}>
        <div style={{ display: "flex", gap: 7 }}>
          {SLIDES.map((s, n) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setI(n)}
              aria-label={s.title}
              aria-current={n === i ? "true" : undefined}
              style={{
                /*
                  A pill that grows for the live slide rather than a coloured
                  dot: it survives being looked at by somebody who cannot tell
                  the two colours apart, which a hue change alone does not.
                */
                width: n === i ? 26 : 8, height: 8, borderRadius: 999, padding: 0,
                border: "none", cursor: "pointer",
                background: n === i ? "#8ED8EA" : "rgba(255,255,255,.28)",
                transition: still ? undefined : "width 320ms ease, background 320ms ease",
              }}
            />
          ))}
        </div>
        <span style={{ fontSize: 11, color: "rgba(255,255,255,.4)", marginLeft: "auto" }}>
          Conflict-free by construction — not by checking afterwards.
        </span>
      </div>
    </aside>
  );
}
