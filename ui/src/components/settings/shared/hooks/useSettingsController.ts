import { useCallback, useEffect, useState } from "react";
import { DEFAULT_CODE_EDITOR_SETTINGS } from "../constants";
import { readProjectSortPreference } from "../../../../utils/projectSortPreference";
import type {
  CodeEditorSettingsState,
  ProjectSortOrder,
  SettingsMainTab,
} from "../types";
import { safeLocalStorage } from '../../../../utils/safeStorage';

type UseSettingsControllerArgs = {
  isOpen: boolean;
  initialTab: string;
};

const KNOWN_MAIN_TABS: SettingsMainTab[] = ["appearance", "permissions", "config"];

const normalizeMainTab = (tab: string): SettingsMainTab => {
  return KNOWN_MAIN_TABS.includes(tab as SettingsMainTab)
    ? (tab as SettingsMainTab)
    : "appearance";
};

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const readCodeEditorSettings = (): CodeEditorSettingsState => ({
  theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
  wordWrap: safeLocalStorage.getItem("codeEditorWordWrap") === "true",
  showMinimap: safeLocalStorage.getItem("codeEditorShowMinimap") !== "false",
  lineNumbers: safeLocalStorage.getItem("codeEditorLineNumbers") !== "false",
  fontSize:
    safeLocalStorage.getItem("codeEditorFontSize") ??
    DEFAULT_CODE_EDITOR_SETTINGS.fontSize,
});

export function useSettingsController({
  isOpen,
  initialTab,
}: UseSettingsControllerArgs) {
  const [activeTab, setActiveTab] = useState<SettingsMainTab>(() =>
    normalizeMainTab(initialTab),
  );
  const [saveStatus, setSaveStatus] = useState<"success" | "error" | null>(null);
  const [projectSortOrder, setProjectSortOrderState] =
    useState<ProjectSortOrder>(() => readProjectSortPreference());
  const [codeEditorSettings, setCodeEditorSettings] =
    useState<CodeEditorSettingsState>(() => readCodeEditorSettings());

  useEffect(() => {
    if (!isOpen) return;
    setActiveTab(normalizeMainTab(initialTab));

    setProjectSortOrderState(readProjectSortPreference());
  }, [isOpen, initialTab]);

  useEffect(() => {
    safeLocalStorage.setItem("codeEditorTheme", codeEditorSettings.theme);
    safeLocalStorage.setItem("codeEditorWordWrap", String(codeEditorSettings.wordWrap));
    safeLocalStorage.setItem(
      "codeEditorShowMinimap",
      String(codeEditorSettings.showMinimap),
    );
    safeLocalStorage.setItem(
      "codeEditorLineNumbers",
      String(codeEditorSettings.lineNumbers),
    );
    safeLocalStorage.setItem("codeEditorFontSize", codeEditorSettings.fontSize);
    window.dispatchEvent(new Event("codeEditorSettingsChanged"));
  }, [codeEditorSettings]);

  const setProjectSortOrder = useCallback((value: ProjectSortOrder) => {
    setProjectSortOrderState(value);
    try {
      const existing = parseJson<Record<string, unknown>>(
        safeLocalStorage.getItem("pilotdeck-settings"),
        {},
      );
      safeLocalStorage.setItem(
        "pilotdeck-settings",
        JSON.stringify({
          ...existing,
          projectSortOrder: value,
          lastUpdated: new Date().toISOString(),
        }),
      );
      window.dispatchEvent(new Event("pilotdeck-settings-changed"));
      setSaveStatus(null);
    } catch (err) {
      console.error("Failed to persist Appearance settings:", err);
      setSaveStatus("error");
    }
  }, []);

  useEffect(() => {
    if (saveStatus === null) return;
    const timer = window.setTimeout(() => setSaveStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  const updateCodeEditorSetting = useCallback(
    <K extends keyof CodeEditorSettingsState>(
      key: K,
      value: CodeEditorSettingsState[K],
    ) => {
      setCodeEditorSettings((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  return {
    activeTab,
    setActiveTab,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
  };
}
