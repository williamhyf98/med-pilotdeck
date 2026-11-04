import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, RefreshCw } from "lucide-react";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import { cn } from "../../../../lib/utils";
import {
  normalizeOfficePreviewService,
  readOfficePreviewStatus,
  type OfficePreviewService,
  type OfficePreviewStatus,
} from "../../../../utils/officePreviewStatus";
import {
  FormRow,
  Select,
} from "../../shared/components/Inputs";
import {
  ConfigSaveError,
  SettingsCard,
  SettingsSection,
} from "../../shared/view";
import type { PilotDeckConfig } from "../modelPool/types";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import { patch } from "../modelPool/utils/patch";

type OfficePreviewSectionsProps = {
  title: string;
};

function OfficePreviewSection({
  config,
  onChange,
}: {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
}) {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<OfficePreviewStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusReloadKey, setStatusReloadKey] = useState(0);
  const service = normalizeOfficePreviewService(
    config.webui?.officePreview?.service,
  );

  useEffect(() => {
    let cancelled = false;
    setStatusLoading(true);
    setStatusError(null);

    readOfficePreviewStatus({ refresh: statusReloadKey > 0 })
      .then((body: OfficePreviewStatus) => {
        if (cancelled) return;
        setStatus(body);
        setStatusError(body.statusError || null);
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setStatusError(
          error.message ||
            t("pilotDeckConfig.panels.officePreview.status.error"),
        );
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [statusReloadKey, t]);

  const libreOfficeStatusKnown =
    status?.libreOffice?.available !== undefined;
  const libreOfficeAvailable = status?.libreOffice?.available === true;
  const libreOfficeUnavailable =
    !statusLoading && status?.libreOffice?.available === false;
  const libreOfficeUnknown =
    !statusLoading && !statusError && !libreOfficeStatusKnown;
  const setService = (next: OfficePreviewService) =>
    onChange(
      patch(config, ["webui", "officePreview", "service"], next),
    );

  return (
    <SettingsSection
      title={t("pilotDeckConfig.panels.officePreview.title")}
      description={t("pilotDeckConfig.panels.officePreview.description")}
    >
      <SettingsCard>
        <div className="divide-y divide-border">
          <FormRow
            label={t(
              "pilotDeckConfig.panels.officePreview.fields.service.label",
            )}
            description={t(
              "pilotDeckConfig.panels.officePreview.fields.service.description",
            )}
          >
            <div className="max-w-xs">
              <Select
                value={service}
                onChange={(value) =>
                  setService(value as OfficePreviewService)
                }
                options={[
                  {
                    value: "builtin",
                    label: t(
                      "pilotDeckConfig.panels.officePreview.options.builtin",
                    ),
                  },
                  {
                    value: "libreoffice",
                    label: libreOfficeUnavailable
                      ? t(
                          "pilotDeckConfig.panels.officePreview.options.libreOfficeUnavailable",
                        )
                      : t(
                          "pilotDeckConfig.panels.officePreview.options.libreOffice",
                        ),
                  },
                ]}
              />
            </div>
          </FormRow>

          <div className="space-y-2 px-4 py-3">
            {(libreOfficeStatusKnown || statusLoading) && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
                  <span
                    className={cn(
                      "h-2 w-2 flex-shrink-0 rounded-full",
                      libreOfficeAvailable
                        ? "bg-green-500"
                        : libreOfficeUnavailable || statusError
                          ? "bg-muted-foreground/60"
                          : "bg-amber-500",
                    )}
                  />
                  <span className="min-w-0 truncate">
                    {statusLoading
                      ? t(
                          "pilotDeckConfig.panels.officePreview.status.checking",
                        )
                      : statusError
                        ? t(
                            "pilotDeckConfig.panels.officePreview.status.error",
                          )
                        : libreOfficeAvailable
                          ? t(
                              "pilotDeckConfig.panels.officePreview.status.available",
                            )
                          : libreOfficeUnavailable
                            ? t(
                                "pilotDeckConfig.panels.officePreview.status.unavailable",
                              )
                            : libreOfficeUnknown
                              ? t(
                                  "pilotDeckConfig.panels.officePreview.status.unknown",
                                )
                              : t(
                                  "pilotDeckConfig.panels.officePreview.status.unavailable",
                                )}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setStatusReloadKey((value) => value + 1)
                  }
                  className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <RefreshCw
                    className={cn(
                      "h-3.5 w-3.5",
                      statusLoading && "animate-spin",
                    )}
                  />
                  {t(
                    "pilotDeckConfig.panels.officePreview.status.refresh",
                  )}
                </button>
              </div>
            )}

            {libreOfficeAvailable && (
              <div className="space-y-1 rounded-md bg-muted/30 px-3 py-2 text-[11px] leading-4 text-muted-foreground">
                {status?.libreOffice?.binaryPath && (
                  <div
                    className="truncate"
                    title={status.libreOffice.binaryPath}
                  >
                    {t(
                      "pilotDeckConfig.panels.officePreview.status.path",
                      { path: status.libreOffice.binaryPath },
                    )}
                  </div>
                )}
                {status?.libreOffice?.version && (
                  <div
                    className="truncate"
                    title={status.libreOffice.version}
                  >
                    {t(
                      "pilotDeckConfig.panels.officePreview.status.version",
                      { version: status.libreOffice.version },
                    )}
                  </div>
                )}
              </div>
            )}

            {service === "builtin" && (
              <div className="rounded-md bg-muted/30 px-3 py-2 text-[11px] leading-4 text-muted-foreground">
                {t(
                  "pilotDeckConfig.panels.officePreview.builtinNote",
                )}
              </div>
            )}

            {libreOfficeUnavailable && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-5 text-amber-700 dark:text-amber-300">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div>
                  {t(
                    "pilotDeckConfig.panels.officePreview.unavailableWarning",
                  )}
                </div>
              </div>
            )}

            {statusError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive">
                {statusError}
              </div>
            )}
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

export default function OfficePreviewSections({
  title,
}: OfficePreviewSectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, setRaw, save, loading, error } = usePilotDeckConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  const onFormChange = async (next: PilotDeckConfig) => {
    try {
      setRaw(configToYamlString(next));
      await save();
    } catch (caught) {
      console.error(
        "Failed to serialise Office preview config patch",
        caught,
      );
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
          {t("settingsPage.invalidYaml.officePreview")}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
      <ConfigSaveError error={error} />
      <OfficePreviewSection
        config={parsedConfig}
        onChange={onFormChange}
      />
    </div>
  );
}
