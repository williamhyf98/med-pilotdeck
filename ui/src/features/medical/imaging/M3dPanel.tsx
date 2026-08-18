import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  Loader2,
  Play,
  RefreshCw,
  ServerOff,
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Textarea } from '../../../components/ui/textarea';
import { cn } from '../../../lib/utils.js';
import {
  getM3dHealth,
  inferM3d,
  isUnavailableError,
} from './imagingApi';
import type { M3dHealth, M3dInference } from './imagingApi';

export default function M3dPanel({
  selectedVolumeId,
}: {
  selectedVolumeId?: string | null;
}) {
  const [health, setHealth] = useState<M3dHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthError, setHealthError] = useState('');
  const [unavailableReason, setUnavailableReason] = useState('');
  const [task, setTask] = useState('segment');
  const [prompt, setPrompt] = useState('');
  const [inputText, setInputText] = useState('{}');
  const [running, setRunning] = useState(false);
  const [inference, setInference] = useState<M3dInference | null>(null);
  const [inferenceError, setInferenceError] = useState('');

  const refreshHealth = useCallback(async (signal?: AbortSignal) => {
    setHealthLoading(true);
    setHealthError('');
    setUnavailableReason('');
    try {
      const next = await getM3dHealth(signal);
      setHealth(next);
      if (!next.available) setUnavailableReason(next.reason || 'm3d_unavailable');
    } catch (cause) {
      if (!signal?.aborted) {
        setHealth(null);
        if (isUnavailableError(cause)) {
          setUnavailableReason(cause.reason || cause.message);
        } else {
          setHealthError(errorMessage(cause, 'M3D 状态加载失败。'));
        }
      }
    } finally {
      if (!signal?.aborted) setHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshHealth(controller.signal);
    return () => controller.abort();
  }, [refreshHealth]);

  const runInference = async () => {
    if (!task.trim()) {
      setInferenceError('请输入 M3D task 标识。');
      return;
    }
    let input: Record<string, unknown>;
    try {
      const parsed = JSON.parse(inputText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('input must be an object');
      }
      input = parsed as Record<string, unknown>;
    } catch {
      setInferenceError('M3D input 必须是有效的 JSON 对象。');
      return;
    }
    if (prompt.trim()) input = { ...input, prompt: prompt.trim() };

    setRunning(true);
    setInferenceError('');
    setInference(null);
    try {
      setInference(await inferM3d(task.trim(), input));
    } catch (cause) {
      setInferenceError(errorMessage(cause, 'M3D 推理失败。'));
    } finally {
      setRunning(false);
    }
  };

  const useSelectedVolume = () => {
    if (!selectedVolumeId) return;
    setInputText(JSON.stringify({ volume_id: selectedVolumeId }, null, 2));
  };

  return (
    <div className="space-y-3">
      <article className="rounded-xl border border-border bg-background p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300">
            <BrainCircuit className="h-4 w-4" />
          </span>
          <div className="mr-auto">
            <h3 className="text-[12px] font-semibold">M3D localhost adapter</h3>
            <p className="text-[10px] text-muted-foreground">固定 health / infer 路由 · 不接受客户端 endpoint</p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-[10px]"
            disabled={healthLoading}
            onClick={() => void refreshHealth()}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', healthLoading && 'animate-spin')} />
            重新探活
          </Button>
        </div>

        <div className="mt-3">
          {healthLoading ? (
            <Status tone="loading" icon={<Loader2 className="animate-spin" />}>
              正在请求 /api/medical/m3d/health…
            </Status>
          ) : healthError ? (
            <Status tone="error" icon={<AlertTriangle />}>{healthError}</Status>
          ) : health?.available ? (
            <Status tone="success" icon={<CheckCircle2 />}>
              M3D 可用
              {health.timeoutSeconds ? ` · 后端超时 ${health.timeoutSeconds} 秒` : ''}
            </Status>
          ) : (
            <Status tone="warning" icon={<ServerOff />}>
              M3D unavailable：{humanReason(unavailableReason || health?.reason || 'unknown')}
            </Status>
          )}
        </div>
      </article>

      <article className="rounded-xl border border-border bg-background p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-[10px] font-medium">
            Task
            <Input
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="例如 segment"
              className="mt-1 h-8 font-mono text-[10px]"
              maxLength={64}
            />
          </label>
          <div className="flex items-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-full text-[10px]"
              disabled={!selectedVolumeId}
              onClick={useSelectedVolume}
            >
              使用当前 Volume ID
            </Button>
          </div>
        </div>
        <label className="mt-3 block text-[10px] font-medium">
          Prompt（可选，作为 input.prompt 发送）
          <Textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="描述 M3D 任务目标；不要包含本地路径、秘密或系统提示。"
            className="mt-1 min-h-20 resize-y text-[10px] leading-4"
            maxLength={4_000}
          />
        </label>
        <label className="mt-3 block text-[10px] font-medium">
          Input JSON
          <Textarea
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            className="mt-1 min-h-32 resize-y font-mono text-[10px] leading-4"
            spellCheck={false}
          />
        </label>
        <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
          后端会拒绝本地文件路径，并只转发到部署配置中的固定回环 M3D 服务。此入口不上传模型、不配置 endpoint，也不伪造离线结果。
        </p>
        {inferenceError ? (
          <Status className="mt-3" tone="error" icon={<AlertTriangle />}>
            {inferenceError}
          </Status>
        ) : null}
        <Button
          type="button"
          className="mt-3 w-full"
          disabled={running || !health?.available}
          onClick={() => void runInference()}
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          调用真实 M3D infer
        </Button>
      </article>

      {inference ? (
        <article className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4">
          <div className="flex items-center gap-2 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            后端返回 {inference.contractVersion || '未标注契约版本'} · task={inference.task}
          </div>
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-3 text-[9px] leading-4 text-muted-foreground">
            {JSON.stringify(inference.result, null, 2)}
          </pre>
          <p className="mt-2 text-[9px] text-muted-foreground">
            PHI 持久化：{inference.phiPersisted ? '后端报告已持久化' : '否'}
          </p>
        </article>
      ) : null}
    </div>
  );
}

function Status({
  tone,
  icon,
  className,
  children,
}: {
  tone: 'loading' | 'success' | 'warning' | 'error';
  icon: React.ReactElement;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(
      'flex items-center gap-2 rounded-lg border px-3 py-2 text-[10px] leading-4',
      tone === 'success'
        ? 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-300'
        : tone === 'warning'
          ? 'border-amber-500/20 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300'
          : tone === 'error'
            ? 'border-destructive/20 bg-destructive/[0.06] text-destructive'
            : 'border-border bg-muted/30 text-muted-foreground',
      className,
    )}>
      {icon}
      {children}
    </div>
  );
}

function humanReason(reason: string): string {
  const known: Record<string, string> = {
    feature_disabled: '功能开关未启用',
    service_unavailable: '本地 M3D 服务未启动或不可达',
    timeout: '本地 M3D 服务超时',
    invalid_json_response: 'M3D 服务返回无效 JSON',
    response_too_large: 'M3D 响应超过后端预算',
    not_configured: '医疗 Sidecar 未配置',
    not_supported: '当前 Sidecar 不支持 M3D',
    m3d_unavailable: 'M3D 未就绪',
    unknown: '后端未报告原因',
  };
  return known[reason] || reason;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
