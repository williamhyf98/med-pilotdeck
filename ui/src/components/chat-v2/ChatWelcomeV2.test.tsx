// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ChatWelcomeV2 from './ChatWelcomeV2';

afterEach(cleanup);

describe('ChatWelcomeV2', () => {
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
  });
});
