/**
 * §10.6 — the Timetable Wall.
 *
 * A grid of small week cards, each pinned to one teacher, class-section, room or
 * subject. Four things here are the feature, and the rest is chrome:
 *
 *  1. **One clock down the left.** Cards from different wings (§3.10) line up by
 *     real time rather than by period number, so 09:35 is 09:35 whether it is
 *     Primary's P3 or Senior's P2. Period numbering is a toggle, because a
 *     timetable clerk thinks in period numbers and a head of department thinks
 *     in minutes.
 *  2. **Cross-highlight.** Every card is the same published week seen from a
 *     different side, so hovering a lesson in one lights it in all of them. That
 *     works because the payload carries `slotIds` per cell (§10.6): three cards
 *     showing one `timetable_slot` is a fact the server states, not something
 *     this screen infers by matching names.
 *  3. **One date for the whole wall.** `?date=` already means "as actually
 *     taught" everywhere in §10; at wall level it turns the screen into the
 *     morning briefing — substitutions in cyan, cover duties marked.
 *  4. **A search, not four dropdowns.** The reference product opens a menu of
 *     every teacher; the reference school has 122 of them. §8.5's rule applies —
 *     long lists get a filter before they get a better menu.
 *
 * It reads and never writes. Editing belongs on the Board, where the rules
 * engine, the legality highlighting and the §29.1 freeze guard already live; a
 * second editor over the same rows is how two answers to "may this move?" come
 * into existence.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { windowLabel } from "@edutimetable/shared";
import { api } from "../api";
import { asMessage, ErrorNote } from "../components";
import { useColors } from "../colors-context";
import { WeekGrid, type GridCell, type GridPayload, type GridRow } from "./WeekGrid";

type WallKind = "teacher" | "class-section" | "room" | "subject";

/** The prefix the server parses (`parseWallCards`). One idiom, stated once. */
const PREFIX: Record<WallKind, string> = {
  teacher: "t", "class-section": "cs", room: "r", subject: "sub",
};
const KIND_LABEL: Record<WallKind, string> = {
  teacher: "Teacher", "class-section": "Class-sec", room: "Room", subject: "Subject",
};
const KIND_TINT: Record<WallKind, { bg: string; fg: string }> = {
  teacher: { bg: "var(--steel-pale)", fg: "var(--brand)" },
  "class-section": { bg: "var(--accent-bg)", fg: "var(--accent)" },
  room: { bg: "var(--amber-bg)", fg: "var(--amber)" },
  subject: { bg: "var(--offwhite)", fg: "var(--steel)" },
};

interface Descriptor { kind: WallKind; id: number }
interface WallCardResult extends Descriptor {
  card?: GridPayload;
  denied?: boolean;
  reason?: string;
}
interface Options {
  scope?: string;
  sections: { id: number; label: string }[];
  teachers: { id: number; name: string }[];
  rooms?: { id: number; name: string; type: string }[];
  subjects?: { id: number; name: string }[];
}

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const keyOf = (d: Descriptor) => `${d.kind}:${d.id}`;

/* ──────────────────────────────────────────────────────── the shared axis */

interface AxisRow {
  /** Clock mode: the start time every card is lined up on. Period mode: unused. */
  time?: string;
  /** Period mode: the nth teaching row of each card. */
  index?: number;
  label: string;
  sub: string | null;
}

/**
 * The rows every card on the wall is drawn against.
 *
 * In **clock** mode this is the union of every card's start times, so two wings
 * interleave exactly as the morning does. In **period** mode it is the nth
 * teaching row of each card, which is what somebody comparing "everyone's third
 * period" actually means — and on a single-wing school the two are identical.
 *
 * The merge lives here rather than on the server on purpose: a card is true of
 * one entity and the server says so, while *alignment* is a property of this
 * particular collection of cards. Merging server-side would mean a card's rows
 * depending on what else happened to be on screen beside it.
 */
