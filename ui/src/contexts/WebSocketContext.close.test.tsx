// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  onopen: any;
  onclose: any;
  onmessage: any;
  onerror: any;
  readyState = 1;
  url: string;
  closeCodes: number[] = [];
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send() {}
  addEventListener() {}
  close(code?: number) {
    this.closeCodes.push(code ?? 1000);
    this.onclose?.({ code: code ?? 1000 });
  }
}

beforeEach(() => {
  FakeWS.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWS);
  vi.resetModules();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('../components/auth/context/AuthContext');
});

const mockAuth = () =>
  vi.doMock('../components/auth/context/AuthContext', () => ({
    useAuth: () => ({ token: 't', user: { id: 1 } }),
  }));

describe('WebSocketContext close codes', () => {
  it('does not reconnect after 4401 and dispatches auth-revoked', async () => {
    mockAuth();
    const events: unknown[] = [];
    const listener = (e: any) => events.push(e.detail);
    window.addEventListener('pilotdeck:auth-revoked', listener);
    const { WebSocketProvider } = await import('./WebSocketContext');
    render(<WebSocketProvider><div /></WebSocketProvider>);
    expect(FakeWS.instances).toHaveLength(1);
    act(() => { FakeWS.instances[0].onclose({ code: 4401, reason: 'TOKEN_REVOKED' }); });
    act(() => { vi.advanceTimersByTime(60_000); });
    window.removeEventListener('pilotdeck:auth-revoked', listener);
    expect(FakeWS.instances).toHaveLength(1);
    expect(events).toEqual([{ code: 'TOKEN_REVOKED' }]);
  });

  it('does not reconnect after 4403 and does not dispatch auth-revoked', async () => {
    mockAuth();
    const events: unknown[] = [];
    const listener = (e: any) => events.push(e.detail);
    window.addEventListener('pilotdeck:auth-revoked', listener);
    const { WebSocketProvider } = await import('./WebSocketContext');
    render(<WebSocketProvider><div /></WebSocketProvider>);
    act(() => { FakeWS.instances[0].onclose({ code: 4403, reason: 'ADMIN_REQUIRED' }); });
    act(() => { vi.advanceTimersByTime(60_000); });
    window.removeEventListener('pilotdeck:auth-revoked', listener);
    expect(FakeWS.instances).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('reconnects with backoff after an ordinary close', async () => {
    mockAuth();
    const { WebSocketProvider } = await import('./WebSocketContext');
    render(<WebSocketProvider><div /></WebSocketProvider>);
    act(() => { FakeWS.instances[0].onclose({ code: 1006 }); });
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(FakeWS.instances).toHaveLength(2);
  });

  it('reconnects with backoff after a 1001 server shutdown', async () => {
    mockAuth();
    const { WebSocketProvider } = await import('./WebSocketContext');
    render(<WebSocketProvider><div /></WebSocketProvider>);
    act(() => { FakeWS.instances[0].onclose({ code: 1001, reason: 'SERVER_SHUTDOWN' }); });
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(FakeWS.instances).toHaveLength(2);
  });

  it('closes with 1000 on pilotdeck:auth-logout and does not reconnect', async () => {
    mockAuth();
    const { WebSocketProvider } = await import('./WebSocketContext');
    render(<WebSocketProvider><div /></WebSocketProvider>);
    const socket = FakeWS.instances[0];
    act(() => { socket.onopen?.(); });
    act(() => { window.dispatchEvent(new Event('pilotdeck:auth-logout')); });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(socket.closeCodes).toEqual([1000]);
    expect(FakeWS.instances).toHaveLength(1);
  });
});
