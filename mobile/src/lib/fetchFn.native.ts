/**
 * Native platform fetch.
 *
 * expo/fetch provides SSE (Server-Sent Events) support on native platforms
 * which the standard React Native fetch does not support.
 */
import { fetch } from "expo/fetch";

export const fetchFn: typeof globalThis.fetch = fetch as typeof globalThis.fetch;
