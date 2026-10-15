import { useTranslation } from "react-i18next";
import { useAuth } from "../../../auth/context/AuthContext";
import { SettingsCard, SettingsRow } from "../../shared/view";
import ChangePasswordForm from "./ChangePasswordForm";

type AccountSettingsProps = {
  title: string;
};

export default function AccountSettings({ title }: AccountSettingsProps) {
  const { t } = useTranslation("sidebar");
  const { t: tAuth } = useTranslation("auth");
  const { user, isAdmin, authDisabled } = useAuth();

  if (!user) return null;

  const roleLabel = authDisabled
    ? t("account.localMode")
    : isAdmin
      ? t("account.roleAdmin")
      : t("account.roleUser");

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
      <SettingsCard>
        <SettingsRow label={t("account.username")}>
          <span className="text-[13px] text-foreground">{user.username}</span>
        </SettingsRow>
        <SettingsRow label={t("account.role")}>
          <span className="text-[13px] text-foreground">{roleLabel}</span>
        </SettingsRow>
      </SettingsCard>
      {authDisabled ? null : (
        <section className="space-y-3">
          <h3 className="text-base font-semibold text-foreground">
            {tAuth("password.title")}
          </h3>
          <ChangePasswordForm />
        </section>
      )}
    </div>
  );
}
