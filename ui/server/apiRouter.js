// ui/server/apiRouter.js
//
// The /api mount table. It lives here rather than in index.js for one reason:
// index.js boots a server, spawns watchers and opens a PTY host at import
// time, so the authentication chain of every endpoint was untestable. Here it
// is a pure function of its middleware, and `adminGating.test.js` asserts the
// whole matrix.
//
// Three chains exist, and every mount must use one of them deliberately:
//
//   requireUser       authenticated, scoped to that user's home. Per-user data.
//   requireAdminChain the same, plus `requireAdmin`. Anything that reads or
//                     writes *system* configuration: pilotdeck.yaml, MCP
//                     servers, plugins, the gateway, self-update, the router
//                     dashboard, host-filesystem browsing. In no-login mode
//                     `authenticateToken` resolves to the admin account, so
//                     this chain is a no-op there — by design.
//   (none)            `/auth`, which must be reachable to log in, and
//                     `/agent`, which carries its own API-key middleware.
//
// Handlers that still close over index.js module state are passed in as
// `inline` rather than moved, so this file only owns the mounting.
import express from 'express';

import authRoutes from './routes/auth.js';
import { createAdminUsersRouter } from './routes/adminUsers.js';
import projectsRoutes from './routes/projects.js';
import gitRoutes from './routes/git.js';
import mcpRoutes from './routes/mcp.js';
import taskmasterRoutes from './routes/taskmaster.js';
import memoryRoutes from './routes/memory.js';
import mcpUtilsRoutes from './routes/mcp-utils.js';
import commandsRoutes from './routes/commands.js';
import skillsRoutes from './routes/skills.js';
import storageRoutes from './routes/storage.js';
import settingsRoutes from './routes/settings.js';
import configRoutes from './routes/config.js';
import gatewayRoutes from './routes/gateway.js';
import userRoutes from './routes/user.js';
import pluginsRoutes from './routes/plugins.js';
import messagesRoutes from './routes/messages.js';
import agentRoutes from './routes/agent.js';
import updateRoutes from './routes/update.js';

/**
 * Inline handlers index.js hands over, with the chain each is mounted behind.
 * Declared as data so a missing handler is a loud startup error instead of a
 * silently unmounted — or worse, silently ungated — endpoint.
 */
const INLINE_ROUTES = [
  // Per-user.
  ['get', '/agents/runtime-config', 'user', 'agentsRuntimeConfig'],
  // System configuration / host filesystem: administrators only.
  ['get', '/ccr/dashboard', 'admin', 'ccrDashboard'],
  ['get', '/ccr/health', 'admin', 'ccrHealth'],
  ['get', '/ccr/config', 'admin', 'ccrConfig'],
  ['get', '/ccr/stats/summary', 'admin', 'ccrStatsSummary'],
  ['get', '/ccr/stats/sessions/:sessionId', 'admin', 'ccrSessionStats'],
  ['post', '/ccr/stats/reset', 'admin', 'ccrStatsReset'],
  ['put', '/ccr/config', 'admin', 'ccrConfigPut'],
  ['get', '/browse-filesystem', 'admin', 'browseFilesystem'],
  ['post', '/create-folder', 'admin', 'createFolder'],
  ['post', '/projects/create', 'admin', 'createProjectManual'],
];

export function buildApiRouter({
  authenticateToken,
  userScopeMiddleware,
  requireAdmin,
  onUserRevoked = () => {},
  stopUserRuntime = async () => {},
  inline = {},
}) {
  const api = express.Router();
  const requireUser = [authenticateToken, userScopeMiddleware];
  const requireAdminChain = [authenticateToken, userScopeMiddleware, requireAdmin];

  // Public: logging in cannot require being logged in.
  api.use('/auth', authRoutes);

  // ── System administration ─────────────────────────────────────────────
  api.use('/admin', ...requireAdminChain, createAdminUsersRouter({ onUserRevoked, stopUserRuntime }));
  // pilotdeck.yaml holds every provider API key; MCP/gateway/update change what
  // the server runs. None of it is per-user data.
  api.use('/config', ...requireAdminChain, configRoutes);
  api.use('/mcp', ...requireAdminChain, mcpRoutes);
  api.use('/mcp-utils', ...requireAdminChain, mcpUtilsRoutes);
  api.use('/gateway', ...requireAdminChain, gatewayRoutes);
  api.use('/update', ...requireAdminChain, updateRoutes);

  // ── Per-user surfaces ─────────────────────────────────────────────────
  api.use('/projects', ...requireUser, projectsRoutes);
  api.use('/git', ...requireUser, gitRoutes);
  api.use('/taskmaster', ...requireUser, taskmasterRoutes);
  // `POST /memory/settings` is global and carries its own `requireAdmin`;
  // GET answers everyone but strips policy fields for non-admins.
  api.use('/memory', ...requireUser, memoryRoutes);
  api.use('/commands', ...requireUser, commandsRoutes);
  api.use('/skills', ...requireUser, skillsRoutes);
  api.use('/storage', ...requireUser, storageRoutes);
  api.use('/settings', ...requireUser, settingsRoutes);
  api.use('/user', ...requireUser, userRoutes);
  // Reads stay open; install/update/enable/delete carry `requireAdmin` inside.
  api.use('/plugins', ...requireUser, pluginsRoutes);
  api.use('/sessions', ...requireUser, messagesRoutes);

  // Agent API: authenticated by API key inside the router, not by JWT.
  api.use('/agent', agentRoutes);

  // ── Inline handlers owned by index.js ─────────────────────────────────
  // Registered after the prefix mounts so the original resolution order is
  // preserved (notably `POST /projects/create`, which must stay behind the
  // `/projects` router the way it was in index.js).
  const missing = INLINE_ROUTES.filter(([, , , key]) => typeof inline[key] !== 'function').map(([, , , key]) => key);
  if (missing.length > 0) {
    throw new Error(`buildApiRouter: missing inline handler(s): ${missing.join(', ')}`);
  }
  for (const [method, routePath, chain, key] of INLINE_ROUTES) {
    api[method](routePath, ...(chain === 'admin' ? requireAdminChain : requireUser), inline[key]);
  }

  return api;
}

export const API_INLINE_ROUTES = INLINE_ROUTES;
