/**
 * Network request tracking for browser extensions
 * Captures and stores network requests using webRequest API
 */

/**
 * Network tracker class
 * Tracks network requests with headers, bodies, and responses
 */
export class NetworkTracker {
  constructor(browserAPI, logger) {
    this.browser = browserAPI;
    this.logger = logger;

    // Requests bucketed per tab so one busy tab cannot evict another tab's
    // history. Requests that can't be attributed to a tab (tabId -1:
    // service workers, extensions) are NOT stored: they would be visible
    // to whichever tab is attached, leaking unrelated origins' auth
    // headers across sessions. Per-client visibility for such traffic is
    // tracked in mcp-d591. The webRequest listeners see every open tab, so
    // a global cap bounds total memory regardless of tab count.
    this.requestsByTab = new Map(); // tabId -> request array
    this.maxRequests = 500; // Per-tab cap on stored requests
    this.maxTotalRequests = 2000; // Cap across all tabs combined

    // requestId -> request entry, for O(1) event updates. webRequest gives
    // no tabId-stability guarantee across one request's events (prerender
    // activation, tab destroyed mid-flight), so updates must not depend on
    // the event's tabId matching the storage bucket.
    this._byRequestId = new Map();
    this._totalCount = 0;

    // Bind event handlers
    this._handleBeforeRequest = this._handleBeforeRequest.bind(this);
    this._handleCompleted = this._handleCompleted.bind(this);
    this._handleBeforeSendHeaders = this._handleBeforeSendHeaders.bind(this);
    this._handleErrorOccurred = this._handleErrorOccurred.bind(this);
  }

  /**
   * Initialize network tracking
   */
  init() {
    // Listen for request start
    this.browser.webRequest.onBeforeRequest.addListener(
      this._handleBeforeRequest,
      { urls: ["<all_urls>"] },
      ["requestBody"]
    );

    // Listen for request completion
    this.browser.webRequest.onCompleted.addListener(
      this._handleCompleted,
      { urls: ["<all_urls>"] },
      ["responseHeaders"]
    );

    // Listen for request headers
    this.browser.webRequest.onBeforeSendHeaders.addListener(
      this._handleBeforeSendHeaders,
      { urls: ["<all_urls>"] },
      ["requestHeaders"]
    );

    // Listen for request errors
    this.browser.webRequest.onErrorOccurred.addListener(
      this._handleErrorOccurred,
      { urls: ["<all_urls>"] }
    );

    this.logger.log('[NetworkTracker] Initialized');
  }

  /**
   * Get requests scoped to a tab, in chronological order. With no tabId
   * nothing is returned: leaking other tabs' traffic to an unattached
   * caller is worse than an empty listing.
   * @param {number} tabId - Tab to scope to (empty result if falsy)
   */
  getRequestsForTab(tabId) {
    if (!tabId) {
      return [];
    }
    const tabRequests = this.requestsByTab.get(tabId) || [];
    return tabRequests.slice().sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Clear tracked requests
   * @param {number} tabId - Tab to clear (all tabs if omitted). Leaves -1
   *   entries alone: they don't belong to any single tab (tab-close
   *   cleanup uses this).
   */
  clearRequests(tabId = null) {
    if (tabId === null) {
      this.requestsByTab.clear();
      this._byRequestId.clear();
      this._totalCount = 0;
      this.logger.log('[NetworkTracker] Cleared all requests');
    } else {
      this._dropBucket(tabId);
      this.logger.log(`[NetworkTracker] Cleared requests for tab ${tabId}`);
    }
  }

  /**
   * Remove one tab's bucket, keeping the index and total in sync
   */
  _dropBucket(tabId) {
    const tabRequests = this.requestsByTab.get(tabId);
    if (!tabRequests) {
      return;
    }
    for (const request of tabRequests) {
      // Redirects re-fire onBeforeRequest with the same requestId, so the
      // index may point at a newer entry for this id — only unindex when
      // this entry is the indexed one
      if (this._byRequestId.get(request.requestId) === request) {
        this._byRequestId.delete(request.requestId);
      }
    }
    this._totalCount -= tabRequests.length;
    this.requestsByTab.delete(tabId);
  }

