/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LN_BACKEND?: 'lnd' | 'cln';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
