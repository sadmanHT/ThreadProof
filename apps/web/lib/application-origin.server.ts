const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function getApplicationOrigin() {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();

  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("NEXT_PUBLIC_APP_URL must be configured in production.");
    }
    return "http://localhost:3000";
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("NEXT_PUBLIC_APP_URL must be an absolute http(s) URL.");
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error("NEXT_PUBLIC_APP_URL must be a credential-free http(s) URL.");
  }

  if (process.env.NODE_ENV === "production" && url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("NEXT_PUBLIC_APP_URL must use HTTPS outside loopback development environments.");
  }

  return url.origin;
}

export function buildApplicationUrl(pathname: string) {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) {
    throw new Error("Application URLs must use an absolute same-origin path.");
  }

  const origin = getApplicationOrigin();
  const url = new URL(pathname, `${origin}/`);
  if (url.origin !== origin) throw new Error("Application URL escaped the configured origin.");
  return url.toString();
}
