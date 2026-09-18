import { Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MainContentStateViewProps } from '../../types/types';

export default function MainContentStateView({
  mode,
  onCreateProject,
}: MainContentStateViewProps) {
  const { t } = useTranslation();

  const isLoading = mode === 'loading';

  return (
    <div className="workspace-content-surface flex h-full flex-col text-foreground">
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-b-2 border-muted-foreground" />
            <span>{t('mainContent.loading', { defaultValue: 'Loading…' })}</span>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="mx-auto max-w-[440px] px-6 text-center">
            <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <Folder className="h-4.5 w-4.5 text-muted-foreground" strokeWidth={1.75} />
            </div>
            <h2 className="mb-1 text-[15px] font-medium text-foreground">
              {t('mainContent.chooseProject', { defaultValue: 'Create a project to start' })}
            </h2>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {t('mainContent.selectProjectDescription', {
                defaultValue: 'Choose a project from the sidebar, or create one with a name and type.',
              })}
            </p>
            {onCreateProject ? (
              <button
                type="button"
                onClick={onCreateProject}
                className="mt-5 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-[13px] font-medium text-primary-foreground hover:opacity-90"
              >
                {t('mainContent.createProject', { defaultValue: 'Create project' })}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
