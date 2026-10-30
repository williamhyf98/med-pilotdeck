/**
 * Router events (`<pilotHome>/router/events.jsonl`) are a debugging aid. They
 * are written only when `PILOTDECK_ROUTER_DEBUG=1`, so a normal install does
 * not grow a `router/` directory at the system root.
 */
export function shouldWriteRouterEvents(env: Record<string, string | undefined> = process.env): boolean {
  return env.PILOTDECK_ROUTER_DEBUG === "1";
}
