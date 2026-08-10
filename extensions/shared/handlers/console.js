/**
 * Console message capture for browser extensions
 * Injects console override to capture log/warn/error/info/debug messages
 */

/**
 * Console handler class
 * Manages console message capture and storage
 */
export class ConsoleHandler {
  constructor(browserAdapter, logger) {
    this.browserAdapter = browserAdapter;
    this.browser = browserAdapter.getRawAPI();
    this.logger = logger;

    // Console messages storage, bucketed per tab so one tab's messages
    // cannot evict another tab's. A global cap bounds total memory across
    // however many tabs are being captured.
    this.messagesByTab = new Map(); // tabId -> message array
    this.maxMessages = 1000; // Per-tab cap on stored messages
    this.maxTotalMessages = 5000; // Cap across all tabs combined
    this._totalCount = 0; // Maintained so the caps cost O(1) per message

    // Message listener tracking (prevent duplicates)
    this._messageListenerSetUp = false;
    this._messageListener = null;
  }

  /**
   * Get captured console messages for one tab, in chronological order.
   * Messages are only served per tab — never other tabs' output. Named
   * ForTab (replacing the old getMessages()) so stale all-tabs callers
   * fail loudly instead of silently changing meaning.
   * @param {number} tabId - Tab to read (empty result if absent)
   */
  getMessagesForTab(tabId) {
    const messages = tabId ? this.messagesByTab.get(tabId) : null;
    if (!messages) {
      return [];
    }
    // CDP delivers buffered events late with their original timestamps, so
    // arrival order isn't chronological order
    return messages.slice().sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Add a console message
   */
  addMessage(message) {
    let messages = this.messagesByTab.get(message.tabId);
    if (!messages) {
      messages = [];
      this.messagesByTab.set(message.tabId, messages);
    }
    messages.push(message);
    this._totalCount++;

    // Keep only last maxMessages per tab
    if (messages.length > this.maxMessages) {
      messages.shift();
      this._totalCount--;
    }

    // Bound total memory across all tabs: each add can exceed the global
    // cap by at most one, so a single eviction suffices. The victim is the
    // bucket whose HEAD is oldest — approximate, since buckets are
    // arrival-ordered and replays can park older timestamps mid-bucket,
    // but memory stays exactly bounded either way
    if (this._totalCount > this.maxTotalMessages) {
      let oldestTabId = null;
      let oldestTs = Infinity;
      for (const [tabId, bucket] of this.messagesByTab) {
        if (bucket.length > 0 && bucket[0].timestamp < oldestTs) {
          oldestTs = bucket[0].timestamp;
          oldestTabId = tabId;
        }
      }
      if (oldestTabId !== null) {
        const bucket = this.messagesByTab.get(oldestTabId);
        bucket.shift();
        this._totalCount--;
        if (bucket.length === 0) {
          this.messagesByTab.delete(oldestTabId);
        }
      }
    }
  }

  /**
   * Clear captured messages
   * @param {number} tabId - Optional tab ID to clear (all tabs if omitted)
   */
  clearMessages(tabId = null) {
    if (tabId === null) {
      this.messagesByTab.clear();
      this._totalCount = 0;
      this.logger.log('[ConsoleHandler] Messages cleared');
    } else {
      const messages = this.messagesByTab.get(tabId);
      if (messages) {
        this._totalCount -= messages.length;
        this.messagesByTab.delete(tabId);
      }
      this.logger.log(`[ConsoleHandler] Messages cleared for tab ${tabId}`);
    }
  }

  /**
   * Inject console capture script into a tab
   * @param {number} tabId - Tab ID to inject console capture into
   */
  async injectConsoleCapture(tabId) {
    try {
      this.logger.log(`[ConsoleHandler] Injecting console capture into tab ${tabId}`);

      // Use func parameter (CSP-safe) instead of code string (requires eval)
      // Must pass standalone function, not class method
      await this.browserAdapter.executeScript(tabId, {
        func: function() {
          // Only inject once
          if (!window.__blueprintConsoleInjected) {
            window.__blueprintConsoleInjected = true;

            // Store original console methods
            const originalConsole = {
              log: console.log,
              warn: console.warn,
              error: console.error,
              info: console.info,
              debug: console.debug
            };

            // Override console methods to capture messages
            ['log', 'warn', 'error', 'info', 'debug'].forEach(method => {
              console[method] = function(...args) {
                // Call original
                originalConsole[method].apply(console, args);

                // Send to extension
                const message = {
                  type: 'console',
                  level: method,
                  text: args.map(arg => {
                    try {
                      return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
                    } catch (e) {
                      return String(arg);
                    }
                  }).join(' '),
                  timestamp: Date.now()
                };

                // Try to send via postMessage (extension will listen)
                window.postMessage({ __blueprintConsole: message }, '*');
              };
            });
          }
        },
        world: 'MAIN'  // Must use MAIN world to override page's console
      });

      this.logger.log('[ConsoleHandler] Console capture injected into tab:', tabId);
    } catch (error) {
      this.logger.logAlways('[ConsoleHandler] Failed to inject console capture:', error);
    }
  }

  /**
   * Set up message listener to receive console messages from content script
   * This should be called once during initialization
   *
   * Note: Chrome automatically restores listeners on service worker wake,
   * so we don't need persistent storage guards
   */
  setupMessageListener() {
    // Store the listener so we can track it
    this._messageListener = (message, sender) => {
      if (message.type === 'console' && sender.tab) {
        // Add console message with tab info
        this.addMessage({
          tabId: sender.tab.id,
          level: message.level,
          text: message.text,
          timestamp: message.timestamp,
          url: sender.url
        });
      }
    };

    // Note: This would typically be set up in the content script
    // The background script receives messages via runtime.onMessage
    this.browser.runtime.onMessage.addListener(this._messageListener);
    this._messageListenerSetUp = true;

    this.logger.log('[ConsoleHandler] Message listener set up');
  }
}
