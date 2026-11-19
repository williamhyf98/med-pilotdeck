import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage, ChatRunMode } from '../chat/types/types';
import type { Project, SessionProvider } from '../../types/app';
import ChatHistorySearchBar from './ChatHistorySearchBar';
import MessageRowV2, { ProcessEventRows } from './MessageRowV2';
import { ProcessLiveStatus, ProcessRunPanel } from './ProcessTrace';
import { formatProcessDuration } from './processTraceUtils';
import {
  buildRenderableMessageItems,
  getLiveProcessGroups,
  shouldRenderLiveProcessGroup,
  splitLiveProcessGroupDetailMessages,
  type LiveProcessGroup,
  type ProcessAttachment,
  type RenderableMessageItem,
} from './processGrouping';
import { useChatHistorySearch } from './useChatHistorySearch';
import type { SearchableChatMessageInput } from './chatHistorySearchUtils';

type DiffLine = { type: string; content: string; lineNum: number };

interface SubagentDetailMessageFlowProps {
  messages: ChatMessage[];
  provider: SessionProvider;
  selectedProject: Project | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  showThinking?: boolean;
  isRunning?: boolean;
  runMode?: ChatRunMode;
}

type KeyedRenderableMessageItem = RenderableMessageItem & {
  itemKey: string;
  renderIndex: number;
};

function getMessageKey(message: ChatMessage, index: number): string {
  return String(
    message.id ||
      message.toolId ||
      message.activityId ||
      message.runId ||
      `${message.timestamp || 'message'}-${index}`,
  );
}

function processAttachmentOverlapsLiveGroup(
  attachment: ProcessAttachment,
  liveGroups: LiveProcessGroup[],
): boolean {
  return liveGroups.some((group) => (
    attachment.startIndex <= group.endIndex && attachment.endIndex >= group.startIndex
  ));
}

function removeLiveOverlappingProcessAttachments(
  item: RenderableMessageItem,
  liveGroups: LiveProcessGroup[],
): RenderableMessageItem {
  if (liveGroups.length === 0) return item;

  return {
    ...item,
    beforeProcessAttachments: item.beforeProcessAttachments.filter(
      (attachment) => !processAttachmentOverlapsLiveGroup(attachment, liveGroups),
    ),
    afterProcessAttachments: item.afterProcessAttachments.filter(
      (attachment) => !processAttachmentOverlapsLiveGroup(attachment, liveGroups),
    ),
  };
}

