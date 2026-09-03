import { useCallback, useEffect, useState } from 'react';
import type { TraumaCasePayload } from '../domain/types';

export function useCaseStore(projectKey?: string, sessionId?: string) {
  const [data, setData] = useState<TraumaCasePayload>({
    current: null,
    snapshots: [],
  });
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectKey || !sessionId) {
      setData({ current: null, snapshots: [] });
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(
        `/api/trauma/cases/${encodeURIComponent(sessionId)}?projectKey=${encodeURIComponent(projectKey)}`,
      );
      if (!response.ok) return;
      setData(await response.json() as TraumaCasePayload);
    } finally {
      setLoading(false);
    }
  }, [projectKey, sessionId]);

  useEffect(() => {
    void refresh();
    if (!projectKey || !sessionId) return undefined;
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [projectKey, refresh, sessionId]);

  return { ...data, loading, refresh };
}
