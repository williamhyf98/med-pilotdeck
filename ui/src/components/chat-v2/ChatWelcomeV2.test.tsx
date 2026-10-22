// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatWelcomeV2 from './ChatWelcomeV2';
import MainContentStateView from '../main-content/view/subcomponents/MainContentStateView';

afterEach(cleanup);

describe('ChatWelcomeV2', () => {
  it('renders exactly the same welcome content for an unselected project and a new conversation', () => {
    const { rerender } = render(<MainContentStateView mode="empty" isMobile={false} onMenuClick={() => {}} />);
    const emptyContent = screen.getByTestId('general-medicine-overview').innerHTML;
    rerender(<ChatWelcomeV2 selectedProject={{ name: 'general_med-clinic', displayName: '通用医学', fullPath: '/ws/clinic', projectType: 'general_medicine' }} composerSlot={null} />);
    expect(screen.getByTestId('general-medicine-overview').innerHTML).toBe(emptyContent);
  });

  it('uses the same branded welcome when no project is selected', () => {
    render(<ChatWelcomeV2 selectedProject={null} composerSlot={null} />);
    expect(screen.getByRole('heading', { name: '通用医学智能助手' })).toBeTruthy();
    expect(screen.getByAltText('通用医学智能助手')).toBeTruthy();
  });

  it('shows the selected workspace welcome and create action when no project exists', () => {
    const onCreateProject = vi.fn();
    const { rerender } = render(
      <MainContentStateView
        mode="empty"
        isMobile={false}
        onMenuClick={() => {}}
        onCreateProject={onCreateProject}
      />,
    );
    expect(screen.getByRole('heading', { name: '通用医学智能助手' })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    rerender(
      <MainContentStateView
        mode="empty"
        workspaceType="war_trauma"
        isMobile={false}
        onMenuClick={() => {}}
        onCreateProject={onCreateProject}
      />,
    );
    expect(screen.getByRole('heading', { name: '战创伤救治推演助手' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '通用医学智能助手' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
    expect(onCreateProject).toHaveBeenCalledOnce();
  });

  it('keeps the trauma introduction and empty workflow when there are no projects', () => {
    const onCreateProject = vi.fn();
    const { rerender } = render(
      <MainContentStateView mode="empty" workspaceType="general_medicine" isMobile={false} onMenuClick={() => {}} onCreateProject={onCreateProject} />,
    );
    expect(screen.getByRole('heading', { name: '通用医学智能助手' })).toBeTruthy();
    rerender(
      <MainContentStateView mode="empty" workspaceType="war_trauma" isMobile={false} onMenuClick={() => {}} onCreateProject={onCreateProject} />,
    );
    expect(screen.getByRole('heading', { name: '战创伤救治推演助手' })).toBeTruthy();
    expect(screen.getByText('分级救治全过程')).toBeTruthy();
    expect(screen.getByText('等待首轮推演')).toBeTruthy();
    expect(screen.getByText('描述伤情')).toBeTruthy();
    expect(screen.queryByTestId('general-medicine-capability-grid')).toBeNull();
    expect(screen.queryByLabelText('本轮伤情自由输入')).toBeNull();
    expect(screen.queryByText(/从下方输入框提交第一轮信息后/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
    expect(onCreateProject).toHaveBeenCalledOnce();
  });

  it('shows the general-medicine capability overview instead of the generic greeting', () => {
    render(
      <ChatWelcomeV2
        selectedProject={{
          name: 'general_med-clinic',
          displayName: '通用医学项目',
          fullPath: '/ws/general_med-clinic',
          projectType: 'general_medicine',
        }}
        composerSlot={<textarea aria-label="医学问题输入框" />}
      />,
    );

    expect(screen.getByRole('heading', { name: '通用医学智能助手' })).toBeTruthy();
    expect(screen.getByAltText('通用医学智能助手')).toBeTruthy();
    expect(screen.getByText('临床分析')).toBeTruthy();
    expect(screen.getByText('医学资料与病例')).toBeTruthy();
    expect(screen.getByText('战创伤支持')).toBeTruthy();
    expect(screen.getByText('文档与展示')).toBeTruthy();
    expect(screen.getByText('解读这份检查报告，整理为结构化病例报告，并导出为PDF。')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '医学问题输入框' })).toBeTruthy();
    expect(screen.queryByText('今天想做点什么？')).toBeNull();
    expect(screen.getByTestId('general-medicine-capability-grid').className).toContain('lg:grid-cols-4');

    const overview = screen.getByTestId('general-medicine-overview');
    const composerDock = screen.getByTestId('general-medicine-composer-dock');
    expect(overview.className).toContain('flex-1');
    expect(composerDock.className).toContain('shrink-0');
    expect(overview.nextElementSibling).toBe(composerDock);
    const centeredLayout = overview.firstElementChild;
    expect(centeredLayout?.classList.contains('pd-welcome-enter')).toBe(false);
    expect(centeredLayout?.firstElementChild?.classList.contains('pd-welcome-enter')).toBe(true);
  });
});
