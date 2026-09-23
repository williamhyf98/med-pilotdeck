import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import SetupForm from './SetupForm';

const { register } = vi.hoisted(() => ({ register: vi.fn().mockResolvedValue({ success: true }) }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ register }) }));

it('passes the operator initialization credential with the first account submission', async () => {
  render(<SetupForm />);
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-password-123' } });
  fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'test-password-123' } });
  fireEvent.change(screen.getByLabelText('初始化令牌'), { target: { value: 'operator-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
  await waitFor(() => expect(register).toHaveBeenCalledWith('admin', 'test-password-123', 'operator-secret'));
});
