import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import medAssistantLogo from '../../../assets/med-assistant-logo.png';
import './authScreen.css';

type AuthScreenLayoutProps = {
  title: string;
  children: ReactNode;
};

export default function AuthScreenLayout({ title, children }: AuthScreenLayoutProps) {
  const { t } = useTranslation('auth');
  return (
    <main className="auth-screen">
      <div className="auth-screen__backdrop" aria-hidden="true" />
      <div className="auth-screen__stack">
        <img
          src={medAssistantLogo}
          alt="解放军总医院标识"
          className="auth-screen__logo"
          draggable={false}
        />
        <div className="auth-screen__card">
          <div className="auth-screen__card-content">
            <h1 className="auth-screen__title">{title}</h1>
            {children}
            <p className="auth-screen__assurance">{t('login.assurance')}</p>
          </div>
        </div>
      </div>
    </main>
  );
}
