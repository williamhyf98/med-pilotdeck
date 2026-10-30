import { X } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { getDocumentReferenceFileMeta } from './DocumentReferenceChip';

type MentionedFileChipProps = {
  name: string;
  className?: string;
  removeLabel?: string;
  onRemove?: () => void;
};

export default function MentionedFileChip({
  name,
  className,
  removeLabel,
  onRemove,
}: MentionedFileChipProps) {
  const meta = getDocumentReferenceFileMeta(name);
  const FileIcon = meta.Icon;

  return (
    <div
      className={cn(
        'flex h-8 min-w-0 max-w-full items-center rounded-lg bg-neutral-100 text-left text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300',
        className,
      )}
      title={name}
    >
      <span className="flex h-full min-w-0 flex-1 items-center gap-2 px-2.5">
        <span
          className={cn(
            'flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[10px] font-semibold leading-none',
            meta.className,
          )}
        >
          <FileIcon className="h-3 w-3" strokeWidth={2} />
          {meta.label}
        </span>
        <span className="min-w-0 flex-1 truncate whitespace-nowrap text-[13px] leading-5">
          {name}
        </span>
      </span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="mr-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-neutral-400 transition hover:bg-neutral-200 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          title={removeLabel}
          aria-label={removeLabel}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}
