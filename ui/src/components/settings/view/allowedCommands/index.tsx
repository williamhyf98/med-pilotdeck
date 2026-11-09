import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Loader2, RefreshCw, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { authenticatedFetch } from "../../../../utils/api";
import { Button } from "../../../../shared/view/ui";
import { SettingsCard, SettingsRow, SettingsToggle } from "../../shared/view";

type CommandRule = {
  id: string;
  enabled: boolean;
  allowedOptions: string[];
  availableOptions: string[];
  inputRoots: string[];
  allowedInputRoots: string[];
  outputRoots: string[];
  allowedOutputRoots: string[];
  writable: boolean;
  networkRuleIds: string[];
  timeoutMs: number;
  maxTimeoutMs: number;
};

type CommandsResponse = {
  policy: { version: 1; mode: "registered_only"; commands: CommandRule[] };
  commands: CommandRule[];
  commandRevision: string;
};

function toggleValue(values: string[], value: string, checked: boolean): string[] {
  return checked
    ? [...new Set([...values, value])]
    : values.filter((entry) => entry !== value);
}

export default function AllowedCommandsSettings({ title }: { title: string }) {
  const { t } = useTranslation("settings");
  const [commands, setCommands] = useState<CommandRule[]>([]);
  const [revision, setRevision] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await authenticatedFetch("/api/security-policy/commands");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t("securityPolicy.errors.load"));
      const result = body as CommandsResponse;
      setCommands(result.commands);
      setRevision(result.commandRevision);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("securityPolicy.errors.load"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (id: string, change: Partial<CommandRule>) => {
    setSaved(false);
    setCommands((current) => current.map((command) => (
      command.id === id
        ? {
          ...command,
          ...change,
          ...(change.outputRoots
            ? { writable: command.writable && change.outputRoots.length > 0 }
            : {}),
        }
        : command
    )));
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const policy = {
        version: 1,
        mode: "registered_only" as const,
        commands: commands.map(({
          availableOptions: _availableOptions,
          allowedInputRoots: _allowedInputRoots,
          allowedOutputRoots: _allowedOutputRoots,
          maxTimeoutMs: _maxTimeoutMs,
          ...command
        }) => command),
      };
      const response = await authenticatedFetch("/api/security-policy/commands", {
        method: "PUT",
        body: JSON.stringify({ revision, policy }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t("securityPolicy.errors.save"));
      setCommands(body.commands);
      setRevision(body.commandRevision);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("securityPolicy.errors.save"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("securityPolicy.commands.description")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading || saving}>
            <RefreshCw className={loading ? "animate-spin" : undefined} />
            {t("securityPolicy.actions.refresh")}
          </Button>
          <Button type="button" size="sm" onClick={() => void save()} disabled={loading || saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            {saving ? t("securityPolicy.actions.saving") : t("securityPolicy.actions.save")}
          </Button>
        </div>
      </div>

      {error ? (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {saved ? (
        <div role="status" className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {t("securityPolicy.actions.saved")}
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="animate-spin" />
          {t("securityPolicy.actions.loading")}
        </div>
      ) : (
        <SettingsCard divided>
          {commands.map((command) => {
            const isExpanded = expanded === command.id;
            return (
              <div key={command.id}>
                <SettingsRow
                  label={<code className="text-xs">{command.id}</code>}
                  description={t("securityPolicy.commands.registeredDescription")}
                >
                  <div className="flex items-center gap-3">
                    <SettingsToggle
                      checked={command.enabled}
                      ariaLabel={t("securityPolicy.commands.enabled")}
                      onChange={(enabled) => patch(command.id, { enabled })}
                    />
                    <button
                      type="button"
                      className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label={t("securityPolicy.commands.details")}
                      aria-expanded={isExpanded}
                      onClick={() => setExpanded(isExpanded ? null : command.id)}
                    >
                      <ChevronDown className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                    </button>
                  </div>
                </SettingsRow>
                {isExpanded ? (
                  <div className="space-y-4 border-t border-border bg-muted/10 px-4 py-4">
                    <div>
                      <div className="mb-2 text-xs font-medium text-foreground">{t("securityPolicy.commands.options")}</div>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {command.availableOptions.map((option) => (
                          <label key={option} className="flex items-center gap-2 text-xs text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={command.allowedOptions.includes(option)}
                              onChange={(event) => patch(command.id, {
                                allowedOptions: toggleValue(command.allowedOptions, option, event.target.checked),
                              })}
                            />
                            <code>{option}</code>
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <div className="mb-2 text-xs font-medium text-foreground">{t("securityPolicy.commands.inputRoots")}</div>
                        <div className="flex flex-wrap gap-3">
                          {command.allowedInputRoots.map((root) => (
                            <label key={root} className="flex items-center gap-2 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                checked={command.inputRoots.includes(root)}
                                onChange={(event) => patch(command.id, {
                                  inputRoots: toggleValue(command.inputRoots, root, event.target.checked),
                                })}
                              />
                              <code>{root}</code>
                            </label>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="mb-2 text-xs font-medium text-foreground">{t("securityPolicy.commands.outputRoots")}</div>
                        <div className="flex flex-wrap gap-3">
                          {command.allowedOutputRoots.map((root) => (
                            <label key={root} className="flex items-center gap-2 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                checked={command.outputRoots.includes(root)}
                                onChange={(event) => patch(command.id, {
                                  outputRoots: toggleValue(command.outputRoots, root, event.target.checked),
                                })}
                              />
                              <code>{root}</code>
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={command.writable}
                          disabled={command.outputRoots.length === 0}
                          onChange={(event) => patch(command.id, { writable: event.target.checked })}
                        />
                        {t("securityPolicy.commands.writable")}
                      </label>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        {t("securityPolicy.commands.timeout")}
                        <input
                          className="h-8 w-28 rounded-md border border-input bg-background px-2 text-xs"
                          type="number"
                          min={1}
                          max={command.maxTimeoutMs}
                          value={command.timeoutMs}
                          onChange={(event) => patch(command.id, { timeoutMs: Number(event.target.value) })}
                        />
                        <span>ms / {command.maxTimeoutMs} ms</span>
                      </label>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </SettingsCard>
      )}

      <SettingsRow
        label={t("securityPolicy.revision.label")}
        description={t("securityPolicy.revision.description")}
      >
        <span className="font-mono text-xs text-muted-foreground">{revision || "-"}</span>
      </SettingsRow>
    </div>
  );
}
