import ChatWelcomeV2 from '../../../chat-v2/ChatWelcomeV2';
import { useTranslation } from 'react-i18next';
import type { MainContentStateViewProps } from '../../types/types';

export default function MainContentStateView({
  mode,
  workspaceType = 'general_medicine',
  onCreateProject,
}: MainContentStateViewProps) {
  const { t } = useTranslation();

  const isLoading = mode === 'loading';

  return (
    <div className="workspace-chat-surface flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-b-2 border-muted-foreground" />
            <span>{t('mainContent.loading', { defaultValue: 'Loading…' })}</span>
          </div>
        </div>
      ) : (
        <ChatWelcomeV2
          selectedProject={null}
          welcomeTitle={workspaceType === 'war_trauma' ? '战创伤医学智能助手' : undefined}
          composerSlot={null}
          onCreateProject={onCreateProject}
        />
      )}
    </div>
  );
}
