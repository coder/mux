// App attribution values for AI provider requests.
//
// These are used by OpenRouter (and other compatible platforms) to attribute
// requests to mux (e.g., for leaderboards).

export const MUX_APP_ATTRIBUTION_TITLE = "mux";
export const MUX_APP_ATTRIBUTION_URL = "https://mux.coder.com";

// Prefix for per-workspace OpenRouter session_id values. Derived from the app
// title so the app's identity strings stay in lockstep; the prefix namespaces
// mux's session keys in the user's account-scoped id space so they cannot
// collide with another tool's session ids.
export const MUX_OPENROUTER_SESSION_ID_PREFIX = `${MUX_APP_ATTRIBUTION_TITLE}-`;
