import { useState, useCallback } from 'react';
import { ArrowRight, Languages, AlertTriangle, CheckCircle2, Copy } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { authenticatedFetch } from '../../../utils/api';

type TranslationState = 'idle' | 'loading' | 'done' | 'error';

const LANGUAGES: { id: string; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'zh', label: '中文' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'fr', label: 'Français' },
  { id: 'de', label: 'Deutsch' },
  { id: 'es', label: 'Español' },
];

export default function TranslationPanel() {
  const [sourceText, setSourceText] = useState('');
  const [targetLang, setTargetLang] = useState('en');
  const [state, setState] = useState<TranslationState>('idle');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const translate = useCallback(async () => {
    if (!sourceText.trim()) return;
    setState('loading');
    setError('');
    setResult('');

    try {
      const res = await authenticatedFetch('/api/medical/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: sourceText.trim(),
          targetLanguage: targetLang,
          sourceLanguage: 'zh',
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || `翻译失败 (${res.status})`);
      }

      const data = await res.json() as { translation?: string };
      const translation = typeof data.translation === 'string'
        ? data.translation
        : JSON.stringify(data.translation || data);

      setResult(translation);
      setState('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : '翻译服务不可用');
      setState('error');
    }
  }, [sourceText, targetLang]);

  const copyResult = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may not be available
    }
  }, [result]);

  return (
    <div className="medical-translation-panel" data-testid="medical-translation-panel">
      <header className="mtp-header">
        <Languages className="mtp-header-icon" />
        <h2 className="mtp-title">医学翻译</h2>
        <p className="mtp-subtitle">保留数值、否定、不确定性和医学术语</p>
      </header>

      <div className="mtp-body">
        <label className="mtp-label" htmlFor="mtp-source">
          源文本
        </label>
        <textarea
          id="mtp-source"
          className="mtp-textarea"
          rows={6}
          maxLength={10_000}
          value={sourceText}
          onChange={(e) => setSourceText(e.target.value)}
          placeholder="输入需要翻译的医学文本..."
          disabled={state === 'loading'}
        />

        <div className="mtp-controls">
          <label className="mtp-label" htmlFor="mtp-target-lang">
            目标语言
          </label>
          <select
            id="mtp-target-lang"
            className="mtp-select"
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value)}
            disabled={state === 'loading'}
          >
            {LANGUAGES.map((lang) => (
              <option key={lang.id} value={lang.id}>
                {lang.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="mtp-translate-btn"
            onClick={translate}
            disabled={state === 'loading' || !sourceText.trim()}
          >
            {state === 'loading' ? (
              <>翻译中...</>
            ) : (
              <>
                <ArrowRight /> 翻译
              </>
            )}
          </button>
        </div>

        {state === 'error' && (
          <div className="mtp-error" role="alert">
            <AlertTriangle />
            <span>{error}</span>
          </div>
        )}

        {state === 'done' && (
          <div className="mtp-result">
            <div className="mtp-result-header">
              <CheckCircle2 className="mtp-result-icon" />
              <span>翻译完成</span>
              <button
                type="button"
                className="mtp-copy-btn"
                onClick={copyResult}
                title="复制译文"
              >
                <Copy />
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            <div className="mtp-result-text">{result}</div>
          </div>
        )}
      </div>
    </div>
  );
}
