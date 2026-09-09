import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api";

/** Fetch-on-mount with manual refetch — enough data layer for Phase 1 screens. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(() => {
    if (!path) return;
    api<T>(path)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [path]);

  useEffect(() => {
    setLoading(true);
    refetch();
  }, [refetch]);

  return { data, error, loading, refetch };
}

export interface TimetableConfigSummary {
  id: number;
  name: string;
  description: string | null;
  academicYear: string;
  academicYearId: number;
  /** §30 — which resource pool this timetable competes in. */
  resourceGroupId?: number;
  resourceGroupName?: string;
  /** §30.1 — `individual` stands alone: its own cohorts, calculated by itself. */
  resourceMode?: "grouped" | "individual";
  /**
   * §30.5 — when this timetable applies. Both null means the whole session,
   * which is every school before the feature; screens then show the SESSION's
   * name rather than inventing a date range (`windowLabel` returns null).
   */
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  workingDays: number[];
  periodsPerDay: number;
  periodDurationMins: number;
  hasZeroPeriod: boolean;
  zeroPeriodDurationMins: number | null;
  /** §18: periods appended after the school day for extra/guest classes. */
  extraPeriodsPerDay?: number;
  extraPeriodDurationMins?: number | null;
  /** §28.1 — the % of a teacher's weekly limit at which the app says so. */
  loadAlertPct?: number;
  startTime: string;
  endTime: string | null;
  status: string;
  /**
   * §29.1 — when this timetable's published week was settled, or null.
   *
   * Served with the config so every screen reads one answer. It is for
   * EXPLAINING and disabling only: `FreezeService` refuses the write whether or
   * not a button was greyed out, exactly as §15's view scoping treats hidden
   * nav items as cosmetic.
   */
  frozenAt?: string | null;
  classSections: string[];
  breaks: { name: string | null; startTime: string; endTime: string }[];
  /** Every row of the day in order, breaks included — what §4.7a's grid draws. */
  periods?: {
    periodNumber: number | null;
    /** §28.3 — an assembly or a dispersal: a staffed band, not a break. */
    isActivity?: boolean;
    startTime: string;
    endTime: string;
    isBreak: boolean;
    breakName: string | null;
  }[];
}

interface ConfigCtx {
  configs: TimetableConfigSummary[];
  current: TimetableConfigSummary | null;
  setCurrentId: (id: number) => void;
  refetch: () => void;
}

export const ConfigContext = createContext<ConfigCtx>({
  configs: [],
  current: null,
  setCurrentId: () => {},
  refetch: () => {},
});

export const useConfigCtx = () => useContext(ConfigContext);
