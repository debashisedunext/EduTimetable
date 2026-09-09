/**
 * §8.2 — the masters, on top, as buttons.
 *
 * They were the first five steps of a nine-step wizard, which is the right
 * shape exactly once: the day a school is set up. Afterwards "add a teacher" is
 * not step 5 of anything, and finding it meant walking a stepper past four
 * screens that were already done. A wizard is a sequence; masters are a set.
 *
 * So: one row of entity buttons, the same list-and-form underneath, and per-row
 * actions for the things that hang off a master rather than sitting inside it —
 * **Lessons** (what a class is taught) and **Time off** (when it cannot be).
 *
 * Two things this deliberately is NOT:
 *
 *  - **Not a new editor.** Every list and form below is the component the
 *    wizard used, moved. A second form over the same rows is how two screens
 *    start disagreeing about what a subject has.
 *  - **Not a home for the timetable's own settings.** The period grid, breaks
 *    and activities belong to a timetable, not to the school's masters, and
 *    they stay on the Timetables screen where a wing is configured.
 *
 * §8.5 — the page fills the height and does not scroll. The tab bar is fixed,
 * the two panes below it take the rest, and each scrolls inside itself. That is
 * what "I have to scroll down to edit" was asking for, and it only works if
 * every child stays inside the height: anything stacked below the panes brings
 * the page scrollbar straight back.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useConfigCtx } from "../hooks";
import { StepAcademicYear, StepClasses, StepRooms, StepSubjects } from "./Setup";
import { StepTeachers } from "./SetupAdvanced";
import { ClassLessons } from "./ClassLessons";

/**
 * The masters, in the order a school builds them: a year holds classes, classes
 * sit in rooms, subjects are taught to them, teachers teach the subjects.
 */
const TABS = [
  { key: "subjects", label: "Subjects", icon: "📘" },
  { key: "classes", label: "Classes", icon: "👥" },
  { key: "rooms", label: "Classrooms", icon: "🚪" },
  { key: "teachers", label: "Teachers", icon: "🎓" },
  { key: "years", label: "Academic Years", icon: "📅" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function Masters() {
  const [tab, setTab] = useState<TabKey>("subjects");
  const { current } = useConfigCtx();

  /**
   * §8.2 — the class's curriculum, read-only. A TAB rather than a block under
   * the class-sections table: stacked, it was the thing that made this screen
   * scroll no matter how the panes above it were arranged.
   */
  const [showLessons, setShowLessons] = useState(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/*
        The top bar. Icons above words, like the toolbar this replaces — the
        icon is what somebody aims at once they know where a master lives, and
        the word is what they read the first time.
      */}
      <div style={{
        display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, flex: "none",
        borderBottom: "1px solid var(--line)", paddingBottom: 10,
      }}>
        {TABS.map((t) => (
          <button key={t.key} onClick={() => { setTab(t.key); setShowLessons(false); }}
            aria-pressed={tab === t.key}
            style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
              padding: "6px 15px", borderRadius: 10, cursor: "pointer", minWidth: 88,
              border: `1px solid ${tab === t.key ? "var(--brand)" : "transparent"}`,
              background: tab === t.key ? "var(--steel-pale)" : "transparent",
              color: tab === t.key ? "var(--brand-dark)" : "var(--ink-soft)",
              font: `${tab === t.key ? 700 : 500} 12.5px/1 Inter`,
            }}>
            <span aria-hidden style={{ fontSize: 17 }}>{t.icon}</span>
            {t.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {/* §8.2 — what a class is taught, beside the class list rather than
            under it. A toggle, because it is a second view of the same tab. */}
        {tab === "classes" && current && (
          <button onClick={() => setShowLessons(!showLessons)}
            aria-pressed={showLessons}
            className="btn"
            style={{
              alignSelf: "center", fontSize: 12.5,
              background: showLessons ? "var(--brand)" : "var(--paper)",
              color: showLessons ? "#fff" : "var(--ink)",
              border: `1px solid ${showLessons ? "var(--brand)" : "var(--line)"}`,
            }}>
            📖 Lessons
          </button>
        )}
        {/*
          The one action every master shares, so it is here rather than repeated
          five times below. It deep-links into the kind being looked at (§4.7b),
          which is why that screen keeps its kind in the URL.
        */}
        <Link to={`/availability?kind=${tabToKind(tab)}`} className="btn"
          style={{ textDecoration: "none", alignSelf: "center", fontSize: 12.5 }}>
          🕐 Time off
        </Link>
      </div>

      {tab === "subjects" && <StepSubjects />}
      {/* Read-only: editing what a class is taught lives on the Allocation
          page, which is the one place that writes those rows. */}
      {tab === "classes" && (showLessons && current
        ? <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}><ClassLessons configId={current.id} /></div>
        : <StepClasses />)}
      {tab === "rooms" && <StepRooms />}
      {/* Teachers already swaps the whole pane for its form (§8.1), so it has
          never had the scroll problem the others had, and is left alone. */}
      {tab === "teachers" && (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <StepTeachers onNext={() => undefined} />
        </div>
      )}
      {tab === "years" && <StepAcademicYear />}
    </div>
  );
}

/** Masters tab → the Availability screen's `kind`. Years have no time off. */
function tabToKind(tab: TabKey): string {
  if (tab === "classes") return "class";
  if (tab === "rooms") return "room";
  if (tab === "subjects") return "subject";
  return "teacher";
}
