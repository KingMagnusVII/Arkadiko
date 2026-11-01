// Minimal content-script marker support. A future iteration can add a
// dedicated in-page panel; this version intentionally does not scrape or
// automatically execute assistant messages.
(() => {
  if (window.__openClawBridgeLoaded) return;
  window.__openClawBridgeLoaded = true;
})();
