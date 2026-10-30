// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DicomPreview from './DicomPreview';

const mocks = vi.hoisted(() => {
  const viewport = {
    setStack: vi.fn(async () => undefined),
    render: vi.fn(),
    setImageIdIndex: vi.fn(async () => undefined),
    getCurrentImageIdIndex: vi.fn(() => 0),
    resetProperties: vi.fn(),
    resetCamera: vi.fn(),
  };
  const renderingEngine = {
    enableElement: vi.fn(),
    getViewport: vi.fn(() => viewport),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
  const toolGroup = {
    addTool: vi.fn(),
    addViewport: vi.fn(),
    setToolActive: vi.fn(),
    setToolPassive: vi.fn(),
  };
  return {
    viewport,
    renderingEngine,
    toolGroup,
    createToolGroup: vi.fn(() => toolGroup),
    destroyToolGroup: vi.fn(),
    addFile: vi.fn(() => 'dicomfile:7'),
    removeFile: vi.fn(),
    metadata: vi.fn(),
    file: vi.fn(),
  };
});

vi.mock('@cornerstonejs/core', () => ({
  init: vi.fn(),
  RenderingEngine: class RenderingEngineMock {
    constructor() {
      return mocks.renderingEngine;
    }
  },
  Enums: {
    ViewportType: { STACK: 'STACK' },
    Events: { STACK_NEW_IMAGE: 'CORNERSTONE_STACK_NEW_IMAGE' },
  },
}));

vi.mock('@cornerstonejs/dicom-image-loader', () => ({
  init: vi.fn(),
  wadouri: {
    fileManager: {
      add: mocks.addFile,
      remove: mocks.removeFile,
    },
  },
}));

class WindowLevelTool { static toolName = 'WindowLevel'; }
class PanTool { static toolName = 'Pan'; }
class ZoomTool { static toolName = 'Zoom'; }
class StackScrollTool { static toolName = 'StackScroll'; }

vi.mock('@cornerstonejs/tools', () => ({
  init: vi.fn(),
  addTool: vi.fn(),
  WindowLevelTool,
  PanTool,
  ZoomTool,
  StackScrollTool,
  ToolGroupManager: {
    createToolGroup: mocks.createToolGroup,
    getToolGroup: vi.fn(() => mocks.toolGroup),
    destroyToolGroup: mocks.destroyToolGroup,
  },
  Enums: { MouseBindings: { Primary: 1, Wheel: 4 } },
}));

vi.mock('../../../../utils/api', () => ({
  api: {
    dicomPreviewMetadata: mocks.metadata,
    readFileBlob: mocks.file,
    fileDownloadUrl: (_project: string, path: string) => `/download?path=${encodeURIComponent(path)}`,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: (() => {
    const t = (key: string, options?: { count?: number }) => ({
      'dicomPreview.loading': '正在加载 DICOM 查看器...',
      'dicomPreview.failed': '无法渲染此 DICOM',
      'dicomPreview.retry': '重试',
      'dicomPreview.unknown': '未知',
      'dicomPreview.frameCount': `${options?.count ?? 0} 帧`,
      'dicomPreview.windowLevel': '窗宽 / 窗位',
      'dicomPreview.pan': '平移',
      'dicomPreview.zoom': '缩放',
      'dicomPreview.reset': '重置视图',
      'dicomPreview.refresh': '刷新 DICOM',
      'dicomPreview.previousFrame': '上一帧',
      'dicomPreview.nextFrame': '下一帧',
      'dicomPreview.frameSlider': 'DICOM 帧',
      'actions.download': '下载文件',
      'actions.fullscreen': '全屏',
      'actions.exitFullscreen': '退出全屏',
    } as Record<string, string>)[key] || key;
    return () => ({ t });
  })(),
}));

const file = {
  name: 'chest.dcm',
  path: '/workspace/project/chest.dcm',
  diffInfo: null,
};

function metadataResponse(overrides: Record<string, unknown> = {}, status = 200) {
  return new Response(JSON.stringify({
    ok: status < 400,
    modality: 'CT',
    bodyPart: 'CHEST',
    rows: 512,
    columns: 512,
    totalFrames: 3,
    pixelDataAvailable: true,
    warnings: [],
    ...overrides,
  }), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.metadata.mockResolvedValue(metadataResponse());
  mocks.file.mockResolvedValue(new Response(new TextEncoder().encode('dicom'), { status: 200 }));
});

afterEach(cleanup);

describe('DicomPreview', () => {
  it('renders safe metadata and navigates a multiframe stack', async () => {
    const { unmount } = render(
      <DicomPreview projectName="project" file={file} isFullscreen={false} />,
    );

    expect(await screen.findByText('CHEST')).not.toBeNull();
    expect(screen.getByText('512 x 512')).not.toBeNull();
    expect(screen.getByText('1 / 3')).not.toBeNull();
    expect(mocks.viewport.setStack).toHaveBeenCalledWith([
      'dicomfile:7?frame=1',
      'dicomfile:7?frame=2',
      'dicomfile:7?frame=3',
    ], 0);

    fireEvent.click(screen.getByRole('button', { name: '下一帧' }));
    expect(screen.getByText('2 / 3')).not.toBeNull();
    expect(mocks.viewport.setImageIdIndex).toHaveBeenCalledWith(1);

    fireEvent.change(screen.getByRole('slider', { name: 'DICOM 帧' }), { target: { value: '2' } });
    expect(screen.getByText('3 / 3')).not.toBeNull();
    expect(mocks.viewport.setImageIdIndex).toHaveBeenCalledWith(2);

    unmount();
    await waitFor(() => expect(mocks.renderingEngine.destroy).toHaveBeenCalled());
    expect(mocks.destroyToolGroup).toHaveBeenCalled();
    expect(mocks.removeFile).toHaveBeenCalledWith(7);
  });

  it('keeps safe metadata and download available when pixels cannot be decoded', async () => {
    mocks.metadata.mockResolvedValue(metadataResponse({
      ok: false,
      modality: 'MR',
      bodyPart: 'HEAD',
      totalFrames: 1,
      pixelDataAvailable: false,
      warnings: ['该 DICOM 不包含可渲染的像素数据。'],
    }, 422));

    render(<DicomPreview projectName="project" file={file} isFullscreen={false} />);

    expect(await screen.findByText('无法渲染此 DICOM')).not.toBeNull();
    expect(screen.getByText('MR')).not.toBeNull();
    expect(screen.getByText('HEAD')).not.toBeNull();
    expect(screen.getAllByText('该 DICOM 不包含可渲染的像素数据。').length).toBeGreaterThan(0);
    const links = screen.getAllByRole('link', { name: '下载文件' });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].getAttribute('href')).toContain('%2Fworkspace%2Fproject%2Fchest.dcm');
  });
});