export default function SubagentDetailMessageFlow({
  messages,
  provider,
  selectedProject,
  createDiff,
  onFileOpen,
  showThinking = true,
  isRunning = false,
  runMode = 'agent',
}: SubagentDetailMessageFlowProps) {
  const { t } = useTranslation('chat');
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [expandedProcessRows, setExpandedProcessRows] = useState<Map<string, boolean>>(() => new Map());

  const renderableMessages = useMemo(
    () => {
      const result = messages
        .filter((message) =>
          !message.isAgentActivity &&
          !(message.isThinking && !showThinking)
        )
        .map((message) => message.isSubagentContainer
          ? { ...message, isSubagentContainer: false }
          : message
        );
      return result;
    },
    [messages, showThinking],
  );
  const baseRenderableItems = useMemo(
    () => buildRenderableMessageItems(renderableMessages, { isAssistantWorking: true })
      .filter((item) => !item.message.isAgentActivitySummary),
    [renderableMessages],
  );
  const liveProcessGroups = useMemo(
    () => getLiveProcessGroups(renderableMessages, { isAssistantWorking: true })
        .filter((group) => shouldRenderLiveProcessGroup(group, runMode))
        .map((group) => isRunning ? group : { ...group, isRunning: false }),
    [isRunning, renderableMessages, runMode],
  );
  const renderableItems = useMemo(
    () => baseRenderableItems.map((item) => removeLiveOverlappingProcessAttachments(item, liveProcessGroups)),
    [baseRenderableItems, liveProcessGroups],
  );
  const keyedItems = useMemo<KeyedRenderableMessageItem[]>(
    () => renderableItems.map((item, index) => ({
      ...item,
      itemKey: getMessageKey(item.message, index),
      renderIndex: index,
    })),
    [renderableItems],
  );
  const visibleOriginalIndices = useMemo(
    () => new Set(keyedItems.map((item) => item.originalIndex)),
    [keyedItems],
  );
  const liveProcessGroupsByAnchor = useMemo(() => {
    const groupsByAnchor = new Map<number, LiveProcessGroup[]>();
    for (const group of liveProcessGroups) {
      const groups = groupsByAnchor.get(group.afterOriginalIndex) || [];
      groups.push(group);
      groupsByAnchor.set(group.afterOriginalIndex, groups);
    }
    return groupsByAnchor;
  }, [liveProcessGroups]);
  const unanchoredLiveProcessGroups = useMemo(
    () => liveProcessGroups.filter((group) => !visibleOriginalIndices.has(group.afterOriginalIndex)),
    [liveProcessGroups, visibleOriginalIndices],
  );
  const unanchoredLiveProcessGroupsByBeforeIndex = useMemo(() => {
    const groupsByBeforeIndex = new Map<number, LiveProcessGroup[]>();
    for (const group of unanchoredLiveProcessGroups) {
      if (group.beforeOriginalIndex == null) continue;
      const insertionItem = keyedItems.find((item) => item.originalIndex >= group.beforeOriginalIndex!);
      if (!insertionItem) continue;
      const groups = groupsByBeforeIndex.get(insertionItem.originalIndex) || [];
      groups.push(group);
      groupsByBeforeIndex.set(insertionItem.originalIndex, groups);
    }
    return groupsByBeforeIndex;
  }, [keyedItems, unanchoredLiveProcessGroups]);
  const bottomUnanchoredLiveProcessGroups = useMemo(
    () => unanchoredLiveProcessGroups.filter((group) => {
      if (group.beforeOriginalIndex == null) return true;
      return !keyedItems.some((item) => item.originalIndex >= group.beforeOriginalIndex!);
    }),
    [keyedItems, unanchoredLiveProcessGroups],
  );
  const hasOpenEndedLiveProcessGroup = liveProcessGroups.some((group) => group.isRunning);
  const shouldRenderBottomLiveStatus = isRunning && !hasOpenEndedLiveProcessGroup;
  const keyedMessagesForSearch = useMemo<SearchableChatMessageInput[]>(() => {
    return keyedItems.map((item) => (
      {
        message: item.message,
        messageKey: item.itemKey,
        messageIndex: item.renderIndex,
      }
    ));
  }, [keyedItems]);
  const measuredItemHeights = useMemo(
    () => keyedItems.map(() => 96),
    [keyedItems],
  );

  const isProcessExpanded = useCallback((processKey: string, defaultExpanded = false) => (
    expandedProcessRows.get(processKey) ?? defaultExpanded
  ), [expandedProcessRows]);

  const loadAllSearchMessages = useCallback(() => {}, []);
  const handleProcessExpandedChange = useCallback((processKey: string, expanded: boolean) => {
    setExpandedProcessRows((prev) => {
      const next = new Map(prev);
      next.set(processKey, expanded);
      return next;
    });
  }, []);

  const chatHistorySearch = useChatHistorySearch({
    scrollContainerRef,
    keyedMessages: keyedMessagesForSearch,
    measuredItemHeights,
    allMessagesLoaded: true,
    hasMoreMessages: false,
    loadAllMessages: loadAllSearchMessages,
    sessionId: null,
    captureFindShortcutInModal: true,
  });

  const renderLiveProcessGroup = useCallback((group: LiveProcessGroup, index: number) => {
    const { statusDetailMessages } = splitLiveProcessGroupDetailMessages(group);
    const panelKey = `${group.id}:panel:live`;
    const expanded = isProcessExpanded(panelKey, isRunning);
    const label = t('process.summary.turnProcessed', {
      duration: formatProcessDuration(group.durationMs),
      defaultValue: `Turn process: ${formatProcessDuration(group.durationMs)}`,
    });
    return (
      <Fragment key={group.id || `${group.afterOriginalIndex}-${index}`}>
        {statusDetailMessages.length > 0 ? (
          <ProcessRunPanel
            label={label}
            defaultExpanded={isRunning}
            expanded={expanded}
            onExpandedChange={(nextExpanded) => handleProcessExpandedChange(panelKey, nextExpanded)}
          >
            <ProcessEventRows
              messages={statusDetailMessages}
              processKey={group.id}
              selectedProject={selectedProject}
              onFileOpen={onFileOpen}
              isProcessExpanded={isProcessExpanded}
              onProcessExpandedChange={handleProcessExpandedChange}
              defaultExpanded={false}
            />
          </ProcessRunPanel>
        ) : null}
      </Fragment>
    );
  }, [
    handleProcessExpandedChange,
    isProcessExpanded,
    isRunning,
    onFileOpen,
    selectedProject,
    t,
  ]);

  if (
    keyedItems.length === 0 &&
    bottomUnanchoredLiveProcessGroups.length === 0 &&
    unanchoredLiveProcessGroupsByBeforeIndex.size === 0 &&
    !shouldRenderBottomLiveStatus
  ) {
    return null;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {chatHistorySearch.isOpen ? (
        <ChatHistorySearchBar
          query={chatHistorySearch.query}
          onQueryChange={chatHistorySearch.setQuery}
          matchCount={chatHistorySearch.matches.length}
          activeMatchIndex={chatHistorySearch.activeMatchIndex}
          onPrevious={chatHistorySearch.goToPrevious}
          onNext={chatHistorySearch.goToNext}
          onClose={chatHistorySearch.closeSearch}
          inputRef={chatHistorySearch.inputRef}
        />
      ) : null}
      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-w-0 flex-col gap-3 px-6 py-4">
          {keyedItems.map((item) => {
            const previousMessage = item.renderIndex > 0 ? keyedItems[item.renderIndex - 1].message : null;
            const nextMessage = item.renderIndex < keyedItems.length - 1
              ? keyedItems[item.renderIndex + 1].message
              : null;
            const anchoredLiveGroups = liveProcessGroupsByAnchor.get(item.originalIndex) || [];
            const beforeLiveGroups = unanchoredLiveProcessGroupsByBeforeIndex.get(item.originalIndex) || [];

            return (
              <Fragment key={item.itemKey}>
                {beforeLiveGroups.length > 0 ? (
                  <div className="flex min-w-0 flex-col gap-2">
                    {beforeLiveGroups.map(renderLiveProcessGroup)}
                  </div>
                ) : null}
                <div
                  className="chat-message"
                  data-message-key={item.itemKey}
                  data-message-timestamp={item.message.timestamp ? String(item.message.timestamp) : undefined}
                >
                  <MessageRowV2
                    message={item.message}
                    prevMessage={previousMessage}
                    nextMessage={nextMessage}
                    beforeProcessAttachments={item.beforeProcessAttachments}
                    afterProcessAttachments={item.afterProcessAttachments}
                    provider={provider}
                    selectedProject={selectedProject}
                    createDiff={createDiff}
                    onFileOpen={onFileOpen}
                    showThinking={showThinking}
                    isProcessExpanded={isProcessExpanded}
                    onProcessExpandedChange={handleProcessExpandedChange}
                  />
                </div>
                {anchoredLiveGroups.length > 0 ? (
                  <div className="flex min-w-0 flex-col gap-2">
                    {anchoredLiveGroups.map(renderLiveProcessGroup)}
                  </div>
                ) : null}
              </Fragment>
            );
          })}
          {bottomUnanchoredLiveProcessGroups.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-2">
              {bottomUnanchoredLiveProcessGroups.map(renderLiveProcessGroup)}
            </div>
          ) : null}
          {shouldRenderBottomLiveStatus ? (
            <ProcessLiveStatus
              step={{
                id: 'subagent-waiting',
                title: t('subagent.status.thinking', { defaultValue: 'Thinking' }),
                phase: 'thinking',
                state: 'running',
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
