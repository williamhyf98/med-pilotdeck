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
  /** Part of `storageBytes` under `<workspaces>/…/inbox` (never auto-cleaned). */
  inboxBytes?: number;
  /** Bytes held by this user's archived home (deleted account), if any. */
  archivedBytes?: number;
  /** True when the account was deleted and its home sits in `archives/users/`. */
  archived?: boolean;
  archivedAt?: string | null;
  /** 归档到期的时刻（服务端按保留天数算好，前端只管显示）。 */
  expiresAt?: string | null;
};
/** Deployment-wide figures behind the storage column (design §9.2.1). */
export type StorageSummary = {
  totalBytes: number;
  totalInboxBytes: number;
  archivedBytes: number;
  userTotalWarningBytes: number;
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
  const [archivedUsers, setArchivedUsers] = useState<AdminUser[]>([]);
  const [storage, setStorage] = useState<StorageSummary | null>(null);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const [u, r] = await Promise.all([api.admin.listUsers(force), api.admin.getRegistration()]);
      const uj = await u.json().catch(() => ({}));
      const rj = await r.json().catch(() => ({}));
      if (!u.ok) throw new Error(uj?.error ?? 'failed');
      setUsers(uj.users ?? []);
      setArchivedUsers(uj.archivedUsers ?? []);
      setStorage(uj.storage ?? null);
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
    /** 已删除、数据仍在归档里的账号，按归档时间从新到旧。 */
    archivedUsers,
    storage,
    loading,
    error,
    registrationOpen,
    refresh,
    /** Manual refresh: bypasses the server's 60 s storage cache. */
    refreshStorage: () => refresh(true),
    createUser: (username: string, password: string, role: UserRole) =>
      after(() => api.admin.createUser(username, password, role)),
    setRole: (id: number, role: UserRole) => after(() => api.admin.patchUser(id, { role })),
    setActive: (id: number, isActive: boolean) => after(() => api.admin.patchUser(id, { isActive })),
    resetPassword: (id: number) => run<{ password: string }>(() => api.admin.resetPassword(id)),
    deleteUser: (id: number) => after(() => api.admin.deleteUser(id)),
    restoreUser: (id: number) => after(() => api.admin.restoreUser(id)),
    setRegistration: (allow: boolean) => after(() => api.admin.setRegistration(allow)),
  };
}
