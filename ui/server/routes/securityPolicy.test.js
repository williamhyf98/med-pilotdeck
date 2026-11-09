import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createSecurityPolicyRouter } from './securityPolicy.js';

async function withApp(service, callback, role = 'admin') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1, role };
    next();
  });
  app.use('/api/security-policy', createSecurityPolicyRouter({ service }));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    return await callback(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('security policy routes', () => {
  it('returns services and protects route behavior with the existing admin mount', async () => {
    const service = {
      getServices: vi.fn(async () => ({
        services: [],
        commandRevision: 'commands-1',
        networkRevision: 'network-1',
      })),
    };
    await withApp(service, async (base) => {
      const response = await fetch(`${base}/api/security-policy/services`);
      expect(response.status).toBe(200);
      expect((await response.json()).networkRevision).toBe('network-1');
    });
  });

  it('maps revision conflicts and validation failures to stable API errors', async () => {
    const conflict = Object.assign(new Error('stale'), {
      code: 'POLICY_CONFLICT',
      name: 'PolicyConflictError',
    });
    const service = {
      updateService: vi.fn(async () => { throw conflict; }),
    };
    await withApp(service, async (base) => {
      const response = await fetch(`${base}/api/security-policy/services/model.local`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: 'old',
          host: '127.0.0.2',
          port: 19001,
          protocol: 'http',
        }),
      });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe('POLICY_CONFLICT');
    });
  });

  it('does not expose security policy routes to non-admin callers when mounted with requireAdmin', async () => {
    const service = { getServices: vi.fn() };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: 2, role: 'user' };
      if (req.user.role !== 'admin') {
        res.status(403).json({ code: 'ADMIN_REQUIRED' });
        return;
      }
      next();
    });
    app.use('/api/security-policy', createSecurityPolicyRouter({ service }));
    const server = app.listen(0);
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/security-policy/services`,
      );
      expect(response.status).toBe(403);
      expect(service.getServices).not.toHaveBeenCalled();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
