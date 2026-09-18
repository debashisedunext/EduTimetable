/**
 * §17.4a — the school's logo, and the one rule about what to show without one.
 *
 * ## Why this is a module and not an `<img>` at each call site
 *
 * The fallback is a rule, not a default value: *"the school's own logo, or the
 * product mark if it has none — and the product mark again if the URL it gave
 * us cannot be loaded."* That last clause is the one call sites got wrong. The
 * top bar, the sidebar and the School Profile each carried their own
 * `onError` handler that set `display: none`, so a logo URL that 404s left a
 * **blank space** on three screens — which reads as "this school has no logo"
 * when what happened is that the one it has is unreachable. One of them is a
 * form whose whole job is telling somebody whether the URL they typed works.
 *
 * So the rule lives here once, and a broken URL falls back to the default
 * rather than to nothing.
 *
 * ## Replacing the default
 *
 * `DEFAULT_LOGO` is the only reference to the file. Drop the real artwork in at
 * `apps/web/public/` under that name and every screen follows — no code change,
 * no rebuild of anything but the static assets.
 */
import { useEffect, useState } from "react";

/** The mark shown for a school that has not given one of its own. */
export const DEFAULT_LOGO = "/edunext-logo.svg";

export function SchoolLogo({
  src,
  size = 26,
  alt = "",
  /** Rounds and boxes the mark — for the preview tile, not for chrome. */
  framed = false,
  onBroken,
}: {
  src: string | null | undefined;
  size?: number;
  alt?: string;
  framed?: boolean;
  /**
   * Fired when the school's own logo could not be loaded and the default was
   * shown instead. The School Profile uses it to say *"that link could not be
   * loaded"* — the thing a `display: none` handler could never say, because by
   * then there was nothing on screen to explain.
   *
   * An EVENT, not a reported state, and deliberately: a callback describing
   * what is on screen would have to fire from an effect, which runs after
   * paint — so a perfectly good logo would show one painted frame of "this
   * could not be loaded" on every mount. Nothing fires unless a load fails.
   */
  onBroken?: () => void;
}) {
  const chosen = src?.trim() ? src.trim() : DEFAULT_LOGO;
  /*
    Keyed on the source so a corrected URL is tried again. Without the reset a
    typo would mark it broken for the life of the page, and the next URL —
    however good — would never be attempted.
  */
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [chosen]);

  return (
    <img
      src={broken ? DEFAULT_LOGO : chosen}
      alt={alt}
      width={size}
      height={size}
      onError={() => { setBroken(true); onBroken?.(); }}
      style={{
        width: size, height: size, objectFit: "contain", flexShrink: 0,
        ...(framed
          ? { borderRadius: 10, border: "1px solid var(--line)", background: "#fff", padding: 6 }
          : {}),
      }}
    />
  );
}
