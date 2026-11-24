// Optional fixed-IP proxy for the Zoom browser: ZOOM_PROXY = http://user:pass@1.2.3.4:3128
// With it, Zoom always sees the same IP (no "new location → verification code"), even on GitHub's servers.
export function proxyFromEnv() {
  const raw = (process.env.ZOOM_PROXY || '').trim();
  if (!raw) return undefined;
  const u = new URL(raw);
  return {
    server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`,
    ...(u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}),
  };
}
