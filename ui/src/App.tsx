import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider, ProtectedRoute, useAuth } from './components/auth';
import { TaskMasterProvider } from './contexts/TaskMasterContext';
import { TasksSettingsProvider } from './contexts/TasksSettingsContext';
import { WebSocketProvider } from './contexts/WebSocketContext';
import { PluginsProvider } from './contexts/PluginsContext';
import { ToastProvider } from './contexts/ToastContext';
import AppShellV2 from './components/app-shell/AppShellV2';
import i18n from './i18n/config.js';

/**
 * Remounts everything below it when the signed-in account changes, so state
 * initialised from the previous user's storage namespace (or fetched with
 * their credentials) cannot leak into the next session on a shared browser.
 */
function UserScope({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return <Fragment key={user ? String(user.id) : 'anon'}>{children}</Fragment>;
}

export default function App() {
  // Single wildcard so URL changes don't remount the shell. Params are
  // resolved inside AppShellV2 via useMatch so navigation between
  // /, /p/:name, /p/:name/c/:id, and /session/:id preserves all state.
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <UserScope>
              <WebSocketProvider>
                <PluginsProvider>
                  <TasksSettingsProvider>
                    <TaskMasterProvider>
                      <ProtectedRoute>
                        <Router basename={window.__ROUTER_BASENAME__ || ''}>
                          <Routes>
                            <Route path="*" element={<AppShellV2 />} />
                          </Routes>
                        </Router>
                      </ProtectedRoute>
                    </TaskMasterProvider>
                  </TasksSettingsProvider>
                </PluginsProvider>
              </WebSocketProvider>
            </UserScope>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
