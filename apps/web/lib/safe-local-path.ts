const LOCAL_ORIGIN = "https://threadproof.local";

/**
 * Returns a same-origin application path or the supplied safe fallback.
 * Protocol-relative and backslash-prefixed targets are rejected explicitly.
 */
export function safeLocalPath(value: unknown, fallback = "/app") {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\")
  ) {
    return fallback;
  }

  try {
    const candidate = new URL(value, LOCAL_ORIGIN);
    if (candidate.origin !== LOCAL_ORIGIN) return fallback;
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch {
    return fallback;
  }
}
