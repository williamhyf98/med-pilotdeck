// ui/server/services/wsScope.test.js
import { describe, expect, it, vi } from 'vitest';
import { bindConnectionScope, closeUserSockets, runMessageInScope, sendToAdminSockets, SOCKET_ROLE, SOCKET_USER_ID } from './wsScope.js';
import { getUserScope, requireUserScope } from '../middleware/userScope.js';

function fakeSocket(userId, readyState = 1) {
  return {
    [SOCKET_USER_ID]: userId,
    readyState,
    closed: [],
    close(code, reason) { this.closed.push([code, reason]); this.readyState = 3; },
  };
}

describe('bindConnectionScope', () => {
  it('reads the connection\'s own authenticated user', () => {
    expect(bindConnectionScope({ user: { id: 7, role: 'admin' } })).toEqual({ userId: '7', role: 'admin' });
    expect(bindConnectionScope({ user: { userId: 9 } })).toEqual({ userId: '9', role: 'user' });
  });

  it('returns null when the request carries no user, so the caller can refuse', () => {
    expect(bindConnectionScope(undefined)).toBeNull();
    expect(bindConnectionScope({})).toBeNull();
    expect(bindConnectionScope({ user: {} })).toBeNull();
    expect(bindConnectionScope({ user: { id: null } })).toBeNull();
    expect(bindConnectionScope({ user: { id: '  ' } })).toBeNull();
  });
});

describe('runMessageInScope', () => {
  // Review Focus 1: a second connection must never shift the first one's scope.
  it('keeps each listener on its own user while both run concurrently', async () => {
    const seen = { a: [], b: [] };
    let releaseA;
    const blockA = new Promise((resolve) => { releaseA = resolve; });

    const listenerA = runMessageInScope(bindConnectionScope({ user: { id: 1 } }), async () => {
      seen.a.push(requireUserScope().userId);
      await blockA;                      // A yields while B's listener is created and runs
      seen.a.push(requireUserScope().userId);
    });
    const listenerB = runMessageInScope(bindConnectionScope({ user: { id: 2, role: 'admin' } }), async () => {
      seen.b.push(requireUserScope().userId);
      await Promise.resolve();
      seen.b.push(requireUserScope().role);
    });

    const runA = listenerA('{"type":"ping"}');
    const runB = listenerB('{"type":"ping"}');
    await runB;
    releaseA();
    await runA;

    expect(seen.a).toEqual(['1', '1']);   // A never became B
    expect(seen.b).toEqual(['2', 'admin']);
    expect(getUserScope()).toBeUndefined(); // nothing leaks outside the listeners
  });

  it('passes the raw frame through to the handler', async () => {
    const frames = [];
    const listener = runMessageInScope({ userId: '3', role: 'user' }, async (message) => { frames.push(message); });
    await listener('hello');
    expect(frames).toEqual(['hello']);
  });

  it('reports an async handler failure instead of leaving an unhandled rejection', async () => {
    const onError = vi.fn();
    const listener = runMessageInScope({ userId: '3', role: 'user' }, async () => { throw new Error('boom'); }, { onError });
    await expect(listener('x')).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('boom');
  });

  it('reports a synchronous throw too', () => {
    const onError = vi.fn();
    const listener = runMessageInScope({ userId: '3', role: 'user' }, () => { throw new Error('sync boom'); }, { onError });
    expect(() => listener('x')).not.toThrow();
    expect(onError.mock.calls[0][0].message).toBe('sync boom');
  });
});

describe('closeUserSockets', () => {
  it('works independently on the chat set and the aux set', () => {
    const mk = (uid) => ({ readyState: 1, [SOCKET_USER_ID]: uid, close: vi.fn() });
    const chat = new Set([mk(1), mk(2)]); const aux = new Set([mk(2), mk(3)]);
    closeUserSockets(chat, 2); closeUserSockets(aux, 2);
    expect([...chat].map((s) => s.close.mock.calls.length)).toEqual([0, 1]);
    expect([...aux].map((s) => s.close.mock.calls.length)).toEqual([1, 0]);
  });

  // Review Focus 2: revoking B must not disturb A.
  it('closes only the named user\'s open sockets, with 4401 TOKEN_REVOKED', () => {
    const a = fakeSocket(1);
    const b1 = fakeSocket(2);
    const b2 = fakeSocket(2);
    const bClosed = fakeSocket(2, 3);        // already closed
    const bClosing = fakeSocket(2, 2);       // closing
    const anonymous = fakeSocket(null);
    const clients = new Set([a, b1, b2, bClosed, bClosing, anonymous]);

    expect(closeUserSockets(clients, 2)).toBe(2);

    expect(b1.closed).toEqual([[4401, 'TOKEN_REVOKED']]);
    expect(b2.closed).toEqual([[4401, 'TOKEN_REVOKED']]);
    expect(bClosed.closed).toEqual([]);
    expect(bClosing.closed).toEqual([]);
    expect(a.closed).toEqual([]);
    expect(anonymous.closed).toEqual([]);
  });

  it('matches on value, not type, and accepts a custom code', () => {
    const numeric = fakeSocket(4);
    const stringy = fakeSocket('4');
    expect(closeUserSockets([numeric, stringy], '4', { code: 4402, reason: 'USER_DISABLED' })).toBe(2);
    expect(numeric.closed).toEqual([[4402, 'USER_DISABLED']]);
    expect(stringy.closed).toEqual([[4402, 'USER_DISABLED']]);
  });

  it('survives a socket whose close() throws and an empty client set', () => {
    const angry = { [SOCKET_USER_ID]: 5, readyState: 1, close: () => { throw new Error('already gone'); } };
    const ok = fakeSocket(5);
    expect(() => closeUserSockets([angry, ok], 5)).not.toThrow();
    expect(ok.closed).toEqual([[4401, 'TOKEN_REVOKED']]);
    expect(closeUserSockets(new Set(), 5)).toBe(0);
    expect(closeUserSockets(undefined, 5)).toBe(0);
  });
});

describe('sendToAdminSockets', () => {
  const roleSocket = (role, readyState = 1) => ({
    [SOCKET_ROLE]: role,
    readyState,
    sent: [],
    send(message) { this.sent.push(message); },
  });

  it('delivers only to open admin sockets', () => {
    const admin = roleSocket('admin');
    const user = roleSocket('user');
    const closedAdmin = roleSocket('admin', 3);
    expect(sendToAdminSockets([admin, user, closedAdmin], 'payload')).toBe(1);
    expect(admin.sent).toEqual(['payload']);
    expect(user.sent).toEqual([]);
    expect(closedAdmin.sent).toEqual([]);
  });

  it('fails closed for a socket with no recorded role', () => {
    const unknown = { readyState: 1, sent: [], send(m) { this.sent.push(m); } };
    expect(sendToAdminSockets([unknown], 'payload')).toBe(0);
    expect(unknown.sent).toEqual([]);
  });

  it('survives a throwing send and an empty client set', () => {
    const angry = { [SOCKET_ROLE]: 'admin', readyState: 1, send: () => { throw new Error('gone'); } };
    const ok = roleSocket('admin');
    expect(() => sendToAdminSockets([angry, ok], 'payload')).not.toThrow();
    expect(ok.sent).toEqual(['payload']);
    expect(sendToAdminSockets(new Set(), 'payload')).toBe(0);
    expect(sendToAdminSockets(undefined, 'payload')).toBe(0);
  });
});
