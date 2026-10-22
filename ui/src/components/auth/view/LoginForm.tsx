import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';
import RegisterForm from './RegisterForm';

type LoginFormState = {
  username: string;
  password: string;
};

const initialState: LoginFormState = {
  username: '',
  password: '',
};

/**
 * Login form component.
 * Handles credential input with browser autofill support (`autocomplete`
 * attributes) so that password managers can offer to fill saved credentials.
 */
export default function LoginForm() {
  const { t } = useTranslation('auth');
  const { login, registrationOpen, sessionEndedCode } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');

  const [formState, setFormState] = useState<LoginFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateField = useCallback((field: keyof LoginFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      // Keep form validation local so each auth screen owns its own UI feedback.
      if (!formState.username.trim() || !formState.password) {
        setErrorMessage(t('login.errors.requiredFields'));
        return;
      }

      setIsSubmitting(true);
      const result = await login(formState.username.trim(), formState.password);
      if (!result.success) {
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [formState.password, formState.username, login, t],
  );

  if (mode === 'register') {
    return <RegisterForm onBack={() => setMode('login')} />;
  }

  const sessionNotice =
    sessionEndedCode === 'USER_DISABLED'
      ? t('errors.disabled')
      : sessionEndedCode
        ? t('errors.revoked')
        : '';

  return (
    <AuthScreenLayout title={t('login.title')}>
      <form onSubmit={handleSubmit} className="auth-screen__form">
        <p className="auth-screen__description">{t('login.description')}</p>
        <AuthInputField
          id="username"
          label={t('login.username')}
          value={formState.username}
          onChange={(value) => updateField('username', value)}
          placeholder={t('login.account')}
          isDisabled={isSubmitting}
          autoComplete="username"
          visuallyHiddenLabel
        />

        <AuthInputField
          id="password"
          label={t('login.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('login.password')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="current-password"
          visuallyHiddenLabel
        />

        <AuthErrorAlert errorMessage={errorMessage || sessionNotice} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="auth-screen__submit"
        >
          {isSubmitting ? t('login.loading') : t('login.submit')}
        </button>

        {registrationOpen ? (
          <button
            type="button"
            onClick={() => setMode('register')}
            className="auth-screen__link"
          >
            {t('login.registerLink')}
          </button>
        ) : null}
      </form>
    </AuthScreenLayout>
  );
}
