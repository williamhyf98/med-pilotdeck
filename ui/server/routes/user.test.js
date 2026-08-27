import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('user onboarding status route', () => {
  it('always reports onboarding complete (LLM setup UI removed)', async () => {
    const { request } = await createUserApp();

    const data = await request('/api/user/onboarding-status');

    expect(data).toMatchObject({
      success: true,
      hasCompletedOnboarding: true,
    });
  });
});

async function createUserApp() {
  vi.doMock('../middleware/auth.js', () => ({
    authenticateToken: (_req, _res, next) => next(),
  }));
  vi.doMock('../database/db.js', () => ({
    userDb: {
      getGitConfig: () => null,
      updateGitConfig: () => undefined,
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
  }));
  vi.doMock('../utils/gitConfig.js', () => ({
    getSystemGitConfig: async () => ({ git_name: '', git_email: '' }),
  }));

  const { default: userRouter } = await import('./user.js');
  const app = express();
  app.use(express.json());
  app.use('/api/user', userRouter);

  return {
    async request(path) {
      const server = app.listen(0);
      const { port } = server.address();
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          headers: { Authorization: 'Bearer test' },
        });
        return response.json();
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
