/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

// Allow importing .md files as raw text (used for built-in agent definitions)
// esbuild bundles these with --loader:.md=text
declare module "*.md" {
  const content: string;
  export default content;
}
