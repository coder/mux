/**
 * Canonical Xum logo geometry.
 *
 * The square mark uses four sturdy ribbons converging on an open center: parallel
 * agent workflows meeting in one shared workspace. The broken-X silhouette is
 * cursor-free, remains recognizable at favicon scale, and inverts as one color.
 */

const XUM_MARK_PATH =
  "M10 17 21 6 36 21 25 32ZM51 6 62 17 47 32 36 21ZM47 32 62 47 51 58 36 43ZM25 32 36 43 21 58 10 47Z";

const XUM_WORDMARK_PATH =
  "M2.208 48 11.376 34.944 2.448 22.272H10.08L15.6 30.528L20.928 22.272H28.752L19.872 34.992L28.992 48H21.36L15.696 39.264L9.984 48H2.208ZM41.856 48.576C39.2 48.576 37.12 47.728 35.616 46.032C34.144 44.304 33.408 41.904 33.408 38.832V22.272H40.608V37.152C40.608 39.136 40.912 40.592 41.52 41.52C42.128 42.416 43.088 42.864 44.4 42.864C45.872 42.864 47.008 42.368 47.808 41.376C48.64 40.352 49.056 38.832 49.056 36.816V22.272H56.256V48H49.68L49.488 40.608L50.4 40.8C50.016 43.36 49.104 45.296 47.664 46.608C46.224 47.92 44.288 48.576 41.856 48.576ZM62.544 48V22.272H69.024L69.264 28.464L68.592 28.176C68.944 26.8 69.472 25.632 70.176 24.672C70.912 23.712 71.792 22.976 72.816 22.464C73.84 21.952 74.96 21.696 76.176 21.696C78.32 21.696 80.048 22.32 81.36 23.568C82.704 24.816 83.568 26.496 83.952 28.608L83.04 28.656C83.328 27.152 83.824 25.888 84.528 24.864C85.264 23.808 86.16 23.024 87.216 22.512C88.272 21.968 89.456 21.696 90.768 21.696C92.56 21.696 94.096 22.064 95.376 22.8C96.656 23.536 97.648 24.64 98.352 26.112C99.056 27.552 99.408 29.328 99.408 31.44V48H92.208V33.456C92.208 31.44 91.904 29.936 91.296 28.944C90.688 27.92 89.696 27.408 88.32 27.408C87.456 27.408 86.72 27.648 86.112 28.128C85.504 28.608 85.024 29.312 84.672 30.24C84.352 31.136 84.192 32.24 84.192 33.552V48H77.712V33.552C77.712 31.568 77.424 30.048 76.848 28.992C76.272 27.936 75.28 27.408 73.872 27.408C73.008 27.408 72.256 27.648 71.616 28.128C71.008 28.608 70.544 29.312 70.224 30.24C69.904 31.168 69.744 32.272 69.744 33.552V48H62.544Z";
const XUM_WORDMARK_HEIGHT = 62;
const XUM_WORDMARK_CURSOR_X = 108.7754;
const XUM_WORDMARK_CURSOR_Y = 13;
const XUM_WORDMARK_CURSOR_HEIGHT = 35;
const APP_WORDMARK_CURSOR_WIDTH = 26;
const DOCS_WORDMARK_CURSOR_WIDTH = 28;

export type LogoFill = "black" | "white" | "currentColor";

export function renderSquareLogo(fill: LogoFill): string {
  return `<svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
<!-- Four converging ribbons distinguish the Xum mark from the prior x-and-cursor icon. -->
<path d="${XUM_MARK_PATH}" fill="${fill}"/>
</svg>
`;
}

export function renderWordmarkLogo(fill: LogoFill, cursorWidth: number): string {
  const width = Number((XUM_WORDMARK_CURSOR_X + cursorWidth).toFixed(4));
  return `<svg width="${width}" height="${XUM_WORDMARK_HEIGHT}" viewBox="0 0 ${width} ${XUM_WORDMARK_HEIGHT}" fill="none" xmlns="http://www.w3.org/2000/svg">
<!-- Reordered prior Mux outlines keep Xum on the established Geist Sans Bold geometry. -->
<path d="${XUM_WORDMARK_PATH}" fill="${fill}"/>
<rect x="${XUM_WORDMARK_CURSOR_X}" y="${XUM_WORDMARK_CURSOR_Y}" width="${cursorWidth}" height="${XUM_WORDMARK_CURSOR_HEIGHT}" fill="${fill}"/>
</svg>
`;
}

export function renderDocsWordmark(fill: LogoFill): string {
  return renderWordmarkLogo(fill, DOCS_WORDMARK_CURSOR_WIDTH);
}

export function renderAppWordmark(fill: LogoFill): string {
  return renderWordmarkLogo(fill, APP_WORDMARK_CURSOR_WIDTH);
}

export function renderInlineAppWordmark(className: string): string {
  const width = Number((XUM_WORDMARK_CURSOR_X + APP_WORDMARK_CURSOR_WIDTH).toFixed(4));
  return `<svg class="${className}" aria-hidden="true" viewBox="0 0 ${width} ${XUM_WORDMARK_HEIGHT}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Reordered prior Mux outlines keep Xum on the established Geist Sans Bold geometry. -->
  <path d="${XUM_WORDMARK_PATH}" fill="currentColor" />
  <rect x="${XUM_WORDMARK_CURSOR_X}" y="${XUM_WORDMARK_CURSOR_Y}" width="${APP_WORDMARK_CURSOR_WIDTH}" height="${XUM_WORDMARK_CURSOR_HEIGHT}" fill="currentColor" />
</svg>`;
}
