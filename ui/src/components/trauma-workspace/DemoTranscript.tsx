import { useEffect, useMemo, useRef } from 'react';
import { cn } from '../../lib/utils';
import MessageRowV2 from '../chat-v2/MessageRowV2';
import type { ChatMessage } from '../chat/types/types';
import type { RoundMemo } from './types';

type DemoTranscriptProps = {
  rounds: RoundMemo[];
  currentRoundIndex: number;
};

const DEMO_DATE = '2026-09-03';

function buildMessages(rounds: RoundMemo[]): ChatMessage[] {
  return rounds.flatMap((round) => round.messages.flatMap((message, messageIndex) => {
    const baseId = `${round.id}-m${String(messageIndex)}`;
    const timestamp = `${DEMO_DATE}T${round.time}:00+08:00`;
    const rows: ChatMessage[] = [{
      id: baseId,
      entryId: baseId,
      type: message.role,
      content: message.text,
      timestamp,
    }];

    if (message.ask) {
      rows.push({
        id: `${baseId}-ask`,
        entryId: `${baseId}-ask`,
        type: 'assistant',
        content: '',
        timestamp,
        isToolUse: true,
        toolName: 'AskUserQuestion',
        toolId: `${baseId}-ask`,
        toolInput: {
          questions: [{
            header: message.ask.header,
            question: message.ask.question,
            options: message.ask.options,
            multiSelect: false,
          }],
          answers: { [message.ask.question]: message.ask.answer },
        },
      });
    }

    return rows;
  }));
}

export default function DemoTranscript({ rounds, currentRoundIndex }: DemoTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messages = useMemo(
    () => buildMessages(rounds.slice(0, currentRoundIndex + 1)),
    [rounds, currentRoundIndex],
  );

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [currentRoundIndex]);

  return (
    <div
      ref={scrollRef}
      aria-label="演示案例对话"
      className="h-full overflow-y-auto overflow-x-hidden bg-white dark:bg-neutral-950"
    >
      <div className="mx-auto max-w-[860px] px-6 py-10">
        {messages.map((message, index) => (
          <div
            key={message.id}
            className={cn('chat-message', index < messages.length - 1 && 'pb-4')}
          >
            <MessageRowV2
              message={message}
              prevMessage={messages[index - 1] ?? null}
              provider="pilotdeck"
              selectedProject={null}
              createDiff={() => []}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
