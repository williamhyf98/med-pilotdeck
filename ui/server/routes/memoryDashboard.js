// ui/server/routes/memoryDashboard.js
// Serves the embedded Memory Dashboard (the iframe behind the 记忆 tab).
//
// Only the HTML document is authenticated: MemoryPanel puts the session token
// in the iframe URL (?token=) and the dashboard's own JS forwards it as a
// Bearer header on every /api/memory call. The static JS/CSS is public
// frontend code and is served without a token: a <script type="module">'s
// nested `import`s carry neither a header nor the document's query string
// (their Referer is the importing module), so the old trick of recovering the
// token from the Referer broke the moment the dashboard was split into
// modules — the page rendered as an empty skeleton.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

const NO_CACHE = (res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
};

/**
 * @param {{ dir: string, requireUser: import('express').RequestHandler[] }} options
 */
export function buildMemoryDashboardRouter({ dir, requireUser }) {
  const router = express.Router();

  const sendIndex = (_req, res) => {
    const indexPath = path.join(dir, 'index.html');
    if (!fs.existsSync(indexPath)) {
      res.status(404).type('text/plain').send('Memory dashboard assets not bundled.');
      return;
    }
    NO_CACHE(res);
    res.sendFile(indexPath);
  };

  // The document (bare path or index.html) needs a session.
  router.get(['/', '/index.html'], ...requireUser, sendIndex);
  // Any other HTML under the dashboard is a document too: authenticate, then let static serve it.
  router.get(/\.html$/i, ...requireUser, (_req, _res, next) => next());

  // Public static assets. `index: false` so a bare directory request never
  // bypasses the authenticated handler above.
  router.use(express.static(dir, {
    index: false,
    dotfiles: 'ignore',
    setHeaders: (res, filePath) => { if (filePath.endsWith('.html')) NO_CACHE(res); },
  }));

  // Hard 404 boundary: anything still asking for /memory-dashboard/* after the
  // static middleware is a missing asset. Without this, the request would fall
  // through to the SPA wildcard and return the PilotDeck shell index.html,
  // which the MemoryPanel iframe then renders — recursively nesting the entire
  // app inside itself (see bug: "嵌套显示 + general memory 多次出现").
  router.use((_req, res) => {
    res.status(404).type('text/plain').send('Not found in memory-dashboard.');
  });

  return router;
}
