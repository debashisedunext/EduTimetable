/**
 * §36 — the Whole tab's fixed-lesson editing, as state rather than as markup.
 *
 * ## Why it is a hook and not part of `MasterGrid`
 *
 * That file is already the largest screen in the app and this adds a second
 * *mode* to it — a set of pins being edited, a dirty flag, a save, and a set of
 * choices the server decides. Left inline, every one of those becomes another
 * `useState` in a component with twenty, and the rule about what may be offered
 * ends up spelled out beside the JSX that draws it.
 *
 * ## The rule this file exists to keep
 *
 * **The server decides what is offerable.** `options` comes down from
 * `GET /fixed-lessons` already filtered — a subject an elective owns is not in
 * it, a §4.8 double-period row is not in it, a guest teacher is not in it —
 * because a picker that can offer what the save refuses is a picker that
 * teaches people to distrust the screen. Nothing here re-derives that list; it
 * only narrows it to the cell being edited.
 *
 * The one rule the client does own is the **count**, because it is about
 * unsaved work: "3 of 6 fixed" has to include the pin somebody just added and
 * has not saved, and the server cannot know about that one.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { describeFill, fillAcrossDays } from "@edutimetable/shared";
import { api } from "../api";
import { asMessage } from "../components";

/** One pin, as the grid holds it while it is being edited. */
export interface Pin {
  classSectionId: number;
  subjectId: number;
  teacherId: number;
  roomId: number | null;
  dayOfWeek: number;
  periodNumber: number;
}

export interface PinOption {
  classSectionId: number;
  subjectId: number;
  subject: string;
  teacherId: number;
  teacher: string;
  initials: string | null;
}

interface Payload {
  lessons: Array<Pin & { classSection: string; subject: string; teacher: string; initials: string | null; room: string | null }>;
  caps: Array<{ classId: number; subjectId: number; periodsPerWeek: number }>;
  sections: Array<{ id: number; classId: number }>;
  options: PinOption[];
  rooms: Array<{ id: number; name: string }>;
}

const key = (p: { classSectionId: number; dayOfWeek: number; periodNumber: number }) =>
  `${p.classSectionId}:${p.dayOfWeek}:${p.periodNumber}`;

