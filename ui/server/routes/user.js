import express from 'express';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { userDb } from '../database/db.js';
import { authenticateToken } from '../middleware/auth.js';
import { resolveScopedHome } from '../utils/pilotPaths.js';

const router = express.Router();

// A user's git identity is theirs alone. Before multi-user it was applied with
// `git config --global`, which wrote the *server account's* identity — so the
// last person to save it signed everyone else's commits. It now lives in the
// `users` row plus `<userHome>/.gitconfig`, which each user's gateway child
// process picks up through `GIT_CONFIG_GLOBAL` (see services/gatewayPool.js).
// `.gitconfig` is an INI-like format: a bare `\n[core]\n` or a `#` in the value
// would let a user append sections (e.g. `[core] sshCommand = …`) to a file
// their own gateway then reads. Reject the characters that could start one,
// and still write the value quoted so nothing else can be misread.
const GIT_NAME_MAX = 128;
const GIT_NAME_FORBIDDEN = /[\r\n\[\]#;]/;

function isValidGitName(value) {
  return typeof value === 'string'
    && value.length <= GIT_NAME_MAX
    && !GIT_NAME_FORBIDDEN.test(value);
}

/** git's own quoting: a double-quoted value with `\` and `"` backslash-escaped. */
function quoteGitValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderGitConfig(gitName, gitEmail) {
  return `[user]\n\tname = ${quoteGitValue(gitName)}\n\temail = ${quoteGitValue(gitEmail)}\n`;
}

router.get('/git-config', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const gitConfig = userDb.getGitConfig(userId);

    // No fallback to the host's global git identity: that is the operator's
    // name and email, not this user's, and leaking it is both wrong and a
    // small disclosure of who runs the server.
    res.json({
      success: true,
      gitName: gitConfig?.git_name || '',
      gitEmail: gitConfig?.git_email || '',
    });
  } catch (error) {
    console.error('Error getting git config:', error);
    res.status(500).json({ error: 'Failed to get git configuration' });
  }
});

router.post('/git-config', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { gitName, gitEmail } = req.body;

    if (!gitName || !gitEmail) {
      return res.status(400).json({ error: 'Git name and email are required' });
    }

    // Validate email format. The regex already rules out newlines, brackets and
    // `#` in the address, so the name is the only free-form field.
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(gitEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (!isValidGitName(gitName)) {
      return res.status(400).json({
        error: `Git name must be at most ${GIT_NAME_MAX} characters and must not contain line breaks or any of [ ] # ;`,
        code: 'INVALID_GIT_NAME',
      });
    }

    userDb.updateGitConfig(userId, gitName, gitEmail);

    try {
      const home = resolveScopedHome();
      await fsPromises.mkdir(home, { recursive: true });
      await fsPromises.writeFile(path.join(home, '.gitconfig'), renderGitConfig(gitName, gitEmail), 'utf8');
    } catch (writeError) {
      console.error('Error writing per-user .gitconfig:', writeError);
    }

    res.json({
      success: true,
      gitName,
      gitEmail
    });
  } catch (error) {
    console.error('Error updating git config:', error);
    res.status(500).json({ error: 'Failed to update git configuration' });
  }
});

router.post('/complete-onboarding', authenticateToken, async (_req, res) => {
  // Kept for API compatibility; LLM onboarding UI has been removed.
  res.json({
    success: true,
    message: 'Onboarding is no longer required',
  });
});

router.get('/onboarding-status', authenticateToken, async (_req, res) => {
  // LLM provider setup is preconfigured via pilotdeck.yaml + start-local LLM_CHECK.
  res.json({
    success: true,
    hasCompletedOnboarding: true,
  });
});

export default router;
