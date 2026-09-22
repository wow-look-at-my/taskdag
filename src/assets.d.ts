// HTML is imported as a string: the landing page and the compiled MCP App
// bundle are both build-time text modules (wrangler's Text rule, see
// wrangler.jsonc), which is what keeps the Worker artifact self-contained.
declare module '*.html' {
  const contents: string;
  export default contents;
}

// js-snippets components import their stylesheet as a string (esbuild's
// text loader there, Vite's `?inline` here — see vite.config.ts).
declare module '*.css' {
  const contents: string;
  export default contents;
}
