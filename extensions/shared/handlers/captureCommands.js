/**
 * Capture-data command handlers shared by all browser extensions
 * (network request and console message reads/clears)
 *
 * All captured-data access is scoped to the attached tab: listings, clears
 * and lookups never expose or destroy another tab's data. RequestIds
 * listed before a tab switch are deliberately not resolvable after
 * attaching another tab — cross-tab listings leaked concurrent clients'
 * traffic (headers carry cookies), which is worse. Per-client scoping is
 * tracked in mcp-d591.
 */

/**
 * Register the capture command handlers on a WebSocketConnection.
 *
 * @param {object} wsConnection - WebSocketConnection to register on
 * @param {object} deps
 * @param {object} deps.tabHandlers - TabHandlers (attachment authority)
 * @param {object} deps.networkTracker - NetworkTracker (webRequest capture)
 * @param {object} deps.consoleHandler - ConsoleHandler (console capture)
 * @param {object} deps.logger - Logger
 * @param {function} [deps.getCdpRequestsForTab] - Optional (tabId) => array
 *   of CDP-captured requests, preferred over the webRequest fallback
 *   because their requestIds support body fetches (Chrome only)
 * @param {function} [deps.clearCdpRequestsForTab] - Optional (tabId) => void
 *   clearing the CDP capture for a tab (Chrome only)
 */
export function registerCaptureCommandHandlers(wsConnection, {
  tabHandlers,
  networkTracker,
  consoleHandler,
  logger,
  getCdpRequestsForTab = null,
  clearCdpRequestsForTab = null
}) {
  // Reads return an empty result with a noTabAttached flag instead of
  // throwing: the server renders the no-tab state distinctly (so "no tab"
  // never reads as "no traffic") while keeping the result shape intact for
  // raw/script-mode consumers. Clears DO throw — a destructive command
  // must never claim success for a no-op.
  wsConnection.registerCommandHandler('getNetworkRequests', async () => {
    const attachedTabId = tabHandlers.getAttachedTabId();
    if (!attachedTabId) {
      return { requests: [], noTabAttached: true };
    }

    // CDP-captured requests are preferred (their requestIds support body
    // fetches), but CDP only sees traffic from attach onward — the tab's
    // pre-attach history lives in the webRequest tracker. Serve both:
    // webRequest entries older than the earliest CDP entry, then the CDP
    // capture, so attaching a debugger never makes earlier requests
    // vanish from the listing.
    // Known imprecision: the two trackers stamp with different clocks, so
    // a request straddling the attach boundary can appear twice, and a
    // post-attach request known only to webRequest (CDP entry evicted or
    // Network.enable down) is not listed. Source-tagged entries would fix
    // both; tracked in mcp-e2d9.
    const cdpRequests = getCdpRequestsForTab ? getCdpRequestsForTab(attachedTabId) : [];
    const webRequests = networkTracker.getRequestsForTab(attachedTabId);
    if (cdpRequests.length === 0) {
      return { requests: webRequests };
    }
    const earliestCdp = Math.min(...cdpRequests.map(r => r.timestamp));
    const preAttach = webRequests.filter(r => r.timestamp < earliestCdp);
    return { requests: preAttach.concat(cdpRequests) };
  });

  wsConnection.registerCommandHandler('clearTracking', async () => {
    // Clear only the attached tab's data: other tabs' captures belong to
    // other sessions. With no tab attached the guard throws, so the
    // server never claims success for a no-op.
    const attachedTabId = tabHandlers.requireAttachedTabId();
    if (clearCdpRequestsForTab) {
      clearCdpRequestsForTab(attachedTabId);
    }
    networkTracker.clearRequests(attachedTabId);
    return { success: true };
  });

  wsConnection.registerCommandHandler('getConsoleMessages', async () => {
    const attachedTabId = tabHandlers.getAttachedTabId();
    if (!attachedTabId) {
      return { messages: [], noTabAttached: true };
    }
    return { messages: consoleHandler.getMessagesForTab(attachedTabId) };
  });

  // Note: there is deliberately no clearConsoleMessages handler — no
  // server code path has ever sent it (browser_console_messages has no
  // clear action). Console buffers shrink via the per-tab/global caps and
  // tab close.
}

/**
 * Register the tab-close cleanup shared by all browsers: every per-tab
 * store is dropped in this one place when a tab closes. Browser-specific
 * stores (e.g. Chrome's CDP capture) are cleaned via extraCleanup.
 * Note: debugger-session teardown (onDetach and eviction paths) is a
 * separate concern — it drops only session-scoped state, while the tab
 * keeps its other captures until it actually closes.
 *
 * @param {object} browserAPI - chrome/browser API object
 * @param {object} deps - { tabHandlers, networkTracker, consoleHandler,
 *   techStackInfo, logger, extraCleanup? }
 */
export function registerTabCleanup(browserAPI, {
  tabHandlers,
  networkTracker,
  consoleHandler,
  techStackInfo,
  logger,
  extraCleanup = null
}) {
  browserAPI.tabs.onRemoved.addListener((tabId) => {
    consoleHandler.clearMessages(tabId);
    networkTracker.clearRequests(tabId);
    delete techStackInfo[tabId];
    if (extraCleanup) {
      extraCleanup(tabId);
    }
    // TabHandlers cleans its own per-tab state (tech stack, stealth mode,
    // stealth session keys, attachment reset)
    tabHandlers.handleTabClosed(tabId).catch((error) => {
      logger.log(`[Background] Tab close cleanup failed for tab ${tabId}: ${error.message}`);
    });
  });
}
