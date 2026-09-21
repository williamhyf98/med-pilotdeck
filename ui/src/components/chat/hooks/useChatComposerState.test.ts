import { describe, expect, it } from 'vitest';
import {
  acquireAttachmentSubmission,
  attachmentSubmissionKey,
  shouldCycleRunModeOnKeyDown,
} from './useChatComposerState';

function keyEvent(key: string, shiftKey = false) {
  return { key, shiftKey };
}

describe('useChatComposerState keyboard shortcuts', () => {
  it('uses Shift+Tab to cycle run mode when no completion menu is open', () => {
    expect(shouldCycleRunModeOnKeyDown(keyEvent('Tab', true), {
      showFileDropdown: false,
      showCommandMenu: false,
    })).toBe(true);
  });

  it('does not cycle run mode for plain Tab or while menus are open', () => {
    expect(shouldCycleRunModeOnKeyDown(keyEvent('Tab'), {
      showFileDropdown: false,
      showCommandMenu: false,
    })).toBe(false);
    expect(shouldCycleRunModeOnKeyDown(keyEvent('Tab', true), {
      showFileDropdown: true,
      showCommandMenu: false,
    })).toBe(false);
    expect(shouldCycleRunModeOnKeyDown(keyEvent('Tab', true), {
      showFileDropdown: false,
      showCommandMenu: true,
    })).toBe(false);
  });
});

describe('attachment submission lock', () => {
  it('blocks the same upload across composer instances until the owner releases it', () => {
    const file = { name: 'study.dcm', size: 4096, lastModified: 1234 };
    const key = attachmentSubmissionKey('general_med', '  分析   CT  ', [file]);
    const equivalentKey = attachmentSubmissionKey('general_med', '分析 CT', [file]);

    const release = acquireAttachmentSubmission(key);
    expect(release).not.toBeNull();
    expect(acquireAttachmentSubmission(equivalentKey)).toBeNull();

    release?.();
    const releaseAgain = acquireAttachmentSubmission(equivalentKey);
    expect(releaseAgain).not.toBeNull();
    releaseAgain?.();
  });

  it('does not collide for different file metadata', () => {
    const firstKey = attachmentSubmissionKey('general_med', '分析', [
      { name: 'study.dcm', size: 4096, lastModified: 1234 },
    ]);
    const secondKey = attachmentSubmissionKey('general_med', '分析', [
      { name: 'study.dcm', size: 8192, lastModified: 1234 },
    ]);
    const releaseFirst = acquireAttachmentSubmission(firstKey);
    const releaseSecond = acquireAttachmentSubmission(secondKey);

    expect(releaseFirst).not.toBeNull();
    expect(releaseSecond).not.toBeNull();
    releaseFirst?.();
    releaseSecond?.();
  });
});
