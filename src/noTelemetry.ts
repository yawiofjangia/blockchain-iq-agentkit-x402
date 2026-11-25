/**
 * Neutralize AgentKit's built-in telemetry for this process.
 *
 * Every @CreateAction invocation makes AgentKit POST an analytics event
 * (including the wallet address) to https://cca-lite.coinbase.com/amp.
 * There is no opt-out flag in the library, and from this environment the
 * endpoint answers HTTP 400; the rejection is unhandled and crashes the
 * process. This module answers that one telemetry host locally with a
 * fake 200 and leaves every other request untouched, so no wallet address
 * is phoned home and the process stays alive.
 *
 * Import this module first, before AgentKit is used.
 */

const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = (async (input: unknown, init?: unknown) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as { url?: string }).url ?? "";
  try {
    if (new URL(url).hostname === "cca-lite.coinbase.com") {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch {
    // Not a parseable URL; fall through to the real fetch.
  }
  return originalFetch(
    input as Parameters<typeof fetch>[0],
    init as Parameters<typeof fetch>[1],
  );
}) as typeof fetch;
