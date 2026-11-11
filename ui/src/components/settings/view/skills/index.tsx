import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { authenticatedFetch } from "../../../../utils/api";
import { cn } from "../../../../lib/utils";
import { SettingsCard, SettingsSection } from "../../shared/view";

export type AnalysisDependency = {
  name: string;
  extras?: string;
  specifier: string;
  tier: string;
  installed: string | null;
};

export type AnalysisDepsResponse = {
  skill: string;
  readOnly: boolean;
  runtime: {
    status: "ready" | "missing_dependencies" | "not_bootstrapped" | string;
    usable: boolean;
    path: string;
    requirementsHash: string;
    bootstrappedAt: string | null;
    stampMatches: boolean | null;
  };
  environment: { cacheRoot: string; skillRoot: string; pythonOverride: string | null };
  counts: { total: number; installed: number; byTier: Record<string, number> };
  packages: AnalysisDependency[];
};

type SkillsDepsProps = {
  title: string;
};

const TIER_LABEL_KEYS: Record<string, string> = {
  base: "settingsPage.skills.tierBase",
  stats: "settingsPage.skills.tierStats",
  medical: "settingsPage.skills.tierMedical",
};

const STATUS_STYLE: Record<string, string> = {
  ready: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  missing_dependencies: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  not_bootstrapped: "bg-muted text-muted-foreground",
};

function statusKey(status: string): string {
  if (status === "ready") return "settingsPage.skills.status.ready";
  if (status === "missing_dependencies") return "settingsPage.skills.status.missing";
  return "settingsPage.skills.status.notBootstrapped";
}

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function SkillsDeps({ title }: SkillsDepsProps) {
  const { t } = useTranslation("settings");
  const [data, setData] = useState<AnalysisDepsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch("/api/admin/skills/data-analysis/deps");
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`.trim());
      }
      setData((await response.json()) as AnalysisDepsResponse);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const status = data?.runtime.status ?? "not_bootstrapped";

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("settingsPage.skills.description")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {t("settingsPage.skills.refresh")}
        </button>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("settingsPage.skills.loadFailed", { message: error })}</span>
        </div>
      ) : null}

      <SettingsCard>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3.5">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                STATUS_STYLE[status] ?? "bg-muted text-muted-foreground",
              )}
            >
              {status === "ready" ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
              {t(statusKey(status))}
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            {t("settingsPage.skills.installedCount", {
              installed: data?.counts.installed ?? 0,
              total: data?.counts.total ?? 0,
            })}
          </span>
          <span className="text-xs text-muted-foreground">
            {t("settingsPage.skills.bootstrappedAt")}: {formatDateTime(data?.runtime.bootstrappedAt ?? null)}
          </span>
          {data?.environment.pythonOverride ? (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              {t("settingsPage.skills.pythonOverride")}: {data.environment.pythonOverride}
            </span>
          ) : null}
        </div>
        <div className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          <div className="truncate" title={data?.runtime.path}>
            {t("settingsPage.skills.runtimePath")}: {data?.runtime.path ?? "-"}
          </div>
        </div>
      </SettingsCard>

      <SettingsSection
        title={t("settingsPage.skills.packagesTitle")}
        description={t("settingsPage.skills.readOnlyNotice")}
      >
        <SettingsCard>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">{t("settingsPage.skills.columns.name")}</th>
                  <th className="px-4 py-2 font-medium">{t("settingsPage.skills.columns.specifier")}</th>
                  <th className="px-4 py-2 font-medium">{t("settingsPage.skills.columns.tier")}</th>
                  <th className="px-4 py-2 font-medium">{t("settingsPage.skills.columns.installed")}</th>
                </tr>
              </thead>
              <tbody>
                {(data?.packages ?? []).map((pkg) => (
                  <tr key={`${pkg.tier}-${pkg.name}`} className="border-b border-border/50 last:border-0">
                    <td className="px-4 py-2 font-mono text-xs text-foreground">
                      {pkg.name}
                      {pkg.extras ? `[${pkg.extras}]` : ""}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{pkg.specifier || "-"}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {t(TIER_LABEL_KEYS[pkg.tier] ?? "settingsPage.skills.tierOther")}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {pkg.installed ? (
                        <span className="text-emerald-600 dark:text-emerald-400">{pkg.installed}</span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                  </tr>
                ))}
                {!loading && (data?.packages ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-xs text-muted-foreground">
                      {t("settingsPage.skills.empty")}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
