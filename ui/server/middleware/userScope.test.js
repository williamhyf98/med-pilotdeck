import { describe, expect, it, vi } from 'vitest';
import { runWithUserScope, getUserScope, requireUserScope, userScopeMiddleware } from './userScope.js';

describe('userScope', () => {
  it('exposes the scope inside run and across awaits', async () => {
    await runWithUserScope({ userId: 7, role: 'user' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(requireUserScope()).toEqual({ userId: '7', role: 'user' });
    });
  });
  it('is empty outside run and requireUserScope throws', () => {
    expect(getUserScope()).toBeUndefined();
    expect(() => requireUserScope()).toThrowError(expect.objectContaining({ code: 'USER_SCOPE_MISSING' }));
  });
  it('keeps concurrent scopes apart', async () => {
    const seen = [];
    await Promise.all([
      runWithUserScope({ userId: 1, role: 'user' }, async () => { await new Promise((r) => setTimeout(r, 5)); seen.push(requireUserScope().userId); }),
      runWithUserScope({ userId: 2, role: 'user' }, async () => { seen.push(requireUserScope().userId); }),
    ]);
    expect(seen.sort()).toEqual(['1', '2']);
  });
  it('middleware enters scope from req.user and 500s without it', () => {
    const next = vi.fn(() => { expect(requireUserScope().userId).toBe('3'); });
    userScopeMiddleware({ user: { id: 3, role: 'admin' } }, {}, next);
    expect(next).toHaveBeenCalled();
    const res = { status: vi.fn(() => res), json: vi.fn() };
    userScopeMiddleware({}, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'USER_SCOPE_MISSING' }));
  });
});
