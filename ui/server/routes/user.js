import express from 'express';
import { userDb } from '../database/db.js';
import { authenticateToken } from '../middleware/auth.js';
import {
  GIT_NAME_MAX,
  ensureUserGitConfigFile,
  isValidGitName,
  writeUserGitConfigFile,
} from '../services/userGitConfig.js';

const router = express.Router();

router.get('/git-config', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const gitConfig = userDb.getGitConfig(userId);
    // Identities saved before `<userHome>/.gitconfig` existed only live in the
    // database row; materialise the file now so this user's commits are signed.
    ensureUserGitConfigFile(userId);

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
      writeUserGitConfigFile(userId, gitName, gitEmail);
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
