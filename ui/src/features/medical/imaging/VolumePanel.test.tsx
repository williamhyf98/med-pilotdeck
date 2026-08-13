import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VolumePanel from './VolumePanel';

const apiMocks = vi.hoisted(() => ({
  listVolumes: vi.fn(),
  getVolume: vi.fn(),
  getVolumeSlice: vi.fn(),
  uploadVolume: vi.fn(),
  deleteVolume: vi.fn(),
}));

vi.mock('./imagingApi', () => ({
  listVolumes: apiMocks.listVolumes,
  getVolume: apiMocks.getVolume,
  getVolumeSlice: apiMocks.getVolumeSlice,
  uploadVolume: apiMocks.uploadVolume,
  deleteVolume: apiMocks.deleteVolume,
  isUnavailableError: () => false,
}));

describe('VolumePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  it('shows the backend empty state when no Volume exists', async () => {
    apiMocks.listVolumes.mockResolvedValue({
      available: true,
      storage: 'temporary',
      volumes: [],
    });

    render(<VolumePanel />);

    expect(await screen.findByText('后端当前没有 Volume。')).toBeTruthy();
    expect(screen.getByText('存储模式：temporary')).toBeTruthy();
  });

  it('shows unavailable instead of an empty or successful list', async () => {
    apiMocks.listVolumes.mockResolvedValue({
      available: false,
      reason: 'feature_disabled',
      volumes: [],
    });

    render(<VolumePanel />);

    expect(await screen.findByText('Volume 不可用：功能未启用')).toBeTruthy();
    expect(screen.queryByText('后端当前没有 Volume。')).toBeNull();
    expect(
      (screen.getByRole('button', { name: '上传到 TTL Volume 存储' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
