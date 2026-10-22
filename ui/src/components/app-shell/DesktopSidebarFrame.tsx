import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence';
import { safeLocalStorage } from '../../utils/safeStorage';

const SIDEBAR_ANIMATION_DURATION = 420;
function initialSidebarWidth() {
  const stored = Number(safeLocalStorage.getItem('sidebar-v2-width'));
  return Number.isFinite(stored) && stored >= 200 && stored <= 480 ? stored : 248;
}

export default function DesktopSidebarFrame({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initialSidebarWidth);
  const { present, exiting } = useAnimatedPresence(open, SIDEBAR_ANIMATION_DURATION);

  useLayoutEffect(() => {
    if (!present) return undefined;
    const sidebar = frameRef.current?.querySelector<HTMLElement>('[data-sidebar-v2-root]');
    if (!sidebar) return undefined;
    const updateWidth = () => {
      const next = sidebar.getBoundingClientRect().width || Number.parseFloat(sidebar.style.width);
      if (next > 0) setWidth(next);
    };
    updateWidth();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(sidebar);
    return () => observer.disconnect();
  }, [present]);

  if (!present) return null;

  return (
    <div
      ref={frameRef}
      data-desktop-sidebar-frame
      aria-hidden={exiting}
      className={`relative h-full shrink-0 overflow-hidden ${exiting ? 'pd-app-sidebar-exit pointer-events-none' : 'pd-app-sidebar-enter'}`}
      style={{ '--pd-app-sidebar-width': `${width}px` } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
