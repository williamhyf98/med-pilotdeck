import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Keep a panel mounted long enough for its exit animation to finish. */
export function useAnimatedPresence(active: boolean, exitDuration: number) {
  const [present, setPresent] = useState(active);
  const [exiting, setExiting] = useState(false);

  useLayoutEffect(() => {
    if (active) {
      setPresent(true);
      setExiting(false);
      return undefined;
    }
    if (!present) return undefined;
    if (prefersReducedMotion()) {
      setPresent(false);
      setExiting(false);
      return undefined;
    }
    setExiting(true);
    const timer = window.setTimeout(() => {
      setPresent(false);
      setExiting(false);
    }, exitDuration);
    return () => window.clearTimeout(timer);
  }, [active, exitDuration, present]);

  return { present, exiting };
}

/** Delay the parent's close callback so a conditionally rendered dialog can fade out. */
export function useAnimatedClose(onClose: () => void, exitDuration: number) {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const callbackRef = useRef(onClose);
  callbackRef.current = onClose;

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (prefersReducedMotion()) {
      callbackRef.current();
      return;
    }
    setClosing(true);
  }, []);

  useEffect(() => {
    if (!closing) return undefined;
    const timer = window.setTimeout(() => callbackRef.current(), exitDuration);
    return () => window.clearTimeout(timer);
  }, [closing, exitDuration]);

  return { closing, requestClose };
}
