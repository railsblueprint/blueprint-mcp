/**
 * Tab management handlers for browser extensions
 * Handles tab listing, creation, selection, and closing
 */

/**
 * Tab handlers class
 * Manages tab operations and state
 */
export class TabHandlers {
  constructor(browserAPI, logger, iconManager) {
    this.browser = browserAPI;
    this.logger = logger;
    this.iconManager = iconManager;

    // Tab state
    this.attachedTabId = null;
    this.attachedTabInfo = null;
    this.stealthMode = false; // Current attached tab's stealth mode

    // Per-tab stealth mode tracking
    this.tabStealthModes = {}; // tabId → boolean

    // Tech stack info (shared with other modules)
    this.techStackInfo = {};

    // Injection handlers (will be set by consumer)
    this.consoleInjector = null;
    this.dialogInjector = null;
  }

  /**
   * Set console capture injector
   */
  setConsoleInjector(injector) {
    this.consoleInjector = injector;
  }

  /**
   * Set dialog overrides injector
   */
  setDialogInjector(injector) {
    this.dialogInjector = injector;
  }

  /**
   * Set tech stack info
   */
  setTechStackInfo(tabId, techStack) {
    this.techStackInfo[tabId] = techStack;

    // Update attached tab info if this is the attached tab
    if (this.attachedTabId === tabId && this.attachedTabInfo) {
      this.attachedTabInfo.techStack = techStack;
    }
  }

  /**
   * Get attached tab info
   */
  getAttachedTabInfo() {
    return this.attachedTabInfo;
  }

  /**
   * Get attached tab ID
   */
  getAttachedTabId() {
    return this.attachedTabId;
  }

  /**
   * Get the attached tab ID, throwing when no tab is attached. The single
   * guard used by every tab-scoped command handler so the condition always
   * surfaces through the JSON-RPC error channel with one message.
   */
  requireAttachedTabId() {
    if (!this.attachedTabId) {
      throw new Error("No tab attached. Use browser_tabs action='attach' to attach a tab first.");
    }
    return this.attachedTabId;
  }

  /**
   * Get stealth mode state
   */
  getStealthMode() {
    return this.stealthMode;
  }

  /**
   * Handle getTabs command
   * Returns list of all tabs from all windows
   */
  async getTabs() {
    // Get all tabs from all windows
    const windows = await this.browser.windows.getAll({ populate: true });
    const tabs = [];
    let tabIndex = 0;

    windows.forEach(window => {
      window.tabs.forEach(tab => {
        // Check if tab is automatable (not about:, moz-extension:, chrome:, etc.)
        const isAutomatable = tab.url &&
          !['about:', 'moz-extension:', 'chrome:', 'chrome-extension:'].some(scheme =>
            tab.url.startsWith(scheme)
          );

        tabs.push({
          id: tab.id,
          windowId: window.id,
          title: tab.title,
          url: tab.url,
          active: tab.active,
          index: tabIndex,
          automatable: isAutomatable
        });

        tabIndex++;
      });
    });

    return { tabs };
  }

  /**
   * Handle createTab command
   * Creates a new tab and auto-attaches to it
   */
  async createTab(params) {
    const url = params.url || 'about:blank';
    const activate = params.activate !== false;
    const stealth = params.stealth ?? false;

    // Create new tab
    const tab = await this.browser.tabs.create({
      url: url,
      active: activate
    });

    // Set stealth mode (both current and per-tab)
    this.stealthMode = stealth;
    this.tabStealthModes[tab.id] = stealth;

    // Store stealth state in storage for content script access
    if (this.browser.storage && this.browser.storage.session) {
      await this.browser.storage.session.set({ [`stealth_${tab.id}`]: stealth });
      this.logger.log(`[TabHandlers] Stored stealth=${stealth} for tab ${tab.id}`);
    }

    // Get all tabs to find the index of the newly created tab
    const allTabs = await this.browser.tabs.query({});
    const tabIndex = allTabs.findIndex(t => t.id === tab.id);

    // Clear badge from old tab if there was one
    const oldTabId = this.attachedTabId;
    if (oldTabId && oldTabId !== tab.id && this.iconManager) {
      await this.iconManager.clearBadge(oldTabId);
    }

    // Auto-attach to the new tab
    this.attachedTabId = tab.id;
    this.attachedTabInfo = {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      index: tabIndex >= 0 ? tabIndex : undefined,
      techStack: this.techStackInfo[tab.id] || null
    };

    // Focus the window if activating the tab (may help badge appear immediately)
    if (activate && tab.windowId) {
      await this.browser.windows.update(tab.windowId, { focused: true });
    }

    // Update icon manager
    if (this.iconManager) {
      this.iconManager.setAttachedTab(tab.id);
      this.iconManager.setStealthMode(stealth);
      await this.iconManager.updateBadgeForTab();

      // Force badge UI refresh with retries
      // Chrome doesn't fire onActivated for newly created tabs,
      // so badge may not appear until UI processes the update.
      // Try multiple times with increasing delays to ensure it appears.
      if (activate) {
        setTimeout(async () => {
          await this.iconManager.updateBadgeForTab();
        }, 50);
        setTimeout(async () => {
          await this.iconManager.updateBadgeForTab();
        }, 150);
      }
    }

    // Inject console capture and dialog overrides
    if (this.consoleInjector) {
      await this.consoleInjector(tab.id);
    }
    if (this.dialogInjector) {
      await this.dialogInjector(tab.id);
    }

    return {
      tab: {
        id: tab.id,
        title: tab.title,
        url: tab.url,
        techStack: this.techStackInfo[tab.id] || null
      }
    };
  }

