import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { Check, RotateCcw, Save } from "lucide-react";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import { cn } from "../../../../lib/utils";
import {
  ConfigSaveError,
  SettingsCard,
  SettingsSection,
} from "../../shared/view";
import { useUsersAdmin } from "../users/useUsersAdmin";
import type { PilotDeckConfig } from "../modelPool/types";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";

const GiB = 1024 ** 3;
const DEFAULT_QUOTA = {
  workspaceWarnBytes: 5 * GiB,
  inboxWarnBytes: 0,
  scratchMaxBytes: 1 * GiB,
  scratchSoftRatio: 0.8,
  scratchTtlDays: 7,
  protectRecentMinutes: 10,
  cleanOnTurnEnd: true,
  userTotalMaxBytes: 20 * GiB,
  imagingScratchMaxBytes: 2 * GiB,
};

type QuotaDraft = typeof DEFAULT_QUOTA;

function numberOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readQuota(config: PilotDeckConfig): QuotaDraft {
  const quota = config.workspace?.quota;
  return {
    workspaceWarnBytes: numberOrFallback(
      quota?.workspaceWarnBytes,
      DEFAULT_QUOTA.workspaceWarnBytes,
    ),
    inboxWarnBytes: numberOrFallback(
      quota?.inboxWarnBytes,
      DEFAULT_QUOTA.inboxWarnBytes,
    ),
    scratchMaxBytes: numberOrFallback(
      quota?.scratchMaxBytes,
      DEFAULT_QUOTA.scratchMaxBytes,
    ),
    scratchSoftRatio: numberOrFallback(
      quota?.scratchSoftRatio,
      DEFAULT_QUOTA.scratchSoftRatio,
    ),
    scratchTtlDays: numberOrFallback(
      quota?.scratchTtlDays,
      DEFAULT_QUOTA.scratchTtlDays,
    ),
    protectRecentMinutes: numberOrFallback(
      quota?.protectRecentMinutes,
      DEFAULT_QUOTA.protectRecentMinutes,
    ),
    cleanOnTurnEnd:
      typeof quota?.cleanOnTurnEnd === "boolean"
        ? quota.cleanOnTurnEnd
        : DEFAULT_QUOTA.cleanOnTurnEnd,
    userTotalMaxBytes: numberOrFallback(
      quota?.userTotalMaxBytes,
      DEFAULT_QUOTA.userTotalMaxBytes,
    ),
    imagingScratchMaxBytes: numberOrFallback(
      quota?.overrides?.imaging?.scratchMaxBytes,
      DEFAULT_QUOTA.imagingScratchMaxBytes,
    ),
  };
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  );
  const scaled = value / 1024 ** index;
  return `${scaled >= 100 || index === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
}

function toGiB(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return String(Number((value / GiB).toFixed(2)));
}

function fromGiB(value: string, allowZero = false): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) return null;
  return parsed * GiB;
}

function NumberField({
  value,
  onChange,
  min,
  max,
  step = "any",
  suffix,
}: {
  value: string | number;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  step?: number | "any";
  suffix?: string;
}) {
  return (
    <div className="flex max-w-xs items-center gap-2">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] leading-5 text-foreground outline-none transition focus:border-primary/50 focus:ring-1 focus:ring-ring/40"
      />
      {suffix ? (
        <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>
      ) : null}
    </div>
  );
}

function QuotaRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-2 px-4 py-3 sm:grid-cols-[230px_1fr] sm:gap-5">
      <div className="min-w-0">
        <div className="text-[13px] font-medium leading-5 text-foreground">{label}</div>
        <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{description}</div>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export default function WorkspaceQuotaSettings({ title }: { title: string }) {
  const { t } = useTranslation("settings");
  const {
    raw,
    setRaw,
    save,
    loading,
    saving,
    error,
  } = usePilotDeckConfig();
  const { storage, loading: storageLoading } = useUsersAdmin();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);
  const [draft, setDraft] = useState<QuotaDraft>(DEFAULT_QUOTA);
  const [dirty, setDirty] = useState(false);
  const [validationError, setValidationError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (parsedConfig && !dirty) setDraft(readQuota(parsedConfig));
  }, [dirty, parsedConfig]);

  const update = <K extends keyof QuotaDraft>(key: K, value: QuotaDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setSaved(false);
    setValidationError("");
  };

  const validate = (): string | null => {
    if (draft.workspaceWarnBytes <= 0) return t("settingsPage.workspaceQuota.validation.positive");
    if (draft.inboxWarnBytes < 0) return t("settingsPage.workspaceQuota.validation.nonNegative");
    if (draft.scratchMaxBytes <= 0 || draft.userTotalMaxBytes <= 0 || draft.imagingScratchMaxBytes <= 0) {
      return t("settingsPage.workspaceQuota.validation.positive");
    }
    if (draft.scratchSoftRatio < 0.5 || draft.scratchSoftRatio > 0.95) {
      return t("settingsPage.workspaceQuota.validation.ratio");
    }
    if (draft.scratchTtlDays < 1 || draft.scratchTtlDays > 365) {
      return t("settingsPage.workspaceQuota.validation.ttl");
    }
    if (draft.protectRecentMinutes < 0 || draft.protectRecentMinutes > 1440) {
      return t("settingsPage.workspaceQuota.validation.protect");
    }
    return null;
  };

  const reset = () => {
    if (!parsedConfig) return;
    setDraft(readQuota(parsedConfig));
    setDirty(false);
    setSaved(false);
    setValidationError("");
  };

  const saveDraft = async () => {
    if (!parsedConfig) return;
    const nextError = validate();
    if (nextError) {
      setValidationError(nextError);
      return;
    }

    const existingQuota = parsedConfig.workspace?.quota ?? {};
    const nextConfig: PilotDeckConfig = {
      ...parsedConfig,
      workspace: {
        ...parsedConfig.workspace,
        quota: {
          ...existingQuota,
          workspaceWarnBytes: draft.workspaceWarnBytes,
          inboxWarnBytes: draft.inboxWarnBytes,
          scratchMaxBytes: draft.scratchMaxBytes,
          scratchSoftRatio: draft.scratchSoftRatio,
          scratchTtlDays: draft.scratchTtlDays,
          protectRecentMinutes: draft.protectRecentMinutes,
          cleanOnTurnEnd: draft.cleanOnTurnEnd,
          toolResultsTtlDays: existingQuota.toolResultsTtlDays,
          snapshotRetentionDays: existingQuota.snapshotRetentionDays,
          userTotalMaxBytes: draft.userTotalMaxBytes,
          overrides: {
            ...existingQuota.overrides,
            imaging: {
              ...existingQuota.overrides?.imaging,
              scratchMaxBytes: draft.imagingScratchMaxBytes,
            },
          },
        },
      },
    };

    setRaw(configToYamlString(nextConfig));
    const result = await save();
    if (result.ok) {
      setDirty(false);
      setSaved(true);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
        <div className="py-6 text-xs text-muted-foreground">
          {t("pilotDeckConfig.loading")}
        </div>
      </div>
    );
  }

  if (!parsedConfig) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t("settingsPage.invalidYaml.workspaceQuota")}
        </div>
      </div>
    );
  }

  const totalBytes = storage?.totalBytes ?? 0;
  const totalRatio = draft.workspaceWarnBytes > 0 ? totalBytes / draft.workspaceWarnBytes : 0;
  const archivedBytes = storage?.archivedBytes ?? 0;
  const overWarningUsers = storage
    ? t("settingsPage.workspaceQuota.usage.userWarning", {
        count: storage.overWarningUserCount ?? 0,
      })
    : "";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          {t("settingsPage.workspaceQuota.description")}
        </p>
      </div>
      <ConfigSaveError error={error} />
      {validationError ? (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {validationError}
        </div>
      ) : null}

      <SettingsSection
        title={t("settingsPage.workspaceQuota.sections.alerts.title")}
        description={t("settingsPage.workspaceQuota.sections.alerts.description")}
      >
        <SettingsCard divided>
          <QuotaRow
            label={t("settingsPage.workspaceQuota.fields.workspaceWarn.label")}
            description={t("settingsPage.workspaceQuota.fields.workspaceWarn.description")}
          >
            <NumberField
              value={toGiB(draft.workspaceWarnBytes)}
              suffix="GB"
              min={0.01}
              step={0.1}
              onChange={(value) => {
                const next = fromGiB(value);
                if (next !== null) update("workspaceWarnBytes", next);
              }}
            />
          </QuotaRow>
          <QuotaRow
            label={t("settingsPage.workspaceQuota.fields.inboxWarn.label")}
            description={t("settingsPage.workspaceQuota.fields.inboxWarn.description")}
          >
            <NumberField
              value={toGiB(draft.inboxWarnBytes)}
              suffix="GB"
              min={0}
              step={0.1}
              onChange={(value) => {
                const next = fromGiB(value, true);
                if (next !== null) update("inboxWarnBytes", next);
              }}
            />
          </QuotaRow>
          <QuotaRow
            label={t("settingsPage.workspaceQuota.fields.userTotal.label")}
            description={t("settingsPage.workspaceQuota.fields.userTotal.description")}
          >
            <NumberField
              value={toGiB(draft.userTotalMaxBytes)}
              suffix="GB"
              min={0.01}
              step={0.1}
              onChange={(value) => {
                const next = fromGiB(value);
                if (next !== null) update("userTotalMaxBytes", next);
              }}
            />
          </QuotaRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t("settingsPage.workspaceQuota.sections.cleanup.title")}
        description={t("settingsPage.workspaceQuota.sections.cleanup.description")}
      >
        <SettingsCard divided>
          <QuotaRow
            label={t("settingsPage.workspaceQuota.fields.scratchMax.label")}
            description={t("settingsPage.workspaceQuota.fields.scratchMax.description")}
          >
            <NumberField
              value={toGiB(draft.scratchMaxBytes)}
              suffix="GB"
              min={0.01}
              step={0.1}
              onChange={(value) => {
                const next = fromGiB(value);
                if (next !== null) update("scratchMaxBytes", next);
              }}
            />
          </QuotaRow>
          <QuotaRow
            label={t("settingsPage.workspaceQuota.fields.imagingScratchMax.label")}
            description={t("settingsPage.workspaceQuota.fields.imagingScratchMax.description")}
          >
            <NumberField
              value={toGiB(draft.imagingScratchMaxBytes)}
              suffix="GB"
              min={0.01}
              step={0.1}
              onChange={(value) => {
                const next = fromGiB(value);
                if (next !== null) update("imagingScratchMaxBytes", next);
              }}
            />
          </QuotaRow>
          <QuotaRow
            label={t("settingsPage.workspaceQuota.fields.softRatio.label")}
            description={t("settingsPage.workspaceQuota.fields.softRatio.description")}
          >
            <NumberField
              value={Math.round(draft.scratchSoftRatio * 100)}
              suffix="%"
              min={50}
              max={95}
              step={1}
              onChange={(value) => {
                const next = Number(value);
                if (Number.isFinite(next)) update("scratchSoftRatio", next / 100);
              }}
            />
          </QuotaRow>
          <QuotaRow
            label={t("settingsPage.workspaceQuota.fields.ttl.label")}
            description={t("settingsPage.workspaceQuota.fields.ttl.description")}
          >
            <NumberField
              value={draft.scratchTtlDays}
              suffix={t("settingsPage.workspaceQuota.units.days")}
              min={1}
              max={365}
              step={1}
              onChange={(value) => {
                const next = Number(value);
                if (Number.isFinite(next)) update("scratchTtlDays", next);
              }}
            />
          </QuotaRow>
          <QuotaRow
            label={t("settingsPage.workspaceQuota.fields.protect.label")}
            description={t("settingsPage.workspaceQuota.fields.protect.description")}
          >
            <NumberField
              value={draft.protectRecentMinutes}
              suffix={t("settingsPage.workspaceQuota.units.minutes")}
              min={0}
              max={1440}
              step={1}
              onChange={(value) => {
                const next = Number(value);
                if (Number.isFinite(next)) update("protectRecentMinutes", next);
              }}
            />
          </QuotaRow>
          <QuotaRow
            label={t("settingsPage.workspaceQuota.fields.cleanOnTurnEnd.label")}
            description={t("settingsPage.workspaceQuota.fields.cleanOnTurnEnd.description")}
          >
            <button
              type="button"
              role="switch"
              aria-checked={draft.cleanOnTurnEnd}
              onClick={() => update("cleanOnTurnEnd", !draft.cleanOnTurnEnd)}
              className={cn(
                "relative inline-flex h-7 w-12 items-center rounded-full border-2 transition-colors",
                draft.cleanOnTurnEnd ? "border-primary bg-primary" : "border-border bg-muted",
              )}
            >
              <span className={cn(
                "h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
                draft.cleanOnTurnEnd ? "translate-x-[22px]" : "translate-x-[2px]",
              )} />
            </button>
          </QuotaRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t("settingsPage.workspaceQuota.sections.usage.title")}
        description={t("settingsPage.workspaceQuota.sections.usage.description")}
      >
        <SettingsCard className="grid gap-px bg-border sm:grid-cols-3">
          <div className="bg-card/50 px-4 py-3">
            <div className="text-[11px] text-muted-foreground">{t("settingsPage.workspaceQuota.usage.total")}</div>
            <div className="mt-1 text-lg font-semibold text-foreground">
              {storageLoading ? "…" : formatBytes(totalBytes)}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {Math.round(totalRatio * 100)}% {t("settingsPage.workspaceQuota.usage.ofAlert")}
            </div>
          </div>
          <div className="bg-card/50 px-4 py-3">
            <div className="text-[11px] text-muted-foreground">{t("settingsPage.workspaceQuota.usage.inbox")}</div>
            <div className="mt-1 text-lg font-semibold text-foreground">
              {storageLoading ? "…" : formatBytes(storage?.totalInboxBytes ?? 0)}
            </div>
          </div>
          <div className="bg-card/50 px-4 py-3">
            <div className="text-[11px] text-muted-foreground">{t("settingsPage.workspaceQuota.usage.archived")}</div>
            <div className="mt-1 text-lg font-semibold text-foreground">
              {storageLoading ? "…" : formatBytes(archivedBytes)}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">{overWarningUsers}</div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        <button
          type="button"
          onClick={reset}
          disabled={!dirty || saving}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t("settingsPage.workspaceQuota.actions.cancel")}
        </button>
        <button
          type="button"
          onClick={() => void saveDraft()}
          disabled={!dirty || saving}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
          {saving
            ? t("settingsPage.workspaceQuota.actions.saving")
            : saved
              ? t("settingsPage.workspaceQuota.actions.saved")
              : t("settingsPage.workspaceQuota.actions.save")}
        </button>
      </div>
    </div>
  );
}