function buildAxis(cards: GridPayload[], mode: "clock" | "period"): AxisRow[] {
  if (mode === "period") {
    const most = Math.max(0, ...cards.map((c) => teachingRows(c).length));
    return Array.from({ length: most }, (_, i) => ({ index: i, label: `P${i + 1}`, sub: null }));
  }
  const seen = new Map<string, GridRow>();
  for (const c of cards) for (const p of c.periods) if (!seen.has(p.startTime)) seen.set(p.startTime, p);
  return [...seen.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([time, row]) => ({
      time,
      label: time,
      // The end time of whichever card first claimed this row — indicative, and
      // shown small, because two wings at the same start may not end together.
      sub: row.endTime,
    }));
}

const teachingRows = (c: GridPayload) => c.periods.filter((p) => !p.isBreak && !p.isActivity && p.periodNumber !== 0);

/** This card's row for that axis entry, or null when this card has nothing there. */
function rowFor(card: GridPayload, at: AxisRow): GridRow | null {
  if (at.index !== undefined) return teachingRows(card)[at.index] ?? null;
  return card.periods.find((p) => p.startTime === at.time) ?? null;
}

/* ────────────────────────────────────────────────────────────── the screen */

export function Wall() {
  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(3);
  const [cells, setCells] = useState<(Descriptor | null)[]>(() => Array(6).fill(null));
  const [date, setDate] = useState("");
  const [axis, setAxis] = useState<"clock" | "period">("clock");
  const [density, setDensity] = useState<"full" | "compact" | "dots">("compact");
  const [options, setOptions] = useState<Options | null>(null);
  const [results, setResults] = useState<Record<string, WallCardResult>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** The lesson under the pointer, and the one clicked to keep it there. */
  const [hover, setHover] = useState<string[] | null>(null);
  const [pin, setPin] = useState<{ slotIds: string[]; at: AxisRow; day: number } | null>(null);

  useEffect(() => {
    api<Options>("/reports/options").then(setOptions).catch((e) => setError(asMessage(e)));
  }, []);

  /*
    Resizing keeps every card where it was on the board rather than reflowing
    them: the cells are a flat array, so growing the columns without this moves
    every card one place left and looks like the wall shuffled itself.
  */
  const resize = (nextRows: number, nextCols: number) => {
    const next: (Descriptor | null)[] = Array(nextRows * nextCols).fill(null);
    for (let r = 0; r < Math.min(rows, nextRows); r++) {
      for (let c = 0; c < Math.min(cols, nextCols); c++) next[r * nextCols + c] = cells[r * cols + c];
    }
    setRows(nextRows); setCols(nextCols); setCells(next);
  };

  const filled = useMemo(() => cells.filter((c): c is Descriptor => c !== null), [cells]);
  const query = useMemo(
    () => filled.map((d) => `${PREFIX[d.kind]}:${d.id}`).join(","),
    [filled],
  );

  const load = useCallback(async () => {
    if (!query) { setResults({}); return; }
    setLoading(true);
    try {
      const r = await api<{ cards: WallCardResult[] }>(
        `/reports/wall?cards=${encodeURIComponent(query)}${date ? `&date=${date}` : ""}`,
      );
      const byKey: Record<string, WallCardResult> = {};
      for (const c of r.cards) byKey[keyOf(c)] = c;
      setResults(byKey);
      setError(null);
    } catch (e) { setError(asMessage(e)); }
    finally { setLoading(false); }
  }, [query, date]);

  useEffect(() => { void load(); }, [load]);

  const loaded = useMemo(
    () => filled.map((d) => results[keyOf(d)]?.card).filter((c): c is GridPayload => !!c),
    [filled, results],
  );
  const axisRows = useMemo(() => buildAxis(loaded, axis), [loaded, axis]);
  const days = useMemo(() => {
    const s = new Set<number>();
    for (const c of loaded) for (const d of c.workingDays) s.add(d);
    return [...s].sort((a, b) => a - b);
  }, [loaded]);

  const lit = pin?.slotIds ?? hover;
  const litSet = useMemo(() => new Set(lit ?? []), [lit]);
  const nextFree = cells.indexOf(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, gap: 10 }}>
      <ErrorNote message={error} />

      <WallBar
        rows={rows} cols={cols} onResize={resize}
        axis={axis} setAxis={setAxis}
        density={density} setDensity={setDensity}
        date={date} setDate={setDate}
        loading={loading}
        cardCount={filled.length}
      />

      {pin && (
        <FreeBar
          pin={pin}
          cards={filled.map((d) => ({ d, r: results[keyOf(d)] }))}
          onClear={() => setPin(null)}
        />
      )}

      {/*
        A column of ROWS, each a flex row — not one CSS grid over every cell.

        A grid is the obvious structure and it is what this had, and it is what
        put every card on top of the one below it. The reason is worth writing
        down: a grid item taller than its track is **not clipped by the track**,
        it is painted over the next row, so any disagreement between a card's
        height and its track's height becomes an overlap rather than a scrollbar.
        Two attempts at making those agree (`minmax(0, auto)` → `auto`, then
        `alignContent: start`) both failed, and the third would have been another
        guess at a subtlety.

        Stacked flex rows cannot express the problem at all. A flex row is as
        tall as its tallest child by construction, and the next row begins after
        it because that is what block flow does. There is no track to disagree
        with, so a card can never reach the row below however tall it grows.

        Same visual result, and the row is a real thing now — which is also what
        lets `alignItems: stretch` give every card in a row the same height.
      */}
      <div style={{
        flex: 1, minHeight: 0, overflow: "auto",
        display: "flex", flexDirection: "column", gap: 10, paddingBottom: 8,
      }}>
        {Array.from({ length: rows }, (_, r) => (
          <div key={`row${r}`} style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
            {Array.from({ length: cols }, (_, c) => {
              const i = r * cols + c;
              const cell = cells[i];
              return (
                <div key={`c${i}`} style={{ flex: "1 1 0", minWidth: 0, display: "flex" }}>
                  {cell === null ? (
                    <EmptyCell
                      /*
                        Only the NEXT free cell offers the search box; the rest
                        are a thin "＋" until they are clicked. A 4x3 wall
                        holding four cards otherwise draws eight identical
                        full-height invitations, which is most of the screen
                        given over to asking a question nobody asked eight
                        times. The others stay clickable, because placing a card
                        in a particular cell has to remain possible.
                      */
                      prominent={i === nextFree}
                      options={options}
                      taken={filled}
                      onPick={(d) => setCells(cells.map((x, j) => (j === i ? d : x)))}
                    />
                  ) : (
                    <CardSlot
                      descriptor={cell}
                      result={results[keyOf(cell)]}
                      axisRows={axisRows}
                      days={days}
                      density={density}
                      litSet={litSet}
                      onHover={setHover}
                      onPin={(slotIds, at, day) =>
                        setPin((was) => (was && was.slotIds[0] === slotIds[0] ? null : { slotIds, at, day }))}
                      onRemove={() => setCells(cells.map((x, j) => (j === i ? null : x)))}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── the wall bar */

function WallBar({ rows, cols, onResize, axis, setAxis, density, setDensity, date, setDate, loading, cardCount }: {
  rows: number; cols: number; onResize: (r: number, c: number) => void;
  axis: "clock" | "period"; setAxis: (a: "clock" | "period") => void;
  density: "full" | "compact" | "dots"; setDensity: (d: "full" | "compact" | "dots") => void;
  date: string; setDate: (d: string) => void;
  loading: boolean; cardCount: number;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", flex: "none",
      background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 10,
      padding: "9px 14px", fontSize: 12.5,
    }}>
      <Stepper label="Rows" value={rows} onChange={(v) => onResize(v, cols)} min={1} max={6} />
      <Stepper label="Columns" value={cols} onChange={(v) => onResize(rows, v)} min={1} max={6} />

      <Segmented
        label="Axis"
        value={axis}
        onChange={(v) => setAxis(v as "clock" | "period")}
        options={[
          { v: "clock", t: "Wall clock", title: "Line every card up by real time — the only way two wings can be read side by side (§3.10)" },
          { v: "period", t: "Period no.", title: "Line every card up by its own nth period" },
        ]}
      />
      <Segmented
        label="Density"
        value={density}
        onChange={(v) => setDensity(v as "full" | "compact" | "dots")}
        options={[
          { v: "full", t: "Full", title: "The same grid the Reports screen prints" },
          { v: "compact", t: "Compact", title: "Two lines a cell" },
          { v: "dots", t: "Dots", title: "Colour only — forty cards on one screen, to read the shape of a week" },
        ]}
      />

      <label style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={lbl}>Date</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          title="Show the week as it was actually taught that day — substitutions overlaid on every card at once (§4)"
          style={{ ...ctl, padding: "3px 7px" }} />
        {date && (
          <button className="btn" style={{ ...ctl, cursor: "pointer" }} onClick={() => setDate("")}>clear</button>
        )}
      </label>

      <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--ink-faint)" }}>
        {loading ? "Loading…" : `${cardCount} card${cardCount === 1 ? "" : "s"}`}
      </span>
    </div>
  );
}

const lbl: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: "0.09em",
  textTransform: "uppercase", color: "var(--steel)",
};
const ctl: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 11.5, border: "1px solid var(--line)",
  background: "var(--paper)", borderRadius: 6, padding: "3px 9px", color: "var(--ink-soft)",
};

function Stepper({ label, value, onChange, min, max }: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number;
}) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={lbl}>{label}</span>
      <button style={{ ...ctl, cursor: "pointer" }} disabled={value <= min}
        aria-label={`One fewer ${label.toLowerCase()}`} onClick={() => onChange(value - 1)}>−</button>
      <span style={{ fontFamily: "var(--font-mono)", minWidth: 12, textAlign: "center" }}>{value}</span>
      <button style={{ ...ctl, cursor: "pointer" }} disabled={value >= max}
        aria-label={`One more ${label.toLowerCase()}`} onClick={() => onChange(value + 1)}>+</button>
    </span>
  );
}

function Segmented({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void;
  options: Array<{ v: string; t: string; title: string }>;
}) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={lbl}>{label}</span>
      {options.map((o) => (
        <button key={o.v} title={o.title} onClick={() => onChange(o.v)}
          style={{
            ...ctl, cursor: "pointer",
            ...(value === o.v ? { background: "var(--brand)", borderColor: "var(--brand)", color: "#fff" } : {}),
          }}>
          {o.t}
        </button>
      ))}
    </span>
  );
}

