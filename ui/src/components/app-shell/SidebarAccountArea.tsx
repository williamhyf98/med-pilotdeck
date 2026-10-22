import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LogOut, Settings, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/context/AuthContext';

export default function SidebarAccountArea({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation();
  const { user, isAdmin, logout, authDisabled } = useAuth();
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const logoutButtonRef = useRef<HTMLButtonElement>(null);
  const wasConfirmingRef = useRef(false);

  useEffect(() => {
    if (confirmingLogout) cancelRef.current?.focus();
    else if (wasConfirmingRef.current && !loggingOut) logoutButtonRef.current?.focus();
    wasConfirmingRef.current = confirmingLogout;
  }, [confirmingLogout, loggingOut]);

  if (!user) return null;
  const settingsLabel = t('sidebar:actions.settings', { defaultValue: 'Settings' }) as string;
  const logoutLabel = t('sidebar:account.logout') as string;
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-2 py-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-300 text-white dark:bg-neutral-600" aria-hidden="true">
        <UserRound className="h-[18px] w-[18px]" strokeWidth={1.9} />
      </div>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-[13px] font-semibold text-foreground" title={user.username}>{user.username}</div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {authDisabled
            ? t('sidebar:account.localMode')
            : isAdmin
              ? t('sidebar:account.roleAdmin')
              : t('sidebar:account.roleUser')}
        </div>
      </div>
      <button
        type="button"
        onClick={onOpenSettings}
        aria-label={settingsLabel}
        title={settingsLabel}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Settings className="h-4 w-4" strokeWidth={1.8} />
      </button>
      {authDisabled ? null : (
        <button
          ref={logoutButtonRef}
          type="button"
          onClick={() => setConfirmingLogout(true)}
          aria-label={logoutLabel}
          title={logoutLabel}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-red-600 text-red-700 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:border-red-400 dark:text-red-300 dark:hover:bg-red-950/40"
        >
          <LogOut className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
      {confirmingLogout && !authDisabled ? createPortal(
        <div className="pd-settings-backdrop-enter fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="logout-confirm-title"
            aria-describedby="logout-confirm-description"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !loggingOut) setConfirmingLogout(false);
            }}
            className="pd-settings-dialog-enter w-full max-w-sm rounded-xl border border-border bg-card p-5 text-card-foreground shadow-xl"
          >
            <h2 id="logout-confirm-title" className="text-base font-semibold">
              {t('sidebar:account.logoutConfirmTitle', { defaultValue: 'Sign out?' })}
            </h2>
            <p id="logout-confirm-description" className="mt-2 text-sm text-muted-foreground">
              {t('sidebar:account.logoutConfirmDescription', { defaultValue: 'Are you sure you want to sign out?' })}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                ref={cancelRef}
                type="button"
                onClick={() => setConfirmingLogout(false)}
                disabled={loggingOut}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
              >
                {t('sidebar:actions.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                type="button"
                onClick={async () => {
                  setLoggingOut(true);
                  try {
                    await logout();
                  } finally {
                    setLoggingOut(false);
                    setConfirmingLogout(false);
                  }
                }}
                disabled={loggingOut}
                className="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              >
                {logoutLabel}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