export function useFixedLessons(configId: number | null, enabled: boolean) {
  const [pins, setPins] = useState<Pin[]>([]);
  const [saved, setSaved] = useState<Pin[]>([]);
  const [meta, setMeta] = useState<Pick<Payload, "caps" | "sections" | "options" | "rooms">>({
    caps: [], sections: [], options: [], rooms: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingNow, setSavingNow] = useState(false);

  useEffect(() => {
    if (!enabled || configId === null) return;
    let live = true;
    setLoading(true);
    api<Payload>(`/timetable-configs/${configId}/fixed-lessons`)
      .then((p) => {
        if (!live) return;
        const rows: Pin[] = (p.lessons ?? []).map((l) => ({
          classSectionId: l.classSectionId, subjectId: l.subjectId, teacherId: l.teacherId,
          roomId: l.roomId ?? null, dayOfWeek: l.dayOfWeek, periodNumber: l.periodNumber,
        }));
        setPins(rows);
        /*
          The saved set is kept SEPARATELY rather than compared against a
          re-fetch. "Is there anything to save?" has to be answerable without
          asking the server, or the button is either always live or a round
          trip behind what somebody just typed.
        */
        setSaved(rows);
        setMeta({ caps: p.caps ?? [], sections: p.sections ?? [], options: p.options ?? [], rooms: p.rooms ?? [] });
        setError(null);
      })
      .catch((e) => { if (live) setError(asMessage(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [configId, enabled]);

  const byCell = useMemo(() => new Map(pins.map((p) => [key(p), p])), [pins]);
  const classOf = useMemo(
    () => new Map(meta.sections.map((s) => [s.id, s.classId])),
    [meta.sections],
  );

  /** What may be pinned in this section's cells — the server's own list. */
  const optionsFor = useCallback(
    (classSectionId: number) => meta.options.filter((o) => o.classSectionId === classSectionId),
    [meta.options],
  );

  /**
   * How many of this lesson are pinned, and how many the class is taught.
   *
   * Counted over the EDITING set, not the saved one: the toolbar's "3 of 6"
   * has to include the pin somebody has just placed, or it reads one behind
   * every action and somebody pins a seventh believing they have five.
   *
   * The cap is a CLASS fact (§27) and the count is per SECTION, which is not a
   * mismatch: Class 1's six Mathematics is six for 1-A, six for 1-B and six
   * for 1-C separately.
   */
  const capFor = useCallback((classSectionId: number, subjectId: number) => {
    const classId = classOf.get(classSectionId);
    const cap = meta.caps.find((c) => c.classId === classId && c.subjectId === subjectId)?.periodsPerWeek ?? 0;
    const used = pins.filter((p) => p.classSectionId === classSectionId && p.subjectId === subjectId).length;
    return { used, cap };
  }, [classOf, meta.caps, pins]);

  const at = useCallback((classSectionId: number, dayOfWeek: number, periodNumber: number) =>
    byCell.get(key({ classSectionId, dayOfWeek, periodNumber })) ?? null, [byCell]);

  /**
   * §36 — why there is nothing to offer, when there is nothing to offer.
   *
   * A pin attaches to a lesson somebody teaches, so a class with no curriculum
   * or no staffing has nothing pinnable — which is correct, and was shown as an
   * empty dropdown with no explanation. That reads as a broken screen, and it
   * is the exact failure this codebase keeps writing down: a state nobody can
   * tell from a bug is a state that was not communicated.
   *
   * Two causes, two different screens to fix them on, so they are told apart
   * rather than folded into one vague sentence. `caps` is the curriculum, so
   * its absence for the class is the first question; a class that HAS a
   * curriculum and still offers nothing is unstaffed.
   */
  const whyEmpty = useCallback((classSectionId: number): string | null => {
    if (optionsFor(classSectionId).length > 0) return null;
    const classId = classOf.get(classSectionId);
    const taught = meta.caps.some((c) => c.classId === classId);
    return taught
      ? "Nobody is assigned to teach this class yet. Give its lessons a teacher on the "
        + "Lesson grid and press Save — a fixed lesson has to belong to a lesson somebody teaches."
      : "This class has no lesson plan yet. Set its subjects and periods on the Lesson grid "
        + "and press Save, then come back to fix them to a day and period.";
  }, [classOf, meta.caps, optionsFor]);

  /** True when NO section in this timetable has anything to pin. */
  const empty = meta.options.length === 0;

  /** Put a pin in a cell, or replace the one already there. */
  const set = useCallback((next: Pin) => {
    setPins((all) => [...all.filter((p) => key(p) !== key(next)), next]);
  }, []);

  const clear = useCallback((cell: { classSectionId: number; dayOfWeek: number; periodNumber: number }) => {
    setPins((all) => all.filter((p) => key(p) !== key(cell)));
  }, []);

  /**
   * §36.6 — the same lesson, at the same period, on every working day.
   *
   * A school pinning assembly-style lessons wants "Maths, period 1, every day"
   * far more often than it wants five separate decisions, and the alternative
   * is clicking the same three controls once per day.
   *
   * ## It fills, it never overwrites, and it stops at the cap
   *
   * Three things it will not do, each of which would make the button dangerous
   * rather than quick:
   *
   *  - **Overwrite another pin.** A cell already holding a different lesson is
   *    a decision somebody made; a bulk action that silently replaced it would
   *    be the worst kind of convenience. Skipped and counted.
   *  - **Exceed the curriculum.** Five days of a subject taught three periods a
   *    week is a set the save would refuse, so the button would be a button
   *    that creates an error. It fills up to the cap and says it stopped.
   *  - **Put the teacher in two places.** The same teacher already pinned at
   *    that period in another section is a clash this client can see in its own
   *    set, and the save would refuse it by name. Skipped here instead.
   *
   * Returns a sentence rather than a boolean, because every one of those
   * reasons is something the person needs told — "it did 3 of 5" with no
   * explanation is the empty-dropdown mistake in another shape.
   *
   * The days it fills are the working days in order, which is arbitrary but
   * predictable — and every one of them is editable afterwards, which is the
   * whole point of doing it this way rather than refusing.
   */
  const repeatAcrossDays = useCallback((
    cell: { classSectionId: number; dayOfWeek: number; periodNumber: number },
    days: number[],
  ): string => {
    const src = byCell.get(key(cell));
    if (!src) return "Choose a subject for this cell first.";
    const { cap } = capFor(cell.classSectionId, src.subjectId);
    /*
      The arithmetic lives in `packages/shared` and is unit-tested there.
      `apps/web` has no test harness, and a mistake here either destroys a pin
      somebody placed or hands the save a set it refuses — the same reason
      `mergeShownWings` and `mergeByWing` moved out of this app.
    */
    const result = fillAcrossDays(src, pins, days, cap);
    if (result.add.length > 0) setPins((all) => [...all, ...result.add]);
    return describeFill(result, cap);
  }, [byCell, capFor, pins]);

  /*
    Compared by VALUE, sorted, rather than by reference or by length.

    Replacing a pin's teacher changes no count and no key, so a length check
    would leave the Save button grey on a real edit — and reverting an edit by
    hand should turn it grey again, which only a value comparison gives.
  */
  const fingerprint = (rows: Pin[]) =>
    rows.map((p) => `${key(p)}|${p.subjectId}|${p.teacherId}|${p.roomId ?? ""}`).sort().join(";");
  const dirty = fingerprint(pins) !== fingerprint(saved);

  const save = useCallback(async () => {
    if (configId === null) return false;
    setSavingNow(true);
    setError(null);
    try {
      await api(`/timetable-configs/${configId}/fixed-lessons`, {
        method: "PUT", body: JSON.stringify({ lessons: pins }),
      });
      setSaved(pins);
      return true;
    } catch (e) {
      /*
        The editing set is NOT rolled back on a refusal. The server validates
        the whole set and names the row that is wrong, so what somebody needs
        next is the grid exactly as they left it, with the message above it —
        rolling back would throw away the other nineteen pins to punish the
        twentieth.
      */
      setError(asMessage(e));
      return false;
    } finally {
      setSavingNow(false);
    }
  }, [configId, pins]);

  const revert = useCallback(() => { setPins(saved); setError(null); }, [saved]);

  return {
    pins, at, set, clear, save, revert, dirty, loading, savingNow, error, setError,
    optionsFor, capFor, whyEmpty, empty, repeatAcrossDays, rooms: meta.rooms,
  };
}