/* ───────────────────────────────────────────────── who is free at this moment */

/**
 * §10.6 — the substitute question, asked without leaving the screen.
 *
 * Pin a lesson and this reads across every OTHER card on the wall to say who is
 * free at that same moment. Deliberately limited to what is already loaded, and
 * it says so: "free" here means "has nothing on this wall's cards", which is a
 * far weaker claim than the Substitute Centre's, and presenting it as more would
 * be the kind of wrong answer §10.6 refused elsewhere.
 */
function FreeBar({ pin, cards, onClear }: {
  pin: { slotIds: string[]; at: AxisRow; day: number };
  cards: Array<{ d: Descriptor; r?: WallCardResult }>;
  onClear: () => void;
}) {
  const teachers = cards.filter((c) => c.d.kind === "teacher" && c.r?.card);
  const busy: string[] = [];
  const free: string[] = [];
  for (const { r } of teachers) {
    const card = r!.card!;
    const row = rowFor(card, pin.at);
    const occupied = row ? !!card.grid[`${pin.day}:${row.key}`] : false;
    // No row at all means this card's wing does not run at that time — which is
    // not the same as being free, and is not claimed as such.
    if (!row) continue;
    (occupied ? busy : free).push(card.label);
  }
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", flex: "none",
      background: "var(--steel-pale)", borderLeft: "3px solid var(--brand)",
      borderRadius: "0 8px 8px 0", padding: "8px 13px", fontSize: 12.5, color: "var(--ink-soft)",
    }}>
      <b style={{ color: "var(--brand-dark)" }}>
        {DAY_NAMES[pin.day]} {pin.at.label} pinned
      </b>
      {free.length > 0 && (
        <span>
          <span style={lbl}>Free on this wall</span>{" "}
          <b style={{ color: "var(--accent)" }}>{free.join(", ")}</b>
        </span>
      )}
      {free.length === 0 && teachers.length > 0 && <span>Every teacher on this wall is teaching then.</span>}
      {busy.length > 0 && <span style={{ color: "var(--ink-faint)" }}>Busy: {busy.join(", ")}</span>}
      <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>
        — of the cards on this wall only; the Substitute Centre asks the full question.
      </span>
      <button className="btn" style={{ ...ctl, cursor: "pointer", marginLeft: "auto" }} onClick={onClear}>unpin</button>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── an empty cell */

