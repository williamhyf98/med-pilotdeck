import { LogOut, ShieldCheck, User as UserIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/context/AuthContext';

export default function SidebarAccountArea({ onOpenAccount }: { onOpenAccount: () => void }) {
  const { t } = useTranslation();
  const { user, isAdmin, logout, authDisabled } = useAuth();
  if (!user) return null;
  const openLabel = t('sidebar:account.open', { defaultValue: 'Account' }) as string;
  const logoutLabel = t('sidebar:account.logout') as string;
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[13px]">
      <button
        type="button"
        onClick={onOpenAccount}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 hover:bg-accent"
        title={openLabel}
      >
        {isAdmin ? <ShieldCheck className="h-4 w-4 shrink-0" /> : <UserIcon className="h-4 w-4 shrink-0" />}
        <span className="truncate font-medium">{user.username}</span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {authDisabled
            ? t('sidebar:account.localMode')
            : isAdmin
              ? t('sidebar:account.roleAdmin')
              : t('sidebar:account.roleUser')}
        </span>
      </button>
      {authDisabled ? null : (
        <button
          type="button"
          onClick={() => void logout()}
          aria-label={logoutLabel}
          title={logoutLabel}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <LogOut className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
