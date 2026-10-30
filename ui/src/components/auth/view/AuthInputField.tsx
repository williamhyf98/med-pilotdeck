import { LockKeyhole, UserRound } from 'lucide-react';

type AuthInputFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (nextValue: string) => void;
  placeholder: string;
  isDisabled: boolean;
  type?: 'text' | 'password' | 'email';
  name?: string;
  autoComplete?: string;
  visuallyHiddenLabel?: boolean;
  icon?: 'account' | 'password';
};

/**
 * A labelled input field for authentication forms.
 * Renders a `<label>` / `<input>` pair and forwards browser autofill hints
 * (`name`, `autoComplete`) so that password managers can identify and fill
 * the field correctly.
 */
export default function AuthInputField({
  id,
  label,
  value,
  onChange,
  placeholder,
  isDisabled,
  type = 'text',
  name,
  autoComplete,
  visuallyHiddenLabel = false,
  icon,
}: AuthInputFieldProps) {
  const Icon = icon === 'account' ? UserRound : icon === 'password' ? LockKeyhole : null;
  return (
    <div className={visuallyHiddenLabel ? 'auth-screen__input-group' : undefined}>
      <label htmlFor={id} className={visuallyHiddenLabel ? 'sr-only' : 'mb-1 block text-sm font-medium text-foreground'}>
        {label}
      </label>
      <div className={Icon ? 'auth-screen__field-wrap' : undefined}>
        {Icon ? <Icon className="auth-screen__field-icon" strokeWidth={1.8} aria-hidden="true" /> : null}
        <input
          id={id}
          type={type}
          name={name ?? id}
          autoComplete={autoComplete}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={visuallyHiddenLabel
            ? 'auth-screen__field'
            : 'w-full rounded-md border border-border bg-background px-3 py-2 text-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500'}
          placeholder={placeholder}
          required
          disabled={isDisabled}
        />
      </div>
    </div>
  );
}
