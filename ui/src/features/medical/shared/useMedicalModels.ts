import { useCallback, useEffect, useMemo, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { MEDICAL_MODEL_STORAGE_KEY } from './constants';
import type { MedicalModelOption } from './types';

type MedicalModelsPayload = {
  defaultModel?: unknown;
  models?: unknown;
};

const ROUTED_MODEL_OPTION: MedicalModelOption = {
  value: '',
  label: '跟随 PilotDeck 默认路由',
};

function normalizeOptions(value: unknown): MedicalModelOption[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const item = candidate as {
      id?: unknown;
      value?: unknown;
      displayName?: unknown;
      label?: unknown;
    };
    const rawValue = item.id ?? item.value;
    const rawLabel = item.displayName ?? item.label;
    const modelValue = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!modelValue || seen.has(modelValue)) return [];
    seen.add(modelValue);
    return [{
      value: modelValue,
      label: typeof rawLabel === 'string' && rawLabel.trim()
        ? rawLabel.trim()
        : modelValue,
    }];
  });
}

function readStoredModel(): string {
  try {
    return localStorage.getItem(MEDICAL_MODEL_STORAGE_KEY)?.trim() || '';
  } catch {
    return '';
  }
}

export function useMedicalModels() {
  const [options, setOptions] = useState<MedicalModelOption[]>([ROUTED_MODEL_OPTION]);
  const [selectedModel, setSelectedModelState] = useState(readStoredModel);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    authenticatedFetch('/api/medical/models', { suppressServerErrorToast: true })
      .then((response: Response) => response.json())
      .then((payload: MedicalModelsPayload) => {
        if (cancelled) return;

        const runtimeOptions = normalizeOptions(payload?.models);
        const defaultModel =
          typeof payload?.defaultModel === 'string'
            ? payload.defaultModel.trim()
            : '';
        const storedModel = readStoredModel();
        const nextOptions = [ROUTED_MODEL_OPTION, ...runtimeOptions];
        if (defaultModel && !runtimeOptions.some((option) => option.value === defaultModel)) {
          nextOptions.push({ value: defaultModel, label: defaultModel });
        }
        if (storedModel && !nextOptions.some((option) => option.value === storedModel)) {
          try {
            localStorage.removeItem(MEDICAL_MODEL_STORAGE_KEY);
          } catch {
            // The in-memory default remains usable when storage is unavailable.
          }
        }
        setOptions(nextOptions);
        setSelectedModelState(
          storedModel && nextOptions.some((option) => option.value === storedModel)
            ? storedModel
            : '',
        );
      })
      .catch(() => {
        const storedModel = readStoredModel();
        if (cancelled || !storedModel) return;
        setOptions([
          ROUTED_MODEL_OPTION,
          { value: storedModel, label: storedModel },
        ]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const setSelectedModel = useCallback((model: string) => {
    setSelectedModelState(model);
    try {
      if (model) {
        localStorage.setItem(MEDICAL_MODEL_STORAGE_KEY, model);
      } else {
        localStorage.removeItem(MEDICAL_MODEL_STORAGE_KEY);
      }
    } catch {
      // The in-memory choice remains usable when storage is unavailable.
    }
  }, []);

  const selectedLabel = useMemo(
    () => options.find((option) => option.value === selectedModel)?.label || selectedModel,
    [options, selectedModel],
  );

  return {
    options,
    selectedModel,
    selectedLabel,
    setSelectedModel,
    isLoading,
  };
}
