// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const changePassword = vi.fn<(a: string, b: string) => Promise<any>>(async () => ({ success: true }));
vi.mock('../../../auth/context/AuthContext', () => ({ useAuth: () => ({ changePassword }) }));

import ChangePasswordForm from './ChangePasswordForm';

afterEach(() => {
  cleanup();
  changePassword.mockReset();
  changePassword.mockImplementation(async () => ({ success: true }));
});

const fill = (current: string, next: string, confirm: string) => {
  fireEvent.change(screen.getByLabelText('password.current'), { target: { value: current } });
  fireEvent.change(screen.getByLabelText('password.new'), { target: { value: next } });
  fireEvent.change(screen.getByLabelText('password.confirm'), { target: { value: confirm } });
};

describe('ChangePasswordForm', () => {
  it('validates confirmation and submits', async () => {
    render(<ChangePasswordForm />);
    fill('old1234', 'new12345', 'different');
    fireEvent.click(screen.getByRole('button', { name: 'password.submit' }));
    expect(changePassword).not.toHaveBeenCalled();
    expect(screen.getByText('register.errors.passwordMismatch')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('password.confirm'), { target: { value: 'new12345' } });
    fireEvent.click(screen.getByRole('button', { name: 'password.submit' }));
    await waitFor(() => expect(changePassword).toHaveBeenCalledWith('old1234', 'new12345'));
    expect(await screen.findByText('password.success')).toBeTruthy();
    expect((screen.getByLabelText('password.current') as HTMLInputElement).value).toBe('');
  });

  it('rejects a new password shorter than 6 characters', () => {
    render(<ChangePasswordForm />);
    fill('old1234', '12345', '12345');
    fireEvent.click(screen.getByRole('button', { name: 'password.submit' }));
    expect(changePassword).not.toHaveBeenCalled();
    expect(screen.getByText('password.errors.tooShort')).toBeTruthy();
  });

  it('shows the server error and no success message on failure', async () => {
    changePassword.mockResolvedValueOnce({ success: false, error: 'Wrong current password' });
    render(<ChangePasswordForm />);
    fill('old1234', 'new12345', 'new12345');
    fireEvent.click(screen.getByRole('button', { name: 'password.submit' }));
    expect(await screen.findByText('Wrong current password')).toBeTruthy();
    expect(screen.queryByText('password.success')).toBeNull();
  });
});
