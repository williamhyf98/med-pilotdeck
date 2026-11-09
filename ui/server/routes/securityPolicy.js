import express from 'express';
import defaultSecurityPolicyService, {
  SecurityPolicyServiceError,
  createSecurityPolicyService,
} from '../services/securityPolicy.js';

function sendError(res, error) {
  if (error instanceof SecurityPolicyServiceError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error?.name === 'PolicyConflictError') {
    return res.status(409).json({
      error: 'Security policy changed elsewhere. Reload before saving.',
      code: 'POLICY_CONFLICT',
    });
  }
  console.error('[security-policy] request failed:', error);
  return res.status(500).json({
    error: error instanceof Error ? error.message : 'Security policy request failed.',
    code: 'SECURITY_POLICY_FAILED',
  });
}

export function createSecurityPolicyRouter({ service = defaultSecurityPolicyService } = {}) {
  const router = express.Router();

  router.get('/services', async (_req, res) => {
    try {
      res.json(await service.getServices());
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/services/:serviceId', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const { revision, expectedRevision, ...changes } = body;
      const result = await service.updateService(req.params.serviceId, {
        ...changes,
        expectedRevision: revision ?? expectedRevision,
      });
      res.json({ success: true, ...result });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/services/:serviceId/test', async (req, res) => {
    try {
      // The service layer intentionally receives only the registered ID. No
      // caller-provided host, port, URL, or protocol is used for probing.
      res.json(await service.testService(req.params.serviceId));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/commands', async (_req, res) => {
    try {
      res.json(await service.getCommands());
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/commands', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const { revision, expectedRevision, policy, ...policyFields } = body;
      res.json({
        success: true,
        ...(await service.updateCommands({
          expectedRevision: revision ?? expectedRevision,
          policy: policy ?? policyFields,
        })),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/reload', async (_req, res) => {
    try {
      res.json({ success: true, ...(await service.reload()) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

export default createSecurityPolicyRouter({
  service: defaultSecurityPolicyService ?? createSecurityPolicyService(),
});
