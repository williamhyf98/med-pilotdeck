import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

type SetupFormState = {
  username: string;
  password: string;
  confirmPassword: string;
};

const initialState: SetupFormState = {
  username: '',
  password: '',
  confirmPassword: '',
};

/**
 * Validates the account-setup form state.
 * @returns An error message string if validation fails, or `null` when the
 *   form is valid.
 */
function validateSetupForm(
  formState: SetupFormState,
  t: (key: string) => string,
): string | null {
  if (!formState.username.trim() || !formState.password || !formState.confirmPassword) {
    return t('login.errors.requiredFields');
  }

  if (formState.username.trim().length < 3) {
    return 'Username must be at least 3 characters long.';
  }

  if (formState.password.length < 6) {
    return 'Password must be at least 6 characters long.';
  }

  if (formState.password !== formState.confirmPassword) {
    return t('register.errors.passwordMismatch');
  }

  return null;
}

/**
 * Account setup / registration form.
 * Uses `autoComplete="new-password"` on password fields so that password
 * managers recognise this as a registration flow and offer to save the new
 * credentials after submission.
 */
type RegisterFormProps = {
  /** Switches back to the login form. */
  onBack?: () => void;
};

export default function RegisterForm({ onBack }: RegisterFormProps) {
  const { t } = useTranslation('auth');
  const { register, registrationOpen } = useAuth();

  const [formState, setFormState] = useState<SetupFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateField = useCallback((field: keyof SetupFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      const validationError = validateSetupForm(formState, t);
      if (validationError) {
        setErrorMessage(validationError);
        return;
      }

      setIsSubmitting(true);
      const result = await register(formState.username.trim(), formState.password);
      if (!result.success) {
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [formState, register, t],
  );

  return (
    <AuthScreenLayout title={t('register.title')}>
      <form onSubmit={handleSubmit} className="auth-screen__form">
        <AuthInputField
          id="username"
          name="username"
          label={t('register.username')}
          value={formState.username}
          onChange={(value) => updateField('username', value)}
          placeholder={t('login.placeholders.username')}
          isDisabled={isSubmitting}
          autoComplete="username"
          visuallyHiddenLabel
        />

        <AuthInputField
          id="password"
          name="password"
          label={t('register.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('login.placeholders.password')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
          visuallyHiddenLabel
        />

        <AuthInputField
          id="confirmPassword"
          name="confirmPassword"
          label={t('register.confirmPassword')}
          value={formState.confirmPassword}
          onChange={(value) => updateField('confirmPassword', value)}
          placeholder={t('register.confirmPassword')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
          visuallyHiddenLabel
        />

        <AuthErrorAlert errorMessage={errorMessage || (registrationOpen ? '' : t('register.closed'))} />

        <button
          type="submit"
          disabled={isSubmitting || !registrationOpen}
          className="auth-screen__submit"
        >
          {isSubmitting ? t('register.loading') : t('register.submit')}
        </button>

        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="auth-screen__link"
          >
            {t('register.back')}
          </button>
        ) : null}
      </form>
    </AuthScreenLayout>
  );
}
