// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import NiftiPreview from './NiftiPreview';

const mocks = vi.hoisted(() => {
  const viewport = {
    setStack: vi.fn(async () => undefined),
    render: vi.fn(),
    getCurrentImageIdIndex: vi.fn(() => 1),
    setImageIdIndex: vi.fn(async () => undefined),
    resetCamera: vi.fn(),
    resetProperties: vi.fn(),
  };
  const engine = {
    enableElement: vi.fn(),
    getViewport: vi.fn(() => viewport),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
  const group = {
    addTool: vi.fn(),
    addViewport: vi.fn(),
    setToolActive: vi.fn(),
    setToolPassive: vi.fn(),
  };
  return { viewport, engine, group, createIds: vi.fn(async () => ['nifti:test?frame=0', 'nifti:test?frame=1', 'nifti:test?frame=2']), remove: vi.fn() };
});

vi.mock('@cornerstonejs/core', () => ({
  init: vi.fn(async () => undefined),
  registerImageLoader: vi.fn(),
  RenderingEngine: class { constructor() { return mocks.engine; } },
  Enums: {
    ViewportType: { STACK: 'STACK' },
    Events: { STACK_NEW_IMAGE: 'STACK_NEW_IMAGE' },
    MetadataModules: { IMAGE_PIXEL: 'imagePixelModule' },
  },
  metaData: { get: vi.fn(() => ({ columns: 122, rows: 101 })) },
  cache: {
    getImageLoadObject: vi.fn(() => undefined),
    removeImageLoadObject: mocks.remove,
  },
}));
vi.mock('@cornerstonejs/nifti-volume-loader', () => ({
  init: vi.fn(),
  cornerstoneNiftiImageLoader: vi.fn(),
  createNiftiImageIdsAndCacheMetadata: mocks.createIds,
}));
class WindowLevelTool { static toolName = 'WindowLevel'; }
class PanTool { static toolName = 'Pan'; }
class ZoomTool { static toolName = 'Zoom'; }
class StackScrollTool { static toolName = 'StackScroll'; }
vi.mock('@cornerstonejs/tools', () => ({
  init: vi.fn(async () => undefined),
  addTool: vi.fn(),
  WindowLevelTool, PanTool, ZoomTool, StackScrollTool,
  ToolGroupManager: {
    createToolGroup: vi.fn(() => mocks.group),
    getToolGroup: vi.fn(() => mocks.group),
    destroyToolGroup: vi.fn(),
  },
  Enums: { MouseBindings: { Primary: 1, Wheel: 4 } },
}));
vi.mock('../../../../utils/api', () => ({
  api: {
    niftiPreviewUrl: vi.fn((projectName: string) => `/api/projects/${projectName}/files/content/volume.nii.gz?path=scan.nii.gz`),
    fileDownloadUrl: vi.fn(() => '/download'),
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('loads a 3D stack and navigates its slices', async () => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
  }));
  vi.stubGlobal('fetch', fetchMock);
  const { unmount } = render(
    <NiftiPreview
      projectName="project-id"
      file={{ name: 'scan.nii.gz', path: 'scan.nii.gz', diffInfo: null }}
      isFullscreen={false}
    />,
  );
  expect(await screen.findByText('122 × 101')).not.toBeNull();
  expect(await screen.findByText('2 / 3')).not.toBeNull();
  expect(mocks.viewport.setStack).toHaveBeenCalledWith(
    ['nifti:test?frame=0', 'nifti:test?frame=1', 'nifti:test?frame=2'], 1,
  );
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/api/projects/project-id/files/content/volume.nii.gz'),
    expect.objectContaining({ method: 'HEAD', cache: 'no-store' }),
  );
  fireEvent.click(screen.getByRole('button', { name: '下一层' }));
  expect(mocks.viewport.setImageIdIndex).toHaveBeenCalledWith(2);
  unmount();
  await waitFor(() => expect(mocks.engine.destroy).toHaveBeenCalled());
  vi.unstubAllGlobals();
});

it('shows the server error instead of waiting for the loader timeout', async () => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    json: async () => ({ error: 'File not found', code: 'FILE_NOT_FOUND' }),
  })));

  render(
    <NiftiPreview
      projectName="project-id"
      file={{ name: 'scan.nii.gz', path: 'scan.nii.gz', diffInfo: null }}
      isFullscreen={false}
    />,
  );

  expect(await screen.findByText('File not found')).not.toBeNull();
  expect(mocks.createIds).not.toHaveBeenCalled();
});
