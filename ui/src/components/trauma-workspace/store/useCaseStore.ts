import { useCallback, useEffect, useState } from 'react';
import type { TraumaCasePayload } from '../domain/types';

export function useCaseStore(projectKey?: string, sessionId?: string) {
  const [data, setData] = useState<TraumaCasePayload>({
    current: null,
    snapshots: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectKey || !sessionId) {
      setData({ current: null, snapshots: [] });
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(
        `/api/trauma/cases/${encodeURIComponent(sessionId)}?projectKey=${encodeURIComponent(projectKey)}`,
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(
          typeof payload?.error === 'string' && payload.error
            ? payload.error
            : `HTTP ${response.status}`,
        );
      }
      setData(await response.json() as TraumaCasePayload);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '未知错误');
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

  return { ...data, loading, error, refresh };
}
