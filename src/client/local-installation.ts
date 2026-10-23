/** Consume setup credentials before rendering or making any API requests. */
export function consumeSetupToken(): string | null {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (!fragment.has("setup")) return null;
  const token = fragment.get("setup");
  fragment.delete("setup");
  const rest = fragment.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ""}`,
  );
  return token || null;
}

export function isLocalInstallation(hostname = window.location.hostname) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}
