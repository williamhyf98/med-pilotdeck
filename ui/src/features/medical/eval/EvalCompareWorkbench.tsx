import { useEffect, useState, useCallback } from 'react';
import { BarChart3, AlertTriangle, CheckCircle2, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { authenticatedFetch } from '../../../utils/api';

type EvalCase = {
  id: string;
  title: string;
  modality: string;
  referenceAnswer?: string;
  candidateAnswers?: { model: string; text: string; score?: number }[];
};

type EvalState = 'idle' | 'loading' | 'loaded' | 'error';

export default function EvalCompareWorkbench() {
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [state, setState] = useState<EvalState>('idle');
  const [error, setError] = useState('');
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [rerunEnabled, setRerunEnabled] = useState(false);

  useEffect(() => {
    loadCases();
    checkRerunFlag();
  }, []);

  const loadCases = useCallback(async () => {
    setState('loading');
    setError('');
    try {
      const res = await authenticatedFetch('/api/medical/eval/cases');
      if (!res.ok) throw new Error(`加载失败 (${res.status})`);
      const data = await res.json() as { cases?: EvalCase[] };
      setCases(data.cases || []);
      setState('loaded');
    } catch (err) {
      setError(err instanceof Error ? err.message : '评测数据不可用');
      setState('error');
    }
  }, []);

  const checkRerunFlag = useCallback(async () => {
    try {
      const res = await authenticatedFetch('/api/medical/health');
      const health = await res.json() as Record<string, unknown>;
      const caps = health.capabilities as Record<string, { available?: boolean }> | undefined;
      setRerunEnabled(caps?.legacyEvalRerun?.available === true);
    } catch {
      setRerunEnabled(false);
    }
  }, []);

  const selectedCase = cases.find((c) => c.id === selectedCaseId) || null;

  return (
    <div className="medical-eval-workbench" data-testid="medical-eval-workbench">
      <header className="mew-header">
        <BarChart3 className="mew-header-icon" />
        <div>
          <h2 className="mew-title">历史静态评测</h2>
          <p className="mew-subtitle">
            只读展示历史静态评测与多模型输出对比，不进入生产诊断流程
          </p>
        </div>
        {rerunEnabled && (
          <span className="mew-rerun-badge">
            <RotateCcw className="mew-rerun-icon" />
            重跑可用
          </span>
        )}
      </header>

      <div className="mew-body">
        {state === 'loading' && (
          <div className="mew-loading">
            <Loader2 className="animate-spin" />
            <span>加载评测案例...</span>
          </div>
        )}

        {state === 'error' && (
          <div className="mew-error" role="alert">
            <XCircle />
            <span>{error}</span>
          </div>
        )}

        {state === 'loaded' && cases.length === 0 && (
          <div className="mew-empty">
            <AlertTriangle />
            <span>暂无可用评测案例。请确认 demo 数据已部署且 sidecar 可访问。</span>
          </div>
        )}

        {state === 'loaded' && cases.length > 0 && (
          <>
            <aside className="mew-case-list">
              <h3 className="mew-list-title">评测案例 ({cases.length})</h3>
              {cases.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={cn('mew-case-item', selectedCaseId === c.id && 'mew-case-item-active')}
                  onClick={() => setSelectedCaseId(c.id)}
                >
                  <span className="mew-case-title">{c.title || c.id}</span>
                  <span className="mew-case-modality">{c.modality || '未知模态'}</span>
                </button>
              ))}
            </aside>

            <main className="mew-detail">
              {!selectedCase ? (
                <div className="mew-select-prompt">← 选择左侧案例查看评测详情</div>
              ) : (
                <>
                  <h3 className="mew-detail-title">
                    {selectedCase.title || selectedCase.id}
                  </h3>
                  {selectedCase.referenceAnswer && (
                    <section className="mew-section">
                      <h4 className="mew-section-title">
                        <CheckCircle2 /> 参考答案
                      </h4>
                      <pre className="mew-section-text">
                        {selectedCase.referenceAnswer}
                      </pre>
                    </section>
                  )}
                  {selectedCase.candidateAnswers && selectedCase.candidateAnswers.length > 0 && (
                    <section className="mew-section">
                      <h4 className="mew-section-title">
                        候选输出对比 ({selectedCase.candidateAnswers.length})
                      </h4>
                      {selectedCase.candidateAnswers.map((ans, idx) => (
                        <div key={idx} className="mew-candidate">
                          <div className="mew-candidate-header">
                            <span className="mew-model-tag">{ans.model}</span>
                            {ans.score !== undefined && (
                              <span className={cn(
                                'mew-score',
                                ans.score >= 0.7 ? 'mew-score-high' : 'mew-score-low',
                              )}>
                                评分: {ans.score.toFixed(2)}
                              </span>
                            )}
                          </div>
                          <pre className="mew-section-text">{ans.text}</pre>
                        </div>
                      ))}
                    </section>
                  )}
                  <p className="mew-disclaimer">
                    ⚠️ 以上为历史静态评测结果，不进入生产临床工作流。
                    重跑需管理员启用 PILOTDECK_MEDICAL_ENABLE_LEGACY_EVAL 标志。
                  </p>
                </>
              )}
            </main>
          </>
        )}
      </div>
    </div>
  );
}
