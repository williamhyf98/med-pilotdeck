import { useCallback, useEffect, useState } from 'react';
import { BookOpenCheck, Loader2, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { authenticatedFetch } from '../../../utils/api';
import { cn } from '../../../lib/utils.js';

type Capability = {
  available?: boolean;
  adapter?: string;
  reason?: string;
};

type HealthPayload = {
  status?: string;
  generation?: { status?: string; gateway?: string };
  sidecar?: { configured?: boolean; available?: boolean; status?: string; reason?: string };
  capabilities?: Record<string, Capability>;
};

type Corpus = {
  id: string;
  name: string;
  description?: string;
  ready?: boolean;
  reason?: string;
};

export default function MedicalSystemPanel() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [corpora, setCorpora] = useState<Corpus[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [healthResponse, corporaResponse] = await Promise.all([
        authenticatedFetch('/api/medical/health', { suppressServerErrorToast: true }),
        authenticatedFetch('/api/medical/rag/corpora', { suppressServerErrorToast: true }),
      ]);
      const healthBody = await healthResponse.json();
      const corporaBody = await corporaResponse.json();
      if (!healthResponse.ok) throw new Error(healthBody?.error?.message || '医疗服务状态不可用。');
      setHealth(healthBody);
      setCorpora(corporaResponse.ok && Array.isArray(corporaBody?.corpora) ? corporaBody.corpora : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '医疗服务状态不可用。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading && !health) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-background py-10 text-[12px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在检查医疗能力
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="mr-auto">
          <h3 className="text-[12px] font-semibold">医疗运行状态</h3>
          <p className="text-[10px] text-muted-foreground">Gateway、sidecar 与知识库的真实可用性</p>
        </div>
        <Button variant="outline" size="sm" className="h-8 text-[11px]" onClick={() => void refresh()}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          刷新
        </Button>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/[0.06] px-3 py-2 text-[11px] text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <StatusCard
          icon={Server}
          title="PilotDeck Gateway"
          available={health?.capabilities?.dialogue?.available === true}
          description={health?.generation?.gateway || 'PilotDeck'}
        />
        <StatusCard
          icon={ShieldCheck}
          title="Medical Sidecar"
          available={health?.sidecar?.available === true}
          description={health?.sidecar?.available
            ? 'localhost-only capability API'
            : health?.sidecar?.reason || 'unavailable'}
        />
      </div>

      <div className="rounded-xl border border-border bg-background p-3">
        <h3 className="flex items-center gap-2 text-[12px] font-semibold">
          <BookOpenCheck className="h-4 w-4 text-cyan-600" />
          医疗知识库
        </h3>
        <div className="mt-3 space-y-2">
          {corpora.length > 0 ? corpora.map((corpus) => (
            <div key={corpus.id} className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
              <span className={cn(
                'mt-1 h-2 w-2 shrink-0 rounded-full',
                corpus.ready ? 'bg-emerald-500' : 'bg-amber-500',
              )}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-medium">{corpus.name}</div>
                <div className="mt-0.5 text-[9px] leading-4 text-muted-foreground">
                  {corpus.description || corpus.reason || corpus.id}
                </div>
              </div>
              <span className="text-[9px] text-muted-foreground">
                {corpus.ready ? '可用' : '未配置'}
              </span>
            </div>
          )) : (
            <p className="text-[10px] text-muted-foreground">未发现已发布的医学语料。</p>
          )}
        </div>
      </div>

      <p className="text-[10px] leading-4 text-muted-foreground">
        M3D、真实 RAG、DICOM/WFDB 解析和对象存储未配置时应保持不可用状态，不以演示数据代替生产能力。
      </p>
    </div>
  );
}

function StatusCard({
  icon: Icon,
  title,
  available,
  description,
}: {
  icon: typeof Server;
  title: string;
  available: boolean;
  description: string;
}) {
  return (
    <article className="rounded-xl border border-border bg-background p-3">
      <div className="flex items-center gap-2">
        <span className={cn(
          'flex h-8 w-8 items-center justify-center rounded-lg',
          available
            ? 'bg-emerald-500/10 text-emerald-600'
            : 'bg-amber-500/10 text-amber-600',
        )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <div className="text-[11px] font-semibold">{title}</div>
          <div className="text-[9px] text-muted-foreground">{description}</div>
        </div>
      </div>
    </article>
  );
}
