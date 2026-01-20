export function isStorybook(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  // Storybook preview iframe is usually /iframe.html, but test-runner debug URLs
  // (and sometimes the manager itself) use ?path=/story/... .
  if (window.location.pathname.endsWith("iframe.html")) {
    return true;
  }

  const params = new URLSearchParams(window.location.search);
  const path = params.get("path");
  if (path?.startsWith("/story/")) {
    return true;
  }

  // Some configurations pass story identity via ?id=...
  if (params.has("id")) {
    return true;
  }

  return false;
}
