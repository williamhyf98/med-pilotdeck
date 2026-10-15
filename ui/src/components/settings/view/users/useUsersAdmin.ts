import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../utils/api';

export type UserRole = 'admin' | 'user';
export type AdminUser = {
  id: number;
  username: string;
  role: UserRole;
  isActive: boolean;
  createdAt?: string;
  lastLogin?: string | null;
  storageBytes?: number;
};
export type ActionResult<T = unknown> =
  | { ok: true; data?: T }
  | { ok: false; code: string; message: string };

async function readResult<T>(res: Response): Promise<ActionResult<T>> {
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, data: body as T };
  return { ok: false, code: body?.code ?? `HTTP_${res.status}`, message: body?.error ?? res.statusText };
}

// Network failures and other rejections become a failed result, so callers
// only ever have to handle one shape.
function run<T = unknown>(request: () => Promise<Response>): Promise<ActionResult<T>> {
  return Promise.resolve()
    .then(request)
    .then((res) => readResult<T>(res))
    .catch((e: unknown): ActionResult<T> => ({
      ok: false,
      code: 'NETWORK',
      message: e instanceof Error ? e.message : String(e),
    }));
}

export function useUsersAdmin() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, r] = await Promise.all([api.admin.listUsers(), api.admin.getRegistration()]);
      const uj = await u.json().catch(() => ({}));
      const rj = await r.json().catch(() => ({}));
      if (!u.ok) throw new Error(uj?.error ?? 'failed');
      setUsers(uj.users ?? []);
      setRegistrationOpen(Boolean(rj?.allowPublicRegistration));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const after = async <T,>(request: () => Promise<Response>): Promise<ActionResult<T>> => {
    const result = await run<T>(request);
    if (result.ok) await refresh();
    return result;
  };

  return {
    users,
    loading,
    error,
    registrationOpen,
    refresh,
    createUser: (username: string, password: string, role: UserRole) =>
      after(() => api.admin.createUser(username, password, role)),
    setRole: (id: number, role: UserRole) => after(() => api.admin.patchUser(id, { role })),
    setActive: (id: number, isActive: boolean) => after(() => api.admin.patchUser(id, { isActive })),
    resetPassword: (id: number) => run<{ password: string }>(() => api.admin.resetPassword(id)),
    deleteUser: (id: number) => after(() => api.admin.deleteUser(id)),
    setRegistration: (allow: boolean) => after(() => api.admin.setRegistration(allow)),
  };
}
