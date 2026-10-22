import { useCallback, useEffect, useMemo, useState } from "react";
import { PilotDeckConfigProvider } from "../../hooks/usePilotDeckConfig";
import { useAuth } from "../auth/context/AuthContext";
import type { SettingsProps } from "./shared/types";
import type { SettingsMenuKey } from "./types";
import { mapInitialTabToMenuKey } from "./navigation";
import SettingsSidebar, { getSelectableMenuKeys } from "./view/SettingsSidebar";
import SettingsContent from "./view/SettingsContent";
import { useAnimatedClose } from "../../hooks/useAnimatedPresence";

export type DesktopVersionCheckResult = {
  mode: "desktop" | "web";
  hasUpdate: boolean;
  checkUnavailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  latestPublishedAt: string | null;
  buildTime: string | null;
};

// A deep link may name a page the role cannot see (e.g. `config:models` for a
// normal user, or `users` in no-login mode); fall back to the general page
// instead of rendering UI the current mode does not offer.
function resolveMenuKey(
  tab: string | undefined,
  isAdmin: boolean,
  authDisabled: boolean,
): SettingsMenuKey {
  const key = mapInitialTabToMenuKey(tab);
  return getSelectableMenuKeys(isAdmin, authDisabled).includes(key) ? key : "general";
}

function SettingsInner({
  isOpen,
  onClose,
  projects = [],
  initialTab,
}: SettingsProps) {
  const { isAdmin, authDisabled } = useAuth();
  const isDesktopApp =
    typeof window !== "undefined" && !!(window as any).pilotdeckDesktop;
  const initialKey = useMemo(
    () => resolveMenuKey(initialTab, isAdmin, authDisabled),
    [initialTab, isAdmin, authDisabled],
  );
  const [selectedKey, setSelectedKey] =
    useState<SettingsMenuKey>(initialKey);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(
    initialKey === "general",
  );
  const { closing, requestClose } = useAnimatedClose(onClose, 580);
  const versionInfo: DesktopVersionCheckResult = {
    mode: isDesktopApp ? "desktop" : "web",
    hasUpdate: false,
    checkUnavailable: false,
    currentVersion: "unknown",
    latestVersion: null,
    latestPublishedAt: null,
    buildTime: null,
  };

  useEffect(() => {
    if (!isOpen) return;
    const nextKey = resolveMenuKey(initialTab, isAdmin, authDisabled);
    setSelectedKey(nextKey);
    setMobileNavigationOpen(nextKey === "general");
    // Updates are handled by operators; opening Settings does not check for releases.
  }, [isOpen, initialTab, isAdmin, authDisabled]);

  const selectMenuItem = useCallback((key: SettingsMenuKey) => {
    setSelectedKey(key);
    setMobileNavigationOpen(false);
  }, []);

  if (!isOpen) {
    return null;
  }

  return (
    <div className={`modal-backdrop ${closing ? 'pd-settings-backdrop-exit pointer-events-none' : 'pd-settings-backdrop-enter'} fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm md:p-4`}>
      <div className={`${closing ? 'pd-settings-dialog-exit' : 'pd-settings-dialog-enter'} relative flex h-full w-full overflow-hidden border border-border bg-background shadow-2xl md:h-[90vh] md:max-w-7xl md:rounded-xl`}>
        <div className="flex h-full w-full flex-col md:flex-row">
          <SettingsSidebar
            selectedKey={selectedKey}
            onSelect={selectMenuItem}
            onClose={requestClose}
            showAboutDot={versionInfo.hasUpdate}
            mobileVisible={mobileNavigationOpen}
          />
          <SettingsContent
            selectedKey={selectedKey}
            projects={projects}
            versionInfo={versionInfo}
            checkingVersion={false}
            mobileVisible={!mobileNavigationOpen}
            onOpenMobileNavigation={() => setMobileNavigationOpen(true)}
          />
        </div>
      </div>
    </div>
  );
}

export default function Settings(props: SettingsProps) {
  const { isAdmin } = useAuth();
  // The provider is what fetches /api/config, which is admin-only. Normal
  // users get no provider, and usePilotDeckConfig() then yields a read-only
  // empty state without any request.
  return isAdmin ? (
    <PilotDeckConfigProvider>
      <SettingsInner {...props} />
    </PilotDeckConfigProvider>
  ) : (
    <SettingsInner {...props} />
  );
}
