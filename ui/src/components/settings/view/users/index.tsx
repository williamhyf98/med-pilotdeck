import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../auth/context/AuthContext';
import { formatBytes } from '../../../../utils/formatBytes';
import { SettingsCard, SettingsRow, SettingsToggle } from '../../shared/view';
import CreateUserDialog from './CreateUserDialog';
import { describeUserError } from './errors';
import { useUsersAdmin } from './useUsersAdmin';
import type { ActionResult, AdminUser, UserRole } from './useUsersAdmin';

type PendingConfirm =
  | { kind: 'deactivate'; id: number }
  | { kind: 'demote'; id: number }
  | { kind: 'delete'; id: number };

type IssuedPassword = { username: string; password: string };

const buttonClass =
  'rounded-md border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';
const primaryButtonClass =
  'rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50';

function formatDate(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function UsersSettings({ title }: { title?: string }) {
  const { t } = useTranslation('settings');
  const { user: me } = useAuth();
  const admin = useUsersAdmin();
  const [showCreate, setShowCreate] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [issued, setIssued] = useState<IssuedPassword | null>(null);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<ActionResult>): Promise<boolean> => {
    setActionError('');
    setBusy(true);
    try {
      const result = await action();
      if (!result.ok) {
        setActionError(describeUserError(t, result));
        return false;
      }
      return true;
    } finally {
      setBusy(false);
    }
  };

  const isSelf = (target: AdminUser) => me?.id === target.id;

  const handleRole = (target: AdminUser, role: UserRole) => {
    if (role === target.role) return;
    if (isSelf(target) && role !== 'admin') {
      setConfirm({ kind: 'demote', id: target.id });
      return;
    }
    void run(() => admin.setRole(target.id, role));
  };

  const handleActive = (target: AdminUser, next: boolean) => {
    if (isSelf(target) && !next) {
      setConfirm({ kind: 'deactivate', id: target.id });
      return;
    }
    void run(() => admin.setActive(target.id, next));
  };

  const handleReset = async (target: AdminUser) => {
    setActionError('');
    setBusy(true);
    try {
      const result = await admin.resetPassword(target.id);
      if (!result.ok) {
        setActionError(describeUserError(t, result));
      } else if (result.data?.password) {
        setCopied(false);
        setIssued({ username: target.username, password: result.data.password });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async () => {
    if (!confirm) return;
    const { kind, id } = confirm;
    setConfirm(null);
    if (kind === 'demote') await run(() => admin.setRole(id, 'user'));
    else if (kind === 'deactivate') await run(() => admin.setActive(id, false));
    else await run(() => admin.deleteUser(id));
  };

  const handleCopy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const closeIssued = () => {
    setIssued(null);
    setCopied(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-2xl font-semibold text-foreground">{title ?? t('settingsPage.users.title')}</h2>
        <button type="button" className={primaryButtonClass} onClick={() => setShowCreate(true)}>
          {t('settingsPage.users.newUser')}
        </button>
      </div>

      <SettingsCard>
        <SettingsRow
          label={t('settingsPage.users.registration')}
          description={
            admin.registrationOpen
              ? t('settingsPage.users.registrationOn')
              : t('settingsPage.users.registrationOff')
          }
        >
          <SettingsToggle
            checked={admin.registrationOpen}
            ariaLabel={t('settingsPage.users.registration')}
            disabled={busy}
            onChange={(next) => void run(() => admin.setRegistration(next))}
          />
        </SettingsRow>
      </SettingsCard>

      {admin.error ? (
        <p role="alert" className="text-sm text-destructive">
          {admin.error}
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-border bg-card/50">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{t('settingsPage.users.username')}</th>
              <th className="px-3 py-2 font-medium">{t('settingsPage.users.role')}</th>
              <th className="px-3 py-2 font-medium">{t('settingsPage.users.active')}</th>
              <th className="px-3 py-2 font-medium">{t('settingsPage.users.createdAt')}</th>
              <th className="px-3 py-2 font-medium">{t('settingsPage.users.lastLogin')}</th>
              <th className="px-3 py-2 font-medium">{t('settingsPage.users.storage')}</th>
              <th className="px-3 py-2 font-medium">{t('settingsPage.users.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {admin.users.flatMap((target) => {
              const self = isSelf(target);
              const pending = confirm?.id === target.id ? confirm : null;
              const rows = [
                <tr key={target.id}>
                  <td className="px-3 py-2 font-medium text-foreground">{target.username}</td>
                  <td className="px-3 py-2">
                    <select
                      aria-label={t('settingsPage.users.role')}
                      className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                      value={target.role}
                      disabled={busy}
                      onChange={(e) => handleRole(target, e.target.value as UserRole)}
                    >
                      <option value="admin">{t('settingsPage.users.roleAdmin')}</option>
                      <option value="user">{t('settingsPage.users.roleUser')}</option>
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <SettingsToggle
                      checked={target.isActive}
                      ariaLabel={t('settingsPage.users.active')}
                      disabled={busy}
                      onChange={(next) => handleActive(target, next)}
                    />
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{formatDate(target.createdAt)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{formatDate(target.lastLogin)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{formatBytes(target.storageBytes)}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={busy || self}
                        title={self ? t('settingsPage.users.cannotResetSelf') : undefined}
                        onClick={() => void handleReset(target)}
                      >
                        {t('settingsPage.users.resetPassword')}
                      </button>
                      <button
                        type="button"
                        className={`${buttonClass} text-destructive`}
                        disabled={busy || self}
                        title={self ? t('settingsPage.users.cannotDeleteSelf') : undefined}
                        onClick={() => setConfirm({ kind: 'delete', id: target.id })}
                      >
                        {t('settingsPage.users.delete')}
                      </button>
                    </div>
                  </td>
                </tr>,
              ];
              if (pending) {
                rows.push(
                  <tr key={`${target.id}-confirm`} className="bg-muted/40">
                    <td colSpan={7} className="px-3 py-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <p className="min-w-0 flex-1 text-sm text-foreground">
                          {pending.kind === 'delete'
                            ? t('settingsPage.users.deleteExplain')
                            : t('settingsPage.users.selfLockoutWarning')}
                        </p>
                        <button type="button" className={primaryButtonClass} disabled={busy} onClick={() => void handleConfirm()}>
                          {t('settingsPage.users.confirm')}
                        </button>
                        <button type="button" className={buttonClass} onClick={() => setConfirm(null)}>
                          {t('settingsPage.users.cancel')}
                        </button>
                      </div>
                    </td>
                  </tr>,
                );
              }
              return rows;
            })}
          </tbody>
        </table>
      </div>

      {showCreate ? (
        <CreateUserDialog onCreate={admin.createUser} onClose={() => setShowCreate(false)} />
      ) : null}

      {issued ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('settingsPage.users.resetPassword')}
            className="w-full max-w-md space-y-3 rounded-xl border border-border bg-background p-5 shadow-xl"
          >
            <h3 className="text-base font-semibold text-foreground">
              {t('settingsPage.users.resetPassword')}: {issued.username}
            </h3>
            <p className="text-sm text-muted-foreground">{t('settingsPage.users.resetDone')}</p>
            <div className="flex gap-2">
              <input
                readOnly
                value={issued.password}
                aria-label={t('settingsPage.users.newPassword')}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm text-foreground"
              />
              <button type="button" className={buttonClass} onClick={() => void handleCopy()}>
                {copied ? t('settingsPage.users.copied') : t('settingsPage.users.copy')}
              </button>
            </div>
            <div className="flex justify-end">
              <button type="button" className={primaryButtonClass} onClick={closeIssued}>
                {t('settingsPage.users.close')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
