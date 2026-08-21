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
  workingDays: number[];
  periodsPerDay: number;
  periodDurationMins: number;
  hasZeroPeriod: boolean;
  zeroPeriodDurationMins: number | null;
  startTime: string;
  endTime: string | null;
  status: string;
  classSections: string[];
  breaks: { name: string | null; startTime: string; endTime: string }[];
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
