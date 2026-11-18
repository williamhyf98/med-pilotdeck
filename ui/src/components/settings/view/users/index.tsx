import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
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
  | { kind: 'delete'; id: number }
  | { kind: 'restore'; id: number };

type IssuedPassword = { username: string; password: string };

type UserSortKey = 'username' | 'role' | 'isActive' | 'createdAt' | 'lastLogin' | 'storage' | 'inbox';
type ArchivedSortKey = 'username' | 'role' | 'archivedAt' | 'expiresAt' | 'storage';
type SortState<K extends string> = { key: K; direction: 'asc' | 'desc' };

const USERS_PER_PAGE = 10;
const ARCHIVED_USERS_PER_PAGE = 5;

const buttonClass =
  'rounded-md border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';
const primaryButtonClass =
  'rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50';

function userStorageBytes(target: AdminUser): number {
  return (target.storageBytes ?? 0) + (target.archivedBytes ?? 0);
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function compareDateValues(left: string | null | undefined, right: string | null | undefined): number {
  const leftTime = left ? new Date(left).getTime() : 0;
  const rightTime = right ? new Date(right).getTime() : 0;
  return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
}

function compareUsers(
  left: AdminUser,
  right: AdminUser,
  key: UserSortKey,
  collator: Intl.Collator,
  roleLabels: Record<UserRole, string>,
): number {
  if (key === 'username') {
    return collator.compare(left.username, right.username);
  }
  if (key === 'role') {
    return collator.compare(roleLabels[left.role], roleLabels[right.role]);
  }
  if (key === 'isActive') {
    return Number(left.isActive) - Number(right.isActive);
  }
  if (key === 'storage') {
    return userStorageBytes(left) - userStorageBytes(right);
  }
  if (key === 'inbox') {
    return (left.inboxBytes ?? 0) - (right.inboxBytes ?? 0);
  }

  const leftTime = left[key] ? new Date(left[key] as string).getTime() : 0;
  const rightTime = right[key] ? new Date(right[key] as string).getTime() : 0;
  return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
}

function compareArchivedUsers(
  left: AdminUser,
  right: AdminUser,
  key: ArchivedSortKey,
  collator: Intl.Collator,
  roleLabels: Record<UserRole, string>,
): number {
  if (key === 'username') return collator.compare(left.username, right.username);
  if (key === 'role') return collator.compare(roleLabels[left.role], roleLabels[right.role]);
  if (key === 'storage') return (left.archivedBytes ?? 0) - (right.archivedBytes ?? 0);
  if (key === 'archivedAt') return compareDateValues(left.archivedAt, right.archivedAt);
  return compareDateValues(left.expiresAt, right.expiresAt);
}

function UsernameCell({
  username,
  archived = false,
  archivedLabel,
}: {
  username: string;
  archived?: boolean;
  archivedLabel: string;
}) {
  return (
    <td className="w-[220px] max-w-[220px] overflow-hidden px-3 py-2 font-medium text-foreground">
      <span className="flex min-w-0 max-w-[220px] items-center">
        <span
          className="min-w-0 flex-1 truncate whitespace-nowrap"
          title={username}
        >
          {username}
        </span>
        {archived ? (
          <span className="ml-2 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
            {archivedLabel}
          </span>
        ) : null}
      </span>
    </td>
  );
}

function SortableHeader<K extends string>({
  label,
  sortKey,
  activeSort,
  onSort,
  sortLabel,
  ascendingLabel,
  descendingLabel,
}: {
  label: string;
  sortKey: K;
  activeSort: SortState<K>;
  onSort: (key: K) => void;
  sortLabel: string;
  ascendingLabel: string;
  descendingLabel: string;
}) {
  const active = activeSort.key === sortKey;
  const direction = activeSort.direction;
  const Icon = active ? (direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  const directionLabel = active ? (direction === 'asc' ? ascendingLabel : descendingLabel) : sortLabel;

  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground"
      aria-label={`${label} · ${directionLabel}`}
      title={`${label} · ${directionLabel}`}
      onClick={() => onSort(sortKey)}
    >
      <span>{label}</span>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    </button>
  );
}

export default function UsersSettings({ title }: { title?: string }) {
  const { t } = useTranslation('settings');
  const { user: me } = useAuth();
  const admin = useUsersAdmin();
  const [showCreate, setShowCreate] = useState(false);
  // Keep the existing default: largest accounts first.
  const [sort, setSort] = useState<SortState<UserSortKey>>({ key: 'storage', direction: 'desc' });
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [archivedSearchQuery, setArchivedSearchQuery] = useState('');
  const [archivedSort, setArchivedSort] = useState<SortState<ArchivedSortKey>>({
    key: 'archivedAt',
    direction: 'desc',
  });
  const [archivedPage, setArchivedPage] = useState(1);
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

  // Live home + archived home, both count against the deployment total.
  const totalBytes =
    admin.storage?.totalBytes ?? admin.users.reduce((sum, target) => sum + userStorageBytes(target), 0);
  const warningBytes = admin.storage?.userTotalWarningBytes ?? 0;
  const sortedUsers = useMemo(
    () => {
      const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
      const filtered = admin.users.filter((target) => (
        !target.archived
        && (!normalizedQuery || target.username.toLocaleLowerCase().includes(normalizedQuery))
      ));
      const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
      const direction = sort.direction === 'asc' ? 1 : -1;
      const roleLabels: Record<UserRole, string> = {
        admin: t('settingsPage.users.roleAdmin'),
        user: t('settingsPage.users.roleUser'),
      };
      return filtered
        .map((target, index) => ({ target, index }))
        .sort((left, right) => (
          direction * compareUsers(left.target, right.target, sort.key, collator, roleLabels)
          || collator.compare(left.target.username, right.target.username)
          || left.index - right.index
        ))
        .map(({ target }) => target);
    },
    [admin.users, searchQuery, sort, t],
  );
  /** 在用账号数（归档账号单独一块，不计入"全部用户"）。 */
  const liveUserCount = admin.users.filter((target) => !target.archived).length;
  const pageCount = Math.max(1, Math.ceil(sortedUsers.length / USERS_PER_PAGE));
  const currentPage = Math.min(page, pageCount);
  const pagedUsers = sortedUsers.slice(
    (currentPage - 1) * USERS_PER_PAGE,
    currentPage * USERS_PER_PAGE,
  );
  const sortedArchivedUsers = useMemo(
    () => {
      const normalizedQuery = archivedSearchQuery.trim().toLocaleLowerCase();
      const filtered = admin.archivedUsers.filter((target) => (
        !normalizedQuery || target.username.toLocaleLowerCase().includes(normalizedQuery)
      ));
      const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
      const direction = archivedSort.direction === 'asc' ? 1 : -1;
      const roleLabels: Record<UserRole, string> = {
        admin: t('settingsPage.users.roleAdmin'),
        user: t('settingsPage.users.roleUser'),
      };
      return filtered
        .map((target, index) => ({ target, index }))
        .sort((left, right) => (
          direction * compareArchivedUsers(left.target, right.target, archivedSort.key, collator, roleLabels)
          || collator.compare(left.target.username, right.target.username)
          || left.index - right.index
        ))
        .map(({ target }) => target);
    },
    [admin.archivedUsers, archivedSearchQuery, archivedSort, t],
  );
  const archivedPageCount = Math.max(1, Math.ceil(sortedArchivedUsers.length / ARCHIVED_USERS_PER_PAGE));
  const currentArchivedPage = Math.min(archivedPage, archivedPageCount);
  const pagedArchivedUsers = sortedArchivedUsers.slice(
    (currentArchivedPage - 1) * ARCHIVED_USERS_PER_PAGE,
    currentArchivedPage * ARCHIVED_USERS_PER_PAGE,
  );
  const archivedHeaders: Array<{ key: ArchivedSortKey; label: string }> = [
    { key: 'username', label: t('settingsPage.users.username') },
    { key: 'role', label: t('settingsPage.users.role') },
    { key: 'archivedAt', label: t('settingsPage.users.archivedAt') },
    { key: 'expiresAt', label: t('settingsPage.users.expiresAt') },
    { key: 'storage', label: t('settingsPage.users.storage') },
  ];

  const toggleSort = (key: UserSortKey) => {
    setSort((current) => (
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' }
    ));
    setPage(1);
  };

  const toggleArchivedSort = (key: ArchivedSortKey) => {
    setArchivedSort((current) => (
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' }
    ));
    setArchivedPage(1);
  };

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
    else if (kind === 'restore') await run(() => admin.restoreUser(id));
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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">{title ?? t('settingsPage.users.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('settingsPage.users.summary', { size: formatBytes(totalBytes), count: liveUserCount })}
            {' · '}
            {t('settingsPage.users.summaryInbox', { size: formatBytes(admin.storage?.totalInboxBytes ?? 0) })}
            {warningBytes > 0 ? ` · ${t('settingsPage.users.summaryWarning', { size: formatBytes(warningBytes) })}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={busy || admin.loading}
            onClick={() => void admin.refreshStorage()}
          >
            {t('settingsPage.users.refresh')}
          </button>
          <button type="button" className={primaryButtonClass} onClick={() => setShowCreate(true)}>
            {t('settingsPage.users.newUser')}
          </button>
        </div>
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

      <div>
        <div className="mb-3">
          <label htmlFor="users-username-search" className="sr-only">
            {t('settingsPage.users.searchUsername')}
          </label>
          <input
            id="users-username-search"
            type="search"
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setPage(1);
            }}
            placeholder={t('settingsPage.users.searchUsernamePlaceholder')}
            className="w-full max-w-xs rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="overflow-x-auto rounded-xl border border-border bg-card/50">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th className="whitespace-nowrap px-3 py-2 font-medium">
                  <SortableHeader
                    label={t('settingsPage.users.username')}
                    sortKey="username"
                    activeSort={sort}
                    onSort={toggleSort}
                    sortLabel={t('settingsPage.users.sort')}
                    ascendingLabel={t('settingsPage.users.ascending')}
                    descendingLabel={t('settingsPage.users.descending')}
                  />
                </th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">
                  <SortableHeader
                    label={t('settingsPage.users.role')}
                    sortKey="role"
                    activeSort={sort}
                    onSort={toggleSort}
                    sortLabel={t('settingsPage.users.sort')}
                    ascendingLabel={t('settingsPage.users.ascending')}
                    descendingLabel={t('settingsPage.users.descending')}
                  />
                </th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">
                  <SortableHeader
                    label={t('settingsPage.users.active')}
                    sortKey="isActive"
                    activeSort={sort}
                    onSort={toggleSort}
                    sortLabel={t('settingsPage.users.sort')}
                    ascendingLabel={t('settingsPage.users.ascending')}
                    descendingLabel={t('settingsPage.users.descending')}
                  />
                </th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">
                  <SortableHeader
                    label={t('settingsPage.users.createdAt')}
                    sortKey="createdAt"
                    activeSort={sort}
                    onSort={toggleSort}
                    sortLabel={t('settingsPage.users.sort')}
                    ascendingLabel={t('settingsPage.users.ascending')}
                    descendingLabel={t('settingsPage.users.descending')}
                  />
                </th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">
                  <SortableHeader
                    label={t('settingsPage.users.lastLogin')}
                    sortKey="lastLogin"
                    activeSort={sort}
                    onSort={toggleSort}
                    sortLabel={t('settingsPage.users.sort')}
                    ascendingLabel={t('settingsPage.users.ascending')}
                    descendingLabel={t('settingsPage.users.descending')}
                  />
                </th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">
                  <SortableHeader
                    label={t('settingsPage.users.storage')}
                    sortKey="storage"
                    activeSort={sort}
                    onSort={toggleSort}
                    sortLabel={t('settingsPage.users.sort')}
                    ascendingLabel={t('settingsPage.users.ascending')}
                    descendingLabel={t('settingsPage.users.descending')}
                  />
                </th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">
                  <SortableHeader
                    label={t('settingsPage.users.inbox')}
                    sortKey="inbox"
                    activeSort={sort}
                    onSort={toggleSort}
                    sortLabel={t('settingsPage.users.sort')}
                    ascendingLabel={t('settingsPage.users.ascending')}
                    descendingLabel={t('settingsPage.users.descending')}
                  />
                </th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">{t('settingsPage.users.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {pagedUsers.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    {t('settingsPage.users.noMatchingUsers')}
                  </td>
                </tr>
              ) : pagedUsers.flatMap((target) => {
              const self = isSelf(target);
              const pending = confirm?.id === target.id ? confirm : null;
              const overWarning = warningBytes > 0 && userStorageBytes(target) > warningBytes;
              const rows = [
                <tr key={target.id}>
                  <UsernameCell
                    username={target.username}
                    archived={(target.archivedBytes ?? 0) > 0}
                    archivedLabel={t('settingsPage.users.archivedTag')}
                  />
                  <td className="whitespace-nowrap px-3 py-2">
                    <select
                      aria-label={t('settingsPage.users.role')}
                      className="min-w-24 rounded-md border border-border bg-background px-2 py-1 text-sm"
                      value={target.role}
                      disabled={busy}
                      onChange={(e) => handleRole(target, e.target.value as UserRole)}
                    >
                      <option value="admin">{t('settingsPage.users.roleAdmin')}</option>
                      <option value="user">{t('settingsPage.users.roleUser')}</option>
                    </select>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <SettingsToggle
                      checked={target.isActive}
                      ariaLabel={t('settingsPage.users.active')}
                      disabled={busy}
                      onChange={(next) => handleActive(target, next)}
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatDate(target.createdAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatDate(target.lastLogin)}</td>
                  <td
                    className={`whitespace-nowrap px-3 py-2 ${
                      overWarning
                        ? 'font-medium text-amber-600 dark:text-amber-400'
                        : 'text-muted-foreground'
                    }`}
                    title={overWarning ? t('settingsPage.users.overWarning', { size: formatBytes(warningBytes) }) : undefined}
                  >
                    {formatBytes(userStorageBytes(target))}
                    {(target.archivedBytes ?? 0) > 0 ? (
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        {t('settingsPage.users.archivedNote', { size: formatBytes(target.archivedBytes) })}
                      </span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {formatBytes(target.inboxBytes)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <div className="flex flex-nowrap gap-2">
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
                    <td colSpan={8} className="px-3 py-3">
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

        {sortedUsers.length > 0 ? (
          <div className="flex items-center justify-between gap-3 px-1 py-3 text-sm text-muted-foreground">
            <span>{t('settingsPage.users.pageOf', { page: currentPage, pages: pageCount })}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={buttonClass}
                disabled={currentPage <= 1}
                aria-label={t('settingsPage.users.previousPage')}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                {t('settingsPage.users.previousPage')}
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={currentPage >= pageCount}
                aria-label={t('settingsPage.users.nextPage')}
                onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
              >
                {t('settingsPage.users.nextPage')}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {admin.archivedUsers.length > 0 ? (
        <div className="space-y-3">
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              {t('settingsPage.users.archivedTitle')}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('settingsPage.users.archivedSummary', { count: admin.archivedUsers.length })}
            </p>
          </div>
          <div className="mb-3">
            <label htmlFor="archived-users-username-search" className="sr-only">
              {t('settingsPage.users.searchArchivedUsername')}
            </label>
            <input
              id="archived-users-username-search"
              type="search"
              value={archivedSearchQuery}
              onChange={(event) => {
                setArchivedSearchQuery(event.target.value);
                setArchivedPage(1);
              }}
              placeholder={t('settingsPage.users.searchUsernamePlaceholder')}
              className="w-full max-w-xs rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="overflow-x-auto rounded-xl border border-border bg-card/50">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-border text-xs text-muted-foreground">
                <tr>
                  {archivedHeaders.map(({ key: sortKey, label }) => (
                    <th key={sortKey} className="whitespace-nowrap px-3 py-2 font-medium">
                      <SortableHeader
                        label={label}
                        sortKey={sortKey}
                        activeSort={archivedSort}
                        onSort={toggleArchivedSort}
                        sortLabel={t('settingsPage.users.sort')}
                        ascendingLabel={t('settingsPage.users.ascending')}
                        descendingLabel={t('settingsPage.users.descending')}
                      />
                    </th>
                  ))}
                  <th className="whitespace-nowrap px-3 py-2 font-medium">{t('settingsPage.users.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pagedArchivedUsers.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                      {t('settingsPage.users.noMatchingUsers')}
                    </td>
                  </tr>
                ) : pagedArchivedUsers.flatMap((target) => {
                  const pending = confirm?.kind === 'restore' && confirm.id === target.id;
                  const rows = [
                    <tr key={target.id}>
                      <UsernameCell
                        username={target.username}
                        archived
                        archivedLabel={t('settingsPage.users.archivedTag')}
                      />
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {target.role === 'admin'
                          ? t('settingsPage.users.roleAdmin')
                          : t('settingsPage.users.roleUser')}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatDate(target.archivedAt)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatDate(target.expiresAt)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatBytes(target.archivedBytes)}</td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={busy}
                          onClick={() => setConfirm({ kind: 'restore', id: target.id })}
                        >
                          {t('settingsPage.users.restore')}
                        </button>
                      </td>
                    </tr>,
                  ];
                  if (pending) {
                    rows.push(
                      <tr key={`${target.id}-restore-confirm`} className="bg-muted/40">
                        <td colSpan={6} className="px-3 py-3">
                          <div className="flex flex-wrap items-center gap-3">
                            <p className="min-w-0 flex-1 text-sm text-foreground">
                              {t('settingsPage.users.restoreHint')}
                            </p>
                            <button
                              type="button"
                              className={primaryButtonClass}
                              disabled={busy}
                              onClick={() => void handleConfirm()}
                            >
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
          {sortedArchivedUsers.length > 0 ? (
            <div className="flex items-center justify-between gap-3 px-1 py-3 text-sm text-muted-foreground">
              <span>
                {t('settingsPage.users.pageOf', { page: currentArchivedPage, pages: archivedPageCount })}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={currentArchivedPage <= 1}
                  aria-label={t('settingsPage.users.previousPage')}
                  onClick={() => setArchivedPage((value) => Math.max(1, value - 1))}
                >
                  {t('settingsPage.users.previousPage')}
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={currentArchivedPage >= archivedPageCount}
                  aria-label={t('settingsPage.users.nextPage')}
                  onClick={() => setArchivedPage((value) => Math.min(archivedPageCount, value + 1))}
                >
                  {t('settingsPage.users.nextPage')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

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
