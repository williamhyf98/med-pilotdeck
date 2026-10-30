// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoginForm from './LoginForm';

const auth = vi.hoisted(() => ({
  registrationOpen: true,
  sessionEndedCode: null as string | null,
  login: vi.fn(async () => ({ success: true })),
  register: vi.fn(async () => ({ success: true })),
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'login.title': '欢迎登录',
      'login.description': '请使用账号登录医学智能服务系统',
      'login.assurance': '您的账号信息将受到加密保护',
      'login.account': '账号',
      'login.username': '用户名',
      'login.password': '密码',
      'login.placeholders.username': '输入您的用户名',
      'login.placeholders.password': '输入您的密码',
      'login.submit': '登录',
      'login.registerLink': '注册新账号',
      'register.title': '创建账户',
      'register.confirmPassword': '确认密码',
      'register.username': '用户名',
      'register.password': '密码',
      'register.back': '返回登录',
      'register.submit': '创建账户',
    } as Record<string, string>)[key] || key,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  auth.registrationOpen = true;
  auth.sessionEndedCode = null;
});

describe('hospital sign-in form', () => {
  it('keeps the form accessible with visually hidden labels and submits credentials', async () => {
    render(<LoginForm />);
    expect(screen.getByRole('heading', { name: '欢迎登录' })).toBeTruthy();
    expect(screen.getByText('请使用账号登录医学智能服务系统')).toBeTruthy();
    expect(screen.getByText('您的账号信息将受到加密保护')).toBeTruthy();
    const logo = screen.getByAltText('解放军总医院标识');
    expect(logo.parentElement?.classList.contains('auth-screen__stack')).toBe(true);
    expect(logo.closest('.auth-screen__card')).toBeNull();
    expect(screen.getByLabelText('用户名')).toBeTruthy();
    expect(screen.getByLabelText('密码')).toBeTruthy();
    expect(screen.queryByText('获取验证码')).toBeNull();
    expect(screen.queryByText('忘记密码')).toBeNull();
    expect(screen.queryByText('医护人员入口')).toBeNull();
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'doctor' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(auth.login).toHaveBeenCalledWith('doctor', 'password'));
  });

  it('uses the same hospital layout for registration and returns to sign in', () => {
    render(<LoginForm />);
    fireEvent.click(screen.getByRole('button', { name: '注册新账号' }));
    expect(screen.getByRole('heading', { name: '创建账户' })).toBeTruthy();
    expect(screen.getByAltText('解放军总医院标识').closest('.auth-screen__card')).toBeNull();
    expect(screen.getByLabelText('确认密码')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回登录' }));
    expect(screen.getByRole('heading', { name: '欢迎登录' })).toBeTruthy();
  });

  it('does not offer registration when it is closed', () => {
    auth.registrationOpen = false;
    render(<LoginForm />);
    expect(screen.queryByRole('button', { name: '注册新账号' })).toBeNull();
  });
});
