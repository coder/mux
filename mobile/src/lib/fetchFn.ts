/**
 * Web platform fetch.
 *
 * On web, the global fetch already supports streaming via ReadableStream,
 * so we use it directly instead of expo/fetch.
 */
export const fetchFn: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);