  /**
   * Evict the FIFO head of a bucket, keeping the index and total in sync
   */
  _evictOldest(tabId) {
    const tabRequests = this.requestsByTab.get(tabId);
    if (!tabRequests || tabRequests.length === 0) {
      return;
    }
    const removed = tabRequests.shift();
    // Same identity guard as _dropBucket: never unindex a surviving
    // duplicate (redirects reuse requestIds)
    if (this._byRequestId.get(removed.requestId) === removed) {
      this._byRequestId.delete(removed.requestId);
    }
    this._totalCount--;
    if (tabRequests.length === 0) {
      this.requestsByTab.delete(tabId);
    }
  }

  /**
   * Handle onBeforeRequest event
   * Captures initial request information
   */
  _handleBeforeRequest(details) {
    // Unattributable requests are not stored (see constructor comment)
    if (details.tabId < 0) {
      return;
    }

    let tabRequests = this.requestsByTab.get(details.tabId);
    if (!tabRequests) {
      tabRequests = [];
      this.requestsByTab.set(details.tabId, tabRequests);
    }

    const request = {
      requestId: `${details.requestId}`,
      url: details.url,
      method: details.method,
      type: details.type,
      tabId: details.tabId,
      timestamp: details.timeStamp,
      statusCode: null,
      statusText: null,
      requestHeaders: null,
      responseHeaders: null,
      requestBody: details.requestBody
    };
    tabRequests.push(request);
    this._byRequestId.set(request.requestId, request);
    this._totalCount++;

    // Keep only last maxRequests per tab (FIFO)
    if (tabRequests.length > this.maxRequests) {
      this._evictOldest(details.tabId);
    }

    // Bound total memory across all tabs by evicting the globally oldest
    // FIFO heads
    while (this._totalCount > this.maxTotalRequests) {
      let oldestTabId = null;
      let oldestTs = Infinity;
      for (const [tabId, bucket] of this.requestsByTab) {
        if (bucket.length > 0 && bucket[0].timestamp < oldestTs) {
          oldestTs = bucket[0].timestamp;
          oldestTabId = tabId;
        }
      }
      if (oldestTabId === null) {
        return;
      }
      this._evictOldest(oldestTabId);
    }
  }

  /**
   * Handle onCompleted event
   * Captures response information
   */
  _handleCompleted(details) {
    const request = this._byRequestId.get(`${details.requestId}`);
    if (request) {
      request.statusCode = details.statusCode;
      request.statusText = details.statusLine;
      request.responseHeaders = details.responseHeaders;
    }
  }

  /**
   * Handle onBeforeSendHeaders event
   * Captures request headers
   */
  _handleBeforeSendHeaders(details) {
    const request = this._byRequestId.get(`${details.requestId}`);
    if (request) {
      request.requestHeaders = details.requestHeaders;
    }
  }

  /**
   * Handle onErrorOccurred event
   * Captures error information
   */
  _handleErrorOccurred(details) {
    const request = this._byRequestId.get(`${details.requestId}`);
    if (request) {
      request.statusCode = 0;
      request.statusText = details.error || 'Error';
    }
  }

  /**
   * Clean up event listeners
   */
  destroy() {
    this.browser.webRequest.onBeforeRequest.removeListener(this._handleBeforeRequest);
    this.browser.webRequest.onCompleted.removeListener(this._handleCompleted);
    this.browser.webRequest.onBeforeSendHeaders.removeListener(this._handleBeforeSendHeaders);
    this.browser.webRequest.onErrorOccurred.removeListener(this._handleErrorOccurred);

    this.logger.log('[NetworkTracker] Destroyed');
  }
}
