/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IS_PLATFORM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
