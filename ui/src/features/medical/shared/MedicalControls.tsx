import {
  Check,
  ChevronDown,
  CircleAlert,
  X,
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/utils.js';
import ImagingWorkbench from '../imaging/ImagingWorkbench';
import TableWorkbench from '../table/TableWorkbench';
import { MEDICAL_CAPABILITY_META, MEDICAL_SAFETY_NOTE } from './constants';
import MedicalSystemPanel from './MedicalSystemPanel';
import type { MedicalCapabilityId, MedicalModelOption } from './types';

export function MedicalModelSelect({
  value,
  options,
  disabled,
  compact = false,
  onChange,
}: {
  value: string;
  options: MedicalModelOption[];
  disabled?: boolean;
  compact?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label
      className={cn(
        'relative flex items-center rounded-lg border border-border bg-background shadow-sm',
        compact ? 'h-8 min-w-36' : 'h-9 min-w-44',
      )}
    >
      <span className="sr-only">选择模型</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'h-full w-full appearance-none rounded-lg bg-transparent pl-3 pr-8 text-foreground outline-none focus:ring-1 focus:ring-ring disabled:opacity-60',
          compact ? 'text-[12px]' : 'text-[13px]',
        )}
      >
        {options.map((option) => (
          <option key={option.value || 'pilotdeck-route'} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-muted-foreground"
      />
    </label>
  );
}

export function MedicalToggle({
  checked,
  label,
  description,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  label: string;
  description?: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={description}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex h-8 items-center gap-2 rounded-lg border px-2.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        checked
          ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300'
          : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <span
        className={cn(
          'relative h-4 w-7 rounded-full transition-colors',
          checked ? 'bg-cyan-600 dark:bg-cyan-500' : 'bg-neutral-300 dark:bg-neutral-700',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform',
            checked ? 'translate-x-3.5' : 'translate-x-0.5',
          )}
        />
      </span>
      {label}
    </button>
  );
}

export function MedicalSafetyNote({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] leading-4 text-amber-800 dark:text-amber-200',
        className,
      )}
    >
      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{MEDICAL_SAFETY_NOTE}</span>
    </div>
  );
}

export function MedicalCapabilityDrawer({
  capability,
  onClose,
  onUseTableMode,
}: {
  capability: MedicalCapabilityId | null;
  onClose: () => void;
  onUseTableMode?: () => void;
}) {
  if (!capability) return null;

  const meta = MEDICAL_CAPABILITY_META[capability];
  const Icon = meta.icon;

  return (
    <div className="absolute inset-0 z-50 flex justify-end bg-black/20 backdrop-blur-[1px]">
      <button
        type="button"
        aria-label="关闭医疗能力面板"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <aside
        className={cn(
          'relative flex h-full w-full flex-col border-l border-border bg-card text-card-foreground shadow-2xl',
          capability === 'table' ? 'max-w-5xl' : 'max-w-4xl',
        )}
      >
        <header className="flex h-14 items-center gap-3 border-b border-border px-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
            <Icon className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">{meta.title}</h2>
            <p className="truncate text-[11px] text-muted-foreground">{meta.description}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭">
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          <div className="rounded-xl border border-dashed border-border bg-muted/30 p-5">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
                <Check className="h-3 w-3" />
              </span>
              原生入口已接入 PilotDeck
            </div>
            <p className="mt-3 text-[12px] leading-5 text-muted-foreground">
              具体解析、预览与导出能力由医疗 sidecar 报告。服务未配置时，界面不会伪造处理成功。
            </p>
          </div>

          <div className="mt-5">
            {capability === 'status' ? (
              <MedicalSystemPanel />
            ) : capability === 'table' ? (
              <TableWorkbench onUseTableMode={onUseTableMode} />
            ) : (
              <ImagingWorkbench />
            )}
          </div>
        </div>

        <footer className="border-t border-border p-4">
          <Button variant="outline" className="w-full" onClick={onClose}>
            返回医疗对话
          </Button>
        </footer>
      </aside>
    </div>
  );
}