/**
 * One search box over all four kinds, rather than four menus.
 *
 * The reference product opens a scrolling list of every teacher; the reference
 * school has 122 of them. §8.5's rule: a long list gets a filter before it gets
 * a better menu — and typing "lab 2" or "5-A" or "t12" should not first require
 * choosing which of four things you meant.
 */
function EmptyCell({ options, taken, onPick, prominent }: {
  options: Options | null;
  taken: Descriptor[];
  onPick: (d: Descriptor) => void;
  /** The next free cell, which shows the box outright; the rest ask first. */
  prominent: boolean;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  const showing = prominent || asked;

  // Focus on the way in, so clicking "＋" and typing works without a second
  // click — the box appearing where the pointer already is, ready.
  useEffect(() => { if (asked) box.current?.focus(); }, [asked]);

  const all = useMemo(() => {
    if (!options) return [];
    const out: Array<Descriptor & { label: string }> = [];
    for (const t of options.teachers ?? []) out.push({ kind: "teacher", id: t.id, label: t.name });
    for (const s of options.sections ?? []) out.push({ kind: "class-section", id: s.id, label: s.label });
    for (const r of options.rooms ?? []) out.push({ kind: "room", id: r.id, label: r.name });
    for (const s of options.subjects ?? []) out.push({ kind: "subject", id: s.id, label: s.name });
    return out;
  }, [options]);

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const already = new Set(taken.map(keyOf));
    return all
      .filter((x) => !already.has(keyOf(x)))
      .filter((x) => !needle || x.label.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [all, q, taken]);

  if (!showing) {
    return (
      <button
        onClick={() => setAsked(true)}
        title="Put a timetable in this cell"
        style={{
          border: "1.5px dashed var(--line)", borderRadius: 10, background: "transparent",
          minHeight: 40, cursor: "pointer", color: "var(--ink-faint)", fontSize: 12,
          fontFamily: "inherit", flex: 1, minWidth: 0,
          // Cards in a row stretch to match each other; an empty cell must not,
          // or one tall card gives its whole row a full-height "＋".
          alignSelf: "flex-start",
        }}
      >＋</button>
    );
  }

  return (
    <div style={{
      border: "1.5px dashed var(--steel-light)", borderRadius: 10, background: "var(--offwhite)",
      padding: 14, minHeight: 130, display: "flex", flexDirection: "column", gap: 8,
      flex: 1, minWidth: 0, alignSelf: "flex-start", width: "100%",
    }}>
      <input
        ref={box}
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Add a timetable — teacher, class, room or subject"
        aria-label="Search for a teacher, class-section, room or subject"
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits[0]) onPick({ kind: hits[0].kind, id: hits[0].id });
          if (e.key === "Escape") { setQ(""); setOpen(false); setAsked(false); box.current?.blur(); }
        }}
        style={{
          width: "100%", padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8,
          fontSize: 12.5, fontFamily: "inherit", background: "var(--paper)", color: "var(--ink)",
        }}
      />
      {(open || q) && (
        <div style={{ display: "grid", gap: 3, overflow: "auto" }}>
          {hits.map((h) => (
            <button
              key={keyOf(h)}
              onClick={() => onPick({ kind: h.kind, id: h.id })}
              style={{
                display: "flex", alignItems: "center", gap: 8, textAlign: "left",
                padding: "5px 9px", borderRadius: 6, cursor: "pointer",
                border: "1px solid var(--line)", background: "var(--paper)",
                fontSize: 12, color: "var(--ink)", font: "inherit", fontFamily: "inherit",
              }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {h.label}
              </span>
              <span style={{ ...lbl, color: KIND_TINT[h.kind].fg }}>{KIND_LABEL[h.kind]}</span>
            </button>
          ))}
          {hits.length === 0 && (
            <p style={{ fontSize: 11.5, color: "var(--ink-faint)", margin: "4px 2px" }}>
              {options?.scope === "all"
                ? "Nothing matches."
                : "Nothing matches. Rooms and subjects need the all-timetables view level (§15.3)."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────── a card */

function CardSlot({ descriptor, result, axisRows, days, density, litSet, onHover, onPin, onRemove }: {
  descriptor: Descriptor;
  result?: WallCardResult;
  axisRows: AxisRow[];
  days: number[];
  density: "full" | "compact" | "dots";
  litSet: Set<string>;
  onHover: (ids: string[] | null) => void;
  onPin: (ids: string[], at: AxisRow, day: number) => void;
  onRemove: () => void;
}) {
  const tint = KIND_TINT[descriptor.kind];
  const card = result?.card;
  return (
    <section style={{
      border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden",
      background: "var(--paper)", minWidth: 0, flex: 1,
      // Its own column, so the header stays put and only the week can grow.
      display: "flex", flexDirection: "column",
    }}>
      <header style={{
        display: "flex", alignItems: "center", gap: 7, padding: "7px 10px",
        borderBottom: "1px solid var(--line)", background: "var(--offwhite)",
      }}>
        <span style={{
          ...lbl, color: tint.fg, background: tint.bg, padding: "2px 6px", borderRadius: 4,
        }}>{KIND_LABEL[descriptor.kind]}</span>
        <b style={{
          fontSize: 12.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{card?.label ?? "…"}</b>
        {/* §10.6 — a card spanning two wings says so, because its period numbers
            then come from two different weeks. */}
        {(card?.wings?.length ?? 0) > 1 && (
          <span style={{ ...lbl, color: "var(--brand)" }} title={card!.wings!.map((w) => w.name).join(", ")}>
            {card!.wings!.length} wings
          </span>
        )}
        {/*
          §30.5 — which dates this card's week applies over. Only when the card
          has ONE wing: with two, their windows may differ and a single label
          would have to pick one. Absent entirely for a timetable that runs the
          whole session, which is most of them.
        */}
        {card?.wings?.length === 1 && windowLabel(card.wings[0]) && (
          <span style={{ ...lbl, color: "var(--ink-faint)" }} title="When this timetable applies">
            {windowLabel(card.wings[0])}
          </span>
        )}
        <button onClick={onRemove} aria-label={`Remove ${card?.label ?? "this card"}`}
          title="Take this card off the wall"
          style={{
            marginLeft: "auto", border: "none", background: "none", cursor: "pointer",
            color: "var(--ink-faint)", fontSize: 14, lineHeight: 1, padding: "0 2px",
          }}>✕</button>
      </header>

      {result?.denied ? (
        /*
          A refused card, in its own place on the wall. It must not blank the
          other eleven — a shared wall is normal, and the viewer who cannot see
          one room should still see the ten teachers beside it (§10.6).
        */
        <div style={{ padding: "16px 12px", fontSize: 11.5, color: "var(--ink-faint)", textAlign: "center" }}>
          Not available to you.
          <div style={{ marginTop: 5, color: "var(--steel)" }}>{result.reason}</div>
        </div>
      ) : !card ? (
        <div style={{ padding: 20, fontSize: 12, color: "var(--ink-faint)", textAlign: "center" }}>Loading…</div>
      ) : density === "full" ? (
        <div style={{ padding: 8, overflowX: "auto" }}><WeekGrid data={card} /></div>
      ) : (
        <MiniGrid
          card={card} axisRows={axisRows} days={days} dots={density === "dots"}
          litSet={litSet} onHover={onHover} onPin={onPin}
        />
      )}
    </section>
  );
}

/**
 * The compact renderer — the wall's own, deliberately not `WeekGrid`.
 *
 * `WeekGrid` draws one card at full size with breaks as full-width bands; it is
 * the right thing for a printed sheet and the wrong thing for twelve at once.
 * The two share the payload and the §10.5 colour rules, which is where agreement
 * actually matters.
 *
 * Every row comes from the WALL's axis rather than the card's own, which is what
 * makes the cards line up. A card with nothing at that time gets a blank row —
 * stated rather than skipped, or the rows below it would slide up and the
 * alignment would silently be a lie.
 */
function MiniGrid({ card, axisRows, days, dots, litSet, onHover, onPin }: {
  card: GridPayload;
  axisRows: AxisRow[];
  days: number[];
  dots: boolean;
  litSet: Set<string>;
  onHover: (ids: string[] | null) => void;
  onPin: (ids: string[], at: AxisRow, day: number) => void;
}) {
  const colors = useColors();
  const headlinesClass = card.kind === "teacher" || card.kind === "room";
  const swatch = (c: GridCell) => (headlinesClass ? colors.classOf(c.classSection) : colors.subject(c.subject));
  const h = dots ? 15 : 30;

  return (
    <div style={{ display: "grid", gridTemplateColumns: `${dots ? 30 : 46}px repeat(${days.length}, minmax(0, 1fr))` }}>
      <span />
      {days.map((d) => (
        <span key={d} style={{
          ...lbl, textAlign: "center", padding: "3px 0", background: "var(--steel-pale)",
          borderBottom: "1px solid var(--line)", fontSize: 9,
        }}>{DAY_NAMES[d]}</span>
      ))}

      {axisRows.map((at, ri) => {
        const row = rowFor(card, at);
        return (
          <Fragment key={`r${ri}`}>
            {/*
              The label column shows what DIFFERS between cards, because what
              they share is already said by the row they are on. On the clock
              axis every card's row is 09:35, so the useful thing is which
              period that is here — Junior's P3 and Senior's P2. On the period
              axis every card's row is "the third one", so the useful thing is
              when that actually falls.

              The shared value is still printed, small, underneath: an alignment
              claim the reader cannot check is one they have to take on trust,
              and §10.6's whole argument is that these cards line up.
            */}
            <span title={at.time ? `${at.label}${at.sub ? `–${at.sub}` : ""}` : at.label} style={{
              fontFamily: "var(--font-mono)", fontSize: 8.5, color: "var(--ink-faint)",
              borderTop: "1px solid var(--line)", padding: "2px 3px 0", height: h,
              overflow: "hidden", lineHeight: 1.15,
            }}>
              {row && (
                <>
                  <span style={{ display: "block" }}>
                    {/* A break and an activity have no period number by design
                        (§28.3) — printing one gives "Pnull". */}
                    {row.periodNumber === null || row.periodNumber === 0
                      ? (row.isActivity ? "◆" : "··")
                      : at.time ? `P${row.periodNumber}` : row.startTime}
                  </span>
                  {!dots && at.time && (
                    <span style={{ display: "block", fontSize: 7, opacity: 0.72 }}>{at.time}</span>
                  )}
                </>
              )}
            </span>
            {days.map((d) => {
              if (!row) {
                // This card's wing does not run at this time. Hatched rather than
                // white: "nothing here" and "free period" are different facts.
                return <span key={d} style={{ ...cellBase, height: h, background: NOTHING }} />;
              }
              if (row.isBreak || row.isActivity) {
                return <span key={d} style={{ ...cellBase, height: h, background: HATCH }} />;
              }
              const cell = card.grid[`${d}:${row.key}`];
              if (!cell) {
                return <span key={d} style={{ ...cellBase, height: h, background: "var(--offwhite)" }} />;
              }
              const ids = cell.slotIds ?? [];
              const on = ids.some((id) => litSet.has(id));
              const sw = cell.substituted ? null : swatch(cell);
              const density = cell.count;
              return (
                <button
                  key={d}
                  onMouseEnter={() => onHover(ids)}
                  onMouseLeave={() => onHover(null)}
                  onClick={() => onPin(ids, at, d)}
                  title={titleFor(card, cell, row, d)}
                  style={{
                    ...cellBase,
                    height: h, cursor: "pointer", textAlign: "left", font: "inherit",
                    padding: dots ? 0 : "2px 4px", overflow: "hidden",
                    background: density !== undefined
                      ? `color-mix(in srgb, var(--brand) ${Math.round(14 + Math.min(1, density / Math.max(1, card.busiest ?? 1)) * 46)}%, var(--paper))`
                      : cell.substituted ? "var(--accent-bg)" : sw?.bg ?? "var(--steel-pale)",
                    // The highlight is an inset ring, not a border: a border
                    // would change the cell's size and nudge every card on the
                    // wall by a pixel as the pointer moved across it.
                    boxShadow: on ? "inset 0 0 0 2px var(--brand)" : undefined,
                    position: on ? "relative" : undefined,
                  }}
                >
                  {!dots && (
                    <>
                      <b style={{ display: "block", fontSize: 9.5, lineHeight: 1.15, color: sw?.fg ?? "var(--ink)" }}>
                        {density !== undefined ? density : headlinesClass ? cell.classSection : cell.subject}
                      </b>
                      <span style={{ fontSize: 8.5, lineHeight: 1.15, color: sw?.fg ?? "var(--ink-soft)", opacity: 0.8 }}>
                        {density !== undefined
                          ? (cell.sections ?? []).slice(0, 2).join(", ")
                          : card.kind === "teacher" ? cell.subject
                          : card.kind === "room" ? cell.teacher
                          : cell.teacher}
                      </span>
                    </>
                  )}
                </button>
              );
            })}
          </Fragment>
        );
      })}
    </div>
  );
}

const cellBase: React.CSSProperties = {
  borderTop: "1px solid var(--line)", borderLeft: "1px solid var(--line)",
  display: "block", minWidth: 0, border: "1px solid var(--line)", borderRadius: 0,
};
const HATCH = "repeating-linear-gradient(45deg, var(--offwhite), var(--offwhite) 4px, var(--steel-pale) 4px, var(--steel-pale) 8px)";
const NOTHING = "repeating-linear-gradient(45deg, transparent, transparent 5px, var(--line) 5px, var(--line) 6px)";

function titleFor(card: GridPayload, cell: GridCell, row: GridRow, day: number) {
  const when = `${DAY_NAMES[day]} P${row.periodNumber} ${row.startTime}${row.endTime ? `–${row.endTime}` : ""}`;
  if (cell.count !== undefined) return `${when} · ${cell.count} section(s): ${(cell.sections ?? []).join(", ")}`;
  const parts = [cell.classSection, cell.subject, cell.teacher, cell.room].filter(Boolean);
  return `${when} · ${parts.join(" · ")}${cell.substituted ? " · substituted" : ""}${
    (card.wings?.length ?? 0) > 1 ? ` · ${row.wing}` : ""}`;
}
