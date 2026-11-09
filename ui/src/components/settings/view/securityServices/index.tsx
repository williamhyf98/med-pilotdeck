import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, PlugZap, RefreshCw, Save, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { authenticatedFetch } from "../../../../utils/api";
import { Button } from "../../../../shared/view/ui";
import { SettingsCard, SettingsRow } from "../../shared/view";

type ServiceStatus = "not_tested" | "reachable" | "unreachable" | "disabled";

type SecurityService = {
  id: string;
  name: string;
  purpose: string;
  protocol: "http" | "https" | "ws" | "wss";
  host: string;
  port: number;
  source: string;
  enabled: boolean;
  status: ServiceStatus;
  lastTest?: {
    ok: boolean;
    status: ServiceStatus;
    httpStatus?: number;
    latencyMs: number;
    testedAt: string;
    error?: string;
  };
};

type ServiceResponse = {
  services: SecurityService[];
  networkRevision: string;
};

type Draft = Pick<SecurityService, "host" | "port" | "protocol">;

function statusClass(status: ServiceStatus): string {
  if (status === "reachable") return "text-emerald-600 dark:text-emerald-400";
  if (status === "unreachable") return "text-destructive";
  if (status === "disabled") return "text-muted-foreground";
  return "text-amber-600 dark:text-amber-400";
}

export default function SecurityServicesSettings({ title }: { title: string }) {
  const { t } = useTranslation("settings");
  const [services, setServices] = useState<SecurityService[]>([]);
  const [revision, setRevision] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await authenticatedFetch("/api/security-policy/services");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t("securityPolicy.errors.load"));
      const result = body as ServiceResponse;
      setServices(result.services);
      setRevision(result.networkRevision);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("securityPolicy.errors.load"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const startEdit = (service: SecurityService) => {
    setError("");
    setEditing(service.id);
    setDraft({
      host: service.host,
      port: service.port,
      protocol: service.protocol,
    });
  };

  const save = async () => {
    if (!editing || !draft) return;
    setBusy(true);
    setError("");
    try {
      const response = await authenticatedFetch(
        `/api/security-policy/services/${encodeURIComponent(editing)}`,
        {
          method: "PUT",
          body: JSON.stringify({ revision, ...draft }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t("securityPolicy.errors.save"));
      setServices(body.services);
      setRevision(body.networkRevision);
      setEditing(null);
      setDraft(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("securityPolicy.errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const test = async (serviceId: string) => {
    setTesting(serviceId);
    setError("");
    try {
      const response = await authenticatedFetch(
        `/api/security-policy/services/${encodeURIComponent(serviceId)}/test`,
        { method: "POST" },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t("securityPolicy.errors.test"));
      setServices((current) => current.map((service) => (
        service.id === serviceId ? body.service : service
      )));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("securityPolicy.errors.test"));
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("securityPolicy.services.description")}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? "animate-spin" : undefined} />
          {t("securityPolicy.actions.refresh")}
        </Button>
      </div>

      {error ? (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="animate-spin" />
          {t("securityPolicy.actions.loading")}
        </div>
      ) : (
        <SettingsCard className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-border bg-muted/20 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">{t("securityPolicy.services.service")}</th>
                  <th className="px-4 py-3 font-medium">{t("securityPolicy.services.address")}</th>
                  <th className="px-4 py-3 font-medium">{t("securityPolicy.services.source")}</th>
                  <th className="px-4 py-3 font-medium">{t("securityPolicy.services.status")}</th>
                  <th className="px-4 py-3 text-right font-medium">{t("securityPolicy.services.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {services.map((service) => {
                  const isEditing = editing === service.id && draft;
                  return (
                    <tr key={service.id} className="align-top">
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground">{service.name}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{service.purpose}</div>
                        <code className="mt-1 block text-[11px] text-muted-foreground">{service.id}</code>
                      </td>
                      <td className="px-4 py-3">
                        {isEditing ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <select
                              aria-label={t("securityPolicy.services.protocol")}
                              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                              value={draft.protocol}
                              onChange={(event) => setDraft({ ...draft, protocol: event.target.value as Draft["protocol"] })}
                            >
                              {["http", "https", "ws", "wss"].map((protocol) => (
                                <option key={protocol} value={protocol}>{protocol}</option>
                              ))}
                            </select>
                            <input
                              aria-label={t("securityPolicy.services.host")}
                              className="h-9 min-w-[170px] flex-1 rounded-md border border-input bg-background px-2 text-sm"
                              value={draft.host}
                              onChange={(event) => setDraft({ ...draft, host: event.target.value })}
                            />
                            <input
                              aria-label={t("securityPolicy.services.port")}
                              className="h-9 w-24 rounded-md border border-input bg-background px-2 text-sm"
                              type="number"
                              min={1}
                              max={65535}
                              value={draft.port}
                              onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })}
                            />
                          </div>
                        ) : (
                          <code className="text-xs text-foreground">
                            {service.protocol}://{service.host}:{service.port}
                          </code>
                        )}
                        {service.lastTest ? (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {service.lastTest.testedAt}
                            {service.lastTest.latencyMs >= 0 ? ` · ${service.lastTest.latencyMs}ms` : ""}
                            {service.lastTest.httpStatus ? ` · HTTP ${service.lastTest.httpStatus}` : ""}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{service.source}</td>
                      <td className={`px-4 py-3 text-xs font-medium ${statusClass(service.status)}`}>
                        {t(`securityPolicy.status.${service.status}`)}
                        {service.lastTest?.error ? (
                          <div className="mt-1 max-w-[220px] font-normal text-destructive">{service.lastTest.error}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          {isEditing ? (
                            <>
                              <Button type="button" size="sm" onClick={() => void save()} disabled={busy}>
                                {busy ? <Loader2 className="animate-spin" /> : <Save />}
                                {t("securityPolicy.actions.save")}
                              </Button>
                              <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(null); setDraft(null); }} disabled={busy}>
                                <X />
                                {t("securityPolicy.actions.cancel")}
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button type="button" size="sm" variant="outline" onClick={() => void test(service.id)} disabled={testing === service.id || !service.enabled}>
                                {testing === service.id ? <Loader2 className="animate-spin" /> : <PlugZap />}
                                {t("securityPolicy.actions.test")}
                              </Button>
                              <Button type="button" size="sm" variant="ghost" onClick={() => startEdit(service)}>
                                <Pencil />
                                {t("securityPolicy.actions.edit")}
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {services.length === 0 ? (
            <div className="px-4 py-8 text-sm text-muted-foreground">
              {t("securityPolicy.services.empty")}
            </div>
          ) : null}
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
