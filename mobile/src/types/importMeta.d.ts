declare global {
  interface ImportMetaEnv {
    readonly DEV?: boolean;
    readonly [key: string]: string | boolean | undefined;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
