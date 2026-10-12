import { describe, expect, it } from 'vitest';
import { claimUniqueProjectFileName } from './uniqueProjectFileName.js';

describe('project-wide duplicate filenames', () => {
    it('keeps compound NIfTI and archive extensions intact', () => {
        const used = new Set(['scan.nii.gz', 'archive.tar.gz']);
        expect(claimUniqueProjectFileName(used, 'scan.nii.gz')).toBe('scan(1).nii.gz');
        expect(claimUniqueProjectFileName(used, 'scan.nii.gz')).toBe('scan(2).nii.gz');
        expect(claimUniqueProjectFileName(used, 'archive.tar.gz')).toBe('archive(1).tar.gz');
        expect(claimUniqueProjectFileName(used, 'report.pdf')).toBe('report.pdf');
    });

    it('reserves existing legacy counters without changing existing files', () => {
        const used = new Set(['scan.nii.gz', 'scan.nii(1).gz', 'scan.nii(2).gz']);
        expect(claimUniqueProjectFileName(used, 'scan.nii.gz')).toBe('scan(3).nii.gz');
        expect(claimUniqueProjectFileName(used, 'scan.nii.gz')).toBe('scan(4).nii.gz');
        expect(claimUniqueProjectFileName(used, 'scan.nii(2).gz')).toBe('scan(5).nii.gz');
    });
});