  /**
   * Handle selectTab command
   * Attaches to an existing tab by index
   */
  async selectTab(params) {
    const tabIndex = params.tabIndex;
    const activate = params.activate ?? false; // Default to false - don't steal focus
    const stealth = params.stealth ?? false;

    // Get all tabs
    const allTabs = await this.browser.tabs.query({});

    if (tabIndex < 0 || tabIndex >= allTabs.length) {
      throw new Error(`Tab index ${tabIndex} out of range (0-${allTabs.length - 1})`);
    }

    const selectedTab = allTabs[tabIndex];

    // Check if tab is automatable
    const isAutomatable = selectedTab.url &&
      !['about:', 'moz-extension:', 'chrome:', 'chrome-extension:'].some(scheme =>
        selectedTab.url.startsWith(scheme)
      );

    if (!isAutomatable) {
      throw new Error(
        `Cannot automate tab ${tabIndex}: "${selectedTab.title}" (${selectedTab.url || 'no url'}) - ` +
        `System pages (about:, chrome:, etc.) cannot be automated`
      );
    }

    // Optionally switch to the tab
    if (activate) {
      await this.browser.tabs.update(selectedTab.id, { active: true });
      await this.browser.windows.update(selectedTab.windowId, { focused: true });
    }

    // Clear badge from old tab if there was one
    const oldTabId = this.attachedTabId;
    if (oldTabId && oldTabId !== selectedTab.id && this.iconManager) {
      await this.iconManager.clearBadge(oldTabId);
    }

    // Set stealth mode (both current and per-tab)
    this.stealthMode = stealth;
    this.tabStealthModes[selectedTab.id] = stealth;

    // Store stealth state in storage for content script access
    if (this.browser.storage && this.browser.storage.session) {
      await this.browser.storage.session.set({ [`stealth_${selectedTab.id}`]: stealth });
      this.logger.log(`[TabHandlers] Stored stealth=${stealth} for tab ${selectedTab.id}`);
    }

    // Attach to this tab
    this.attachedTabId = selectedTab.id;
    this.attachedTabInfo = {
      id: selectedTab.id,
      title: selectedTab.title,
      url: selectedTab.url,
      index: tabIndex,
      techStack: this.techStackInfo[selectedTab.id] || null
    };

    // Update icon manager
    if (this.iconManager) {
      this.iconManager.setAttachedTab(selectedTab.id);
      this.iconManager.setStealthMode(stealth);
      await this.iconManager.updateBadgeForTab();
    }

    // Inject console capture and dialog overrides
    if (this.consoleInjector) {
      await this.consoleInjector(selectedTab.id);
    }
    if (this.dialogInjector) {
      await this.dialogInjector(selectedTab.id);
    }

    return {
      tab: {
        id: selectedTab.id,
        title: selectedTab.title,
        url: selectedTab.url,
        techStack: this.techStackInfo[selectedTab.id] || null
      }
    };
  }

  /**
   * Handle closeTab command
   * Can close by index or close the currently attached tab
   * @param {number} [index] - Optional tab index to close. If not provided, closes attached tab.
   * @returns {Object} - {success: true, closedAttachedTab: boolean}
   */
  async closeTab(index) {
    let tabIdToClose;
    let wasAttached = false;

    if (index !== undefined) {
      // Close tab by index - use same method as getTabs() to ensure consistent ordering
      const windows = await this.browser.windows.getAll({ populate: true });
      const allTabs = [];
      windows.forEach(window => {
        window.tabs.forEach(tab => {
          allTabs.push(tab);
        });
      });

      if (index < 0 || index >= allTabs.length) {
        throw new Error(`Tab index ${index} out of range (0-${allTabs.length - 1})`);
      }

      const tabToClose = allTabs[index];
      tabIdToClose = tabToClose.id;

      // Check if we're closing the attached tab
      wasAttached = (tabIdToClose === this.attachedTabId);
    } else {
      // Close currently attached tab
      if (!this.attachedTabId) {
        throw new Error('No tab attached');
      }
      tabIdToClose = this.attachedTabId;
      wasAttached = true;
    }

    // Close the tab
    await this.browser.tabs.remove(tabIdToClose);

    // If we closed the attached tab, clear attachment
    if (wasAttached) {
      this.attachedTabId = null;
      this.attachedTabInfo = null;

      // Update icon manager
      if (this.iconManager) {
        this.iconManager.setAttachedTab(null);
      }
    }

    // Clean up per-tab stealth mode
    delete this.tabStealthModes[tabIdToClose];

    // Clean up storage
    if (this.browser.storage && this.browser.storage.session) {
      await this.browser.storage.session.remove(`stealth_${tabIdToClose}`);
    }

    return { success: true, closedAttachedTab: wasAttached };
  }

  /**
   * Handle tab closed event (called when tab is closed externally)
   */
  async handleTabClosed(tabId) {
    if (tabId === this.attachedTabId) {
      this.logger.log('[TabHandlers] Attached tab closed');
      this.attachedTabId = null;
      this.attachedTabInfo = null;

      // Update icon manager
      if (this.iconManager) {
        this.iconManager.setAttachedTab(null);
      }
    }

    // Clean up tech stack info
    delete this.techStackInfo[tabId];

    // Clean up per-tab stealth mode
    delete this.tabStealthModes[tabId];

    // Clean up storage
    if (this.browser.storage && this.browser.storage.session) {
      await this.browser.storage.session.remove(`stealth_${tabId}`);
    }
  }
}
