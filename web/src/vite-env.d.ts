/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Trust HTTP API origin (no trailing slash), e.g. https://api.trust.dance — omit for same-origin as the web app. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
