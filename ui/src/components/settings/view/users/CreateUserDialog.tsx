import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { describeUserError } from './errors';
import type { ActionResult, UserRole } from './useUsersAdmin';

type CreateUserDialogProps = {
  onCreate: (username: string, password: string, role: UserRole) => Promise<ActionResult>;
  onClose: () => void;
};

const inputClass =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

export default function CreateUserDialog({ onCreate, onClose }: CreateUserDialogProps) {
  const { t } = useTranslation('settings');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await onCreate(username.trim(), password, role);
      if (result.ok) onClose();
      else setError(describeUserError(t, result));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-label={t('settingsPage.users.newUser')}
        onSubmit={handleSubmit}
        className="w-full max-w-md space-y-4 rounded-xl border border-border bg-background p-5 shadow-xl"
      >
        <h3 className="text-base font-semibold text-foreground">{t('settingsPage.users.newUser')}</h3>
        <div>
          <label htmlFor="new-user-username" className="mb-1 block text-sm font-medium text-foreground">
            {t('settingsPage.users.username')}
          </label>
          <input
            id="new-user-username"
            className={inputClass}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            disabled={submitting}
            required
          />
        </div>
        <div>
          <label htmlFor="new-user-password" className="mb-1 block text-sm font-medium text-foreground">
            {t('settingsPage.users.password')}
          </label>
          <input
            id="new-user-password"
            type="password"
            className={inputClass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            disabled={submitting}
            required
          />
        </div>
        <div>
          <label htmlFor="new-user-role" className="mb-1 block text-sm font-medium text-foreground">
            {t('settingsPage.users.role')}
          </label>
          <select
            id="new-user-role"
            className={inputClass}
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
            disabled={submitting}
          >
            <option value="user">{t('settingsPage.users.roleUser')}</option>
            <option value="admin">{t('settingsPage.users.roleAdmin')}</option>
          </select>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {t('settingsPage.users.cancel')}
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('settingsPage.users.create')}
          </button>
        </div>
      </form>
    </div>
  );
}
