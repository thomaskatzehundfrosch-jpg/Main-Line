/* coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
/* https://github.com/gzuidhof/coi-serviceworker */
/* Modified: uses COEP "credentialless" so Google Fonts and other external
   resources load normally without requiring CORP headers on their end.    */

if (typeof window === "undefined") {
  // ---- Service Worker context ----
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) =>
    event.waitUntil(self.clients.claim())
  );

  async function handleFetch(request) {
    // Passthrough for same-origin cached requests
    if (
      request.cache === "only-if-cached" &&
      request.mode !== "same-origin"
    ) {
      return;
    }

    const r = await fetch(request).catch((e) => {
      console.error("[coi-sw] fetch failed:", e);
    });
    if (!r) return;

    const newHeaders = new Headers(r.headers);
    newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
    // "credentialless" allows cross-origin resources (Google Fonts etc.)
    // without requiring CORP headers, while still enabling crossOriginIsolated.
    newHeaders.set("Cross-Origin-Embedder-Policy", "credentialless");

    return new Response(r.body, {
      status: r.status,
      statusText: r.statusText,
      headers: newHeaders,
    });
  }

  self.addEventListener("fetch", (e) =>
    e.respondWith(handleFetch(e.request))
  );
} else {
  // ---- Main thread context ----
  (async function init() {
    // Already isolated — nothing to do
    if (window.crossOriginIsolated !== false) return;

    if (!window.isSecureContext) {
      console.log("[coi-sw] Not in a secure context — skipping.");
      return;
    }

    const registration = await navigator.serviceWorker
      .register(window.document.currentScript.src)
      .catch((e) => console.log("[coi-sw] Failed to register:", e));

    if (registration) {
      console.log(
        "[coi-sw] Registered. Reloading once to activate cross-origin isolation..."
      );
      // Only reload if the SW wasn't already controlling this page.
      // If it was, the headers are already being set and something else is wrong.
      if (!navigator.serviceWorker.controller) {
        window.location.reload();
      }
    }
  })();
}
