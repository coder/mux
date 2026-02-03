/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

declare module "*.wav" {
  const src: string;
  export default src;
}
