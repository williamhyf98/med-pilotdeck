import { useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  Database,
  Loader2,
  ScanLine,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Textarea } from '../../../components/ui/textarea';
import { cn } from '../../../lib/utils.js';
import {
  validateGalleryMetadata,
  validateVolumeMetadata,
} from './imagingApi';
import type { MetadataValidationResult } from './imagingApi';

const SAMPLE_VOLUME = {
  volume_id: 'synthetic-volume-001',
  filename: 'synthetic-volume.npy',
  extension: '.npy',
  original_shape: [8, 8, 8],
  spacing: [1, 1, 1],
  modality: 'unknown',
  preview_slices: 4,
  thumbnail_index: 2,
  value_range: [0, 100],
  byte_size: 4096,
  sha256: '0'.repeat(64),
};

const SAMPLE_DATASET = {
  dataset_id: 'synthetic-gallery',
  label: '合成测试数据集',
  description: '不包含真实病例，仅用于验证 Gallery metadata 契约。',
  modality: 'CT',
  available: true,
  case_count: 3,
  has_report_text: false,
  version: 'v1',
  license_id: 'synthetic-test-only',
};

const SAMPLE_CASE = {
  dataset_id: 'synthetic-gallery',
  case_id: 'synthetic-case-1',
  slice_count: 16,
  thumbnail_index: 8,
  modality: 'CT',
  report_available: false,
};

export default function ImagingMetadataAdvanced() {
  const [volumeText, setVolumeText] = useState(JSON.stringify(SAMPLE_VOLUME, null, 2));
  const [galleryKind, setGalleryKind] = useState<'dataset' | 'case'>('dataset');
  const [galleryText, setGalleryText] = useState(JSON.stringify(SAMPLE_DATASET, null, 2));
  const [result, setResult] = useState<MetadataValidationResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState<'volume' | 'gallery' | null>(null);

  const validate = async (kind: 'volume' | 'gallery') => {
    setLoading(kind);
    setError('');
    setResult(null);
    try {
      const parsed = JSON.parse(kind === 'volume' ? volumeText : galleryText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('metadata must be an object');
      }
      const next = kind === 'volume'
        ? await validateVolumeMetadata(parsed)
        : await validateGalleryMetadata(galleryKind, parsed);
      setResult(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '影像 metadata 校验失败。');
    } finally {
      setLoading(null);
    }
  };

  const selectGalleryKind = (kind: 'dataset' | 'case') => {
    setGalleryKind(kind);
    setGalleryText(JSON.stringify(kind === 'dataset' ? SAMPLE_DATASET : SAMPLE_CASE, null, 2));
    setResult(null);
    setError('');
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2 text-[10px] leading-4 text-amber-700 dark:text-amber-300">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <AlertTriangle className="h-3.5 w-3.5" />
          高级契约校验
        </span>
        <p className="mt-1">
          下方是明确标注的合成 metadata 模板，只验证预算与字段契约；不会创建 Volume、Gallery 数据集或推理结果。
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <article className="rounded-xl border border-border bg-background p-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
              <ScanLine className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-[12px] font-semibold">Volume metadata</h3>
              <p className="text-[10px] text-muted-foreground">NIfTI / NPY 预算与结构契约</p>
            </div>
          </div>
          <Textarea
            value={volumeText}
            onChange={(event) => setVolumeText(event.target.value)}
            className="mt-3 min-h-64 resize-y font-mono text-[9px] leading-4"
            spellCheck={false}
          />
          <Button
            type="button"
            className="mt-3 w-full"
            disabled={loading !== null}
            onClick={() => void validate('volume')}
          >
            {loading === 'volume'
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <ShieldCheck className="h-4 w-4" />}
            校验 Volume metadata
          </Button>
        </article>

        <article className="rounded-xl border border-border bg-background p-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-700 dark:text-violet-300">
              <Boxes className="h-4 w-4" />
            </span>
            <div className="mr-auto">
              <h3 className="text-[12px] font-semibold">Gallery metadata</h3>
              <p className="text-[10px] text-muted-foreground">数据集或病例契约</p>
            </div>
          </div>
          <div className="mt-3 flex rounded-lg border border-border bg-muted/30 p-1">
            {(['dataset', 'case'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className={cn(
                  'flex-1 rounded px-2 py-1.5 text-[9px]',
                  galleryKind === kind ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground',
                )}
                onClick={() => selectGalleryKind(kind)}
              >
                {kind === 'dataset' ? 'Dataset' : 'Case'}
              </button>
            ))}
          </div>
          <Textarea
            value={galleryText}
            onChange={(event) => setGalleryText(event.target.value)}
            className="mt-3 min-h-52 resize-y font-mono text-[9px] leading-4"
            spellCheck={false}
          />
          <Button
            type="button"
            className="mt-3 w-full"
            variant="outline"
            disabled={loading !== null}
            onClick={() => void validate('gallery')}
          >
            {loading === 'gallery'
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Database className="h-4 w-4" />}
            校验 Gallery {galleryKind}
          </Button>
        </article>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/[0.06] px-3 py-2 text-[10px] text-destructive">
          {error}
        </div>
      ) : null}
      {result ? (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-3">
          <div className="flex items-center gap-2 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
            <ShieldCheck className="h-4 w-4" />
            metadata 已通过真实 sidecar 预算与安全契约校验
          </div>
          <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded bg-background/80 p-2 text-[9px] leading-4 text-muted-foreground">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
