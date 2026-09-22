import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { authenticatedFetch } from "../../../../utils/api";
import { cn } from "../../../../lib/utils";
import { useOptionalAuth } from "../../../auth";
import { PageSectionHeader, SettingsCard } from "../../shared/view";

type ManagedRole = "admin" | "user";

type ManagedUser = {
  id: number;
  username: string;
  role: ManagedRole;
  isActive: boolean;
  createdAt: string | null;
  lastLogin: string | null;
};

type Banner = { kind: "success" | "error"; message: string } | null;

type UserManagementSectionsProps = {
  title: string;
};

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  // SQLite CURRENT_TIMESTAMP is UTC without a timezone marker; normalize so
  // the browser renders it in local time instead of treating it as local.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function UserManagementSections({
  title,
}: UserManagementSectionsProps) {
  const { t } = useTranslation("settings");
  const auth = useOptionalAuth();
  const currentUsername = auth?.user?.username ?? null;

  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [busyUserId, setBusyUserId] = useState<number | null>(null);

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<ManagedRole>("user");
  const [creating, setCreating] = useState(false);

  const translateApiError = useCallback(
    (status: number, payload: { error?: string; code?: string } | null): string => {
      const code = payload?.code;
      if (code === "SELF_LOCKOUT") return t("userManagement.errors.selfLockout");
      if (code === "LAST_ADMIN") return t("userManagement.errors.lastAdmin");
      if (status === 409) return t("userManagement.errors.usernameExists");
      if (payload?.error) return payload.error;
      return t("userManagement.errors.generic");
    },
    [t],
  );

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await authenticatedFetch("/api/admin/users");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setUsers(Array.isArray(data?.users) ? data.users : []);
    } catch (error) {
      console.error("Failed to load users:", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const handleCreate = async () => {
    const username = newUsername.trim();
    if (username.length < 3 || newPassword.length < 6) {
      setBanner({ kind: "error", message: t("userManagement.errors.invalidInput") });
      return;
    }
    setCreating(true);
    try {
      const res = await authenticatedFetch("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ username, password: newPassword, role: newRole }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setBanner({ kind: "error", message: translateApiError(res.status, data) });
        return;
      }
      if (data?.user) {
        setUsers((prev) => [...prev, data.user]);
      }
      setNewUsername("");
      setNewPassword("");
      setNewRole("user");
      setBanner({
        kind: "success",
        message: t("userManagement.created", { username }),
      });
    } catch (error) {
      console.error("Failed to create user:", error);
      setBanner({ kind: "error", message: t("userManagement.errors.generic") });
    } finally {
      setCreating(false);
    }
  };

  const patchUser = useCallback(
    async (
      userId: number,
      body: { role?: ManagedRole; isActive?: boolean; password?: string },
      successMessage?: string,
    ) => {
      setBusyUserId(userId);
      try {
        const res = await authenticatedFetch(`/api/admin/users/${userId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setBanner({ kind: "error", message: translateApiError(res.status, data) });
          return;
        }
        if (data?.user) {
          setUsers((prev) =>
            prev.map((u) => (u.id === userId ? data.user : u)),
          );
        }
        if (successMessage) {
          setBanner({ kind: "success", message: successMessage });
        }
      } catch (error) {
        console.error("Failed to update user:", error);
        setBanner({ kind: "error", message: t("userManagement.errors.generic") });
      } finally {
        setBusyUserId(null);
      }
    },
    [t, translateApiError],
  );

  const handleResetPassword = (user: ManagedUser) => {
    const next = window.prompt(
      t("userManagement.resetPasswordPrompt", { username: user.username }),
    );
    if (next === null) return;
    if (next.length < 6) {
      setBanner({ kind: "error", message: t("userManagement.errors.passwordTooShort") });
      return;
    }
    void patchUser(
      user.id,
      { password: next },
      t("userManagement.resetPasswordDone", { username: user.username }),
    );
  };

  const inputClass =
    "h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>

      {banner ? (
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            banner.kind === "success"
              ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-300"
              : "border-red-300 bg-red-50 text-red-700 dark:border-red-800/60 dark:bg-red-950/30 dark:text-red-300",
          )}
        >
          {banner.message}
        </div>
      ) : null}

      <PageSectionHeader
        title={t("userManagement.createTitle")}
        description={t("userManagement.createDescription")}
      />
      <SettingsCard>
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <input
            type="text"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            placeholder={t("userManagement.usernamePlaceholder")}
            autoComplete="off"
            className={cn(inputClass, "w-44 flex-1 md:flex-none")}
          />
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder={t("userManagement.passwordPlaceholder")}
            autoComplete="new-password"
            className={cn(inputClass, "w-52 flex-1 md:flex-none")}
          />
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as ManagedRole)}
            className={cn(inputClass, "w-32 cursor-pointer")}
          >
            <option value="user">{t("userManagement.roleUser")}</option>
            <option value="admin">{t("userManagement.roleAdmin")}</option>
          </select>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UserPlus className="h-4 w-4" />
            )}
            {t("userManagement.create")}
          </button>
        </div>
      </SettingsCard>

      <PageSectionHeader
        title={t("userManagement.listTitle")}
        description={t("userManagement.selfNote")}
      />
      <SettingsCard className="overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("userManagement.loading")}
          </div>
        ) : loadError ? (
          <div className="flex items-center justify-between px-5 py-6 text-sm text-red-600 dark:text-red-300">
            <span>{t("userManagement.loadError")}</span>
            <button
              type="button"
              onClick={() => void loadUsers()}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted"
            >
              {t("userManagement.retry")}
            </button>
          </div>
        ) : users.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            {t("userManagement.empty")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-5 py-3 font-medium">
                    {t("userManagement.columns.username")}
                  </th>
                  <th className="px-3 py-3 font-medium">
                    {t("userManagement.columns.role")}
                  </th>
                  <th className="px-3 py-3 font-medium">
                    {t("userManagement.columns.status")}
                  </th>
                  <th className="px-3 py-3 font-medium">
                    {t("userManagement.columns.createdAt")}
                  </th>
                  <th className="px-3 py-3 font-medium">
                    {t("userManagement.columns.lastLogin")}
                  </th>
                  <th className="px-5 py-3 text-right font-medium">
                    {t("userManagement.columns.actions")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {users.map((user) => {
                  const isSelf =
                    currentUsername !== null && user.username === currentUsername;
                  const busy = busyUserId === user.id;
                  return (
                    <tr
                      key={user.id}
                      className={cn("text-foreground", !user.isActive && "opacity-60")}
                    >
                      <td className="max-w-[180px] truncate px-5 py-3 font-medium">
                        {user.username}
                        {isSelf ? (
                          <span className="ml-2 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                            {t("userManagement.you")}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-3">
                        <select
                          value={user.role}
                          onChange={(e) =>
                            void patchUser(user.id, {
                              role: e.target.value as ManagedRole,
                            })
                          }
                          disabled={busy || isSelf}
                          title={isSelf ? t("userManagement.selfNote") : undefined}
                          className={cn(
                            "h-8 cursor-pointer rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                            (busy || isSelf) && "cursor-not-allowed opacity-60",
                          )}
                        >
                          <option value="user">{t("userManagement.roleUser")}</option>
                          <option value="admin">{t("userManagement.roleAdmin")}</option>
                        </select>
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
                            user.isActive
                              ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-300"
                              : "border-red-300 bg-red-50 text-red-700 dark:border-red-800/60 dark:bg-red-950/30 dark:text-red-300",
                          )}
                        >
                          {user.isActive
                            ? t("userManagement.statusActive")
                            : t("userManagement.statusDisabled")}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">
                        {formatDateTime(user.createdAt)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">
                        {user.lastLogin
                          ? formatDateTime(user.lastLogin)
                          : t("userManagement.never")}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleResetPassword(user)}
                            disabled={busy}
                            className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <KeyRound className="h-3.5 w-3.5" />
                            {t("userManagement.resetPassword")}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void patchUser(user.id, { isActive: !user.isActive })
                            }
                            disabled={busy || (isSelf && user.isActive)}
                            title={
                              isSelf && user.isActive
                                ? t("userManagement.selfNote")
                                : undefined
                            }
                            className={cn(
                              "inline-flex h-8 items-center rounded-md border px-2.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                              user.isActive
                                ? "border-red-300 text-red-600 hover:bg-red-50 dark:border-red-800/60 dark:text-red-300 dark:hover:bg-red-950/30"
                                : "border-emerald-300 text-emerald-600 hover:bg-emerald-50 dark:border-emerald-800/60 dark:text-emerald-300 dark:hover:bg-emerald-950/30",
                            )}
                          >
                            {busy ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : user.isActive ? (
                              t("userManagement.disable")
                            ) : (
                              t("userManagement.enable")
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SettingsCard>
    </div>
  );
}
