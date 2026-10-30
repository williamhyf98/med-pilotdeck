import React, { createContext, useContext, useState, useEffect } from 'react';
import { STORAGE_USER_CHANGED_EVENT, safeLocalStorage } from '../utils/safeStorage';

const ThemeContext = createContext();
const THEME_MODE_KEY = 'themeMode';
const LEGACY_THEME_KEY = 'theme';
const PRODUCT_THEMES = new Set(['warm', 'command']);

const normalizeThemeMode = (value) => (
  value === 'light'
  || value === 'dark'
  || value === 'warm'
  || value === 'command'
    ? value
    : null
);

const readInitialThemeMode = () => {
  const storedMode = safeLocalStorage.getItem(THEME_MODE_KEY);
  const savedMode = normalizeThemeMode(storedMode);
  if (savedMode) return savedMode;
  if (storedMode === 'system') return 'warm';

  const legacyTheme = normalizeThemeMode(safeLocalStorage.getItem(LEGACY_THEME_KEY));
  if (legacyTheme) return legacyTheme;

  return 'warm';
};

const resolveThemeMode = (mode) => (
  mode === 'dark' || mode === 'command'
);

// eslint-disable-next-line react-refresh/only-export-components
export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

export const ThemeProvider = ({ children }) => {
  const [themeMode, setThemeMode] = useState(readInitialThemeMode);
  const [isDarkMode, setIsDarkMode] = useState(() => resolveThemeMode(readInitialThemeMode()));

  // The preference lives in the per-user storage namespace; re-read it when
  // the signed-in user (and therefore the namespace) changes.
  useEffect(() => {
    const reload = () => setThemeMode(readInitialThemeMode());
    window.addEventListener(STORAGE_USER_CHANGED_EVENT, reload);
    return () => window.removeEventListener(STORAGE_USER_CHANGED_EVENT, reload);
  }, []);

  // Update document class and localStorage when theme changes
  useEffect(() => {
    const nextIsDark = resolveThemeMode(themeMode);
    setIsDarkMode(nextIsDark);

    if (PRODUCT_THEMES.has(themeMode)) {
      document.documentElement.dataset.theme = themeMode;
    } else {
      document.documentElement.removeAttribute('data-theme');
    }

    if (nextIsDark) {
      document.documentElement.classList.add('dark');

      // Update iOS status bar style and theme color for dark mode
      const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (statusBarMeta) {
        statusBarMeta.setAttribute('content', 'black-translucent');
      }
      
      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) {
        themeColorMeta.setAttribute('content', themeMode === 'command' ? '#0a111f' : '#0c1117');
      }
    } else {
      document.documentElement.classList.remove('dark');
      
      // Update iOS status bar style and theme color for light mode
      const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (statusBarMeta) {
        statusBarMeta.setAttribute('content', 'default');
      }
      
      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) {
        themeColorMeta.setAttribute('content', themeMode === 'warm' ? '#faf8f4' : '#ffffff');
      }
    }

    safeLocalStorage.setItem(THEME_MODE_KEY, themeMode);
    safeLocalStorage.setItem(LEGACY_THEME_KEY, themeMode);
  }, [themeMode]);

  const toggleDarkMode = () => {
    setThemeMode(isDarkMode ? 'light' : 'dark');
  };

  const value = {
    isDarkMode,
    themeMode,
    setThemeMode,
    toggleDarkMode,
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};
