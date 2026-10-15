import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../../auth/context/AuthContext";
import AuthInputField from "../../../auth/view/AuthInputField";

const MIN_PASSWORD_LENGTH = 6;

export default function ChangePasswordForm() {
  const { t } = useTranslation("auth");
  const { changePassword } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError("");
      setSuccess(false);

      if (next.length < MIN_PASSWORD_LENGTH) {
        setError(t("password.errors.tooShort"));
        return;
      }
      if (next !== confirm) {
        setError(t("register.errors.passwordMismatch"));
        return;
      }

      setSubmitting(true);
      try {
        // The session stays alive: the auth context adopts the fresh token the
        // server issues and expects the self-inflicted revoke of the old one.
        const result = await changePassword(current, next);
        if (result.success) {
          setSuccess(true);
          setCurrent("");
          setNext("");
          setConfirm("");
        } else {
          setError(result.error);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [changePassword, confirm, current, next, t],
  );

  return (
    <form onSubmit={handleSubmit} className="max-w-md space-y-4">
      <AuthInputField
        id="current-password"
        label={t("password.current")}
        type="password"
        value={current}
        onChange={setCurrent}
        placeholder=""
        isDisabled={submitting}
        autoComplete="current-password"
      />
      <AuthInputField
        id="new-password"
        label={t("password.new")}
        type="password"
        value={next}
        onChange={setNext}
        placeholder=""
        isDisabled={submitting}
        autoComplete="new-password"
      />
      <AuthInputField
        id="confirm-password"
        label={t("password.confirm")}
        type="password"
        value={confirm}
        onChange={setConfirm}
        placeholder=""
        isDisabled={submitting}
        autoComplete="new-password"
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {success ? (
        <p role="status" className="text-sm text-green-600 dark:text-green-400">
          {t("password.success")}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={submitting}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {t("password.submit")}
      </button>
    </form>
  );
}
