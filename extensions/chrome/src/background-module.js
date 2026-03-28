/**
 * Chrome extension background script (vanilla JS modular version)
 * Connects to MCP server and handles browser automation commands
 *
 * Uses shared ES6 modules from extensions/shared/
 * Minimal build step - just file copying
 */

// Import shared modules
import { Logger } from '../../shared/utils/logger.js';
import { IconManager } from '../../shared/utils/icons.js';
import { WebSocketConnection } from '../../shared/connection/websocket.js';
import { TabHandlers } from '../../shared/handlers/tabs.js';
import { NetworkTracker } from '../../shared/handlers/network.js';
import { DialogHandler } from '../../shared/handlers/dialogs.js';
import { ConsoleHandler } from '../../shared/handlers/console.js';
import { createBrowserAdapter } from '../../shared/adapters/browser.js';
import { wrapWithUnwrap, shouldUnwrap } from '../../shared/utils/unwrap.js';
import { setupInstallHandler } from '../../shared/handlers/install.js';

// Initialize browser adapter at top level (before async IIFE)
const browserAdapter = createBrowserAdapter();
const chrome = browserAdapter.getRawAPI();

// Set up welcome page to open on first install (must be at top level for MV3)
// Browser name is auto-detected from manifest.json
setupInstallHandler(chrome);

// Top-level variables for tab monitoring
let tabHandlers = null;
let wsConnection = null;

// Write to storage immediately to confirm script is loading
chrome.storage.local.set({
  backgroundScriptLoaded: {
    timestamp: new Date().toISOString(),
    message: 'Background script loaded successfully!'
  }
});

// Register tabs.onUpdated listener at TOP LEVEL (not inside async function)
// This ensures it persists through service worker suspensions in MV3
console.error('[Background] ⚡ Registering tabs.onUpdated listener at TOP LEVEL...');

// Also write to storage to confirm listener is being registered
chrome.storage.local.set({
  listenerRegistered: {
    timestamp: new Date().toISOString(),
    message: 'tabs.onUpdated listener registered!'
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Check if tabHandlers is initialized yet
  if (!tabHandlers) {
    console.error('[DEBUG tabs.onUpdated] tabHandlers not initialized yet, skipping');
    return;
  }

  const attachedTabId = tabHandlers.getAttachedTabId();

  // Log EVERY event with full details
  console.error('[DEBUG tabs.onUpdated] ⚡ FIRED! tabId:', tabId, 'attached:', attachedTabId, 'match:', tabId === attachedTabId);
  console.error('[DEBUG tabs.onUpdated] changeInfo:', JSON.stringify(changeInfo));
  console.error('[DEBUG tabs.onUpdated] tab.url:', tab.url);

  // Write to storage for debugging - log EVERY onUpdated event
  await chrome.storage.local.set({
    lastOnUpdatedEvent: {
      tabId,
      changeInfo,
      attachedTabId,
      timestamp: new Date().toISOString()
    }
  });

  // Debug: Log every URL change
  if (changeInfo.url) {
    console.error('[DEBUG tabs.onUpdated] Tab', tabId, 'URL changed to:', changeInfo.url);
    console.error('[DEBUG tabs.onUpdated] Attached tab ID:', attachedTabId);
    console.error('[DEBUG tabs.onUpdated] Match:', tabId === attachedTabId);

    // Write to storage for debugging
    await chrome.storage.local.set({
      lastNavigation: {
        tabId,
        attachedTabId,
        url: changeInfo.url,
        timestamp: new Date().toISOString()
      }
    });
  }

  // Only notify if this is the attached tab and URL changed
  if (tabId === attachedTabId && changeInfo.url && wsConnection) {
    console.error('[Background] ✅ Attached tab navigated to:', changeInfo.url);
    console.error('[Background] Sending notification to server...');

    // Send notification to server about URL change
    // Relay server will forward this to MCP server
    wsConnection.sendNotification('notifications/tab_info_update', {
      currentTab: {
        id: tab.id,
        title: tab.title,
        url: tab.url,
        index: null, // Index not available in onUpdated
        techStack: null // Will be detected later
      }
    });

    console.error('[Background] Notification sent!');
  }
});
console.error('[Background] ✅ tabs.onUpdated listener registered at TOP LEVEL!');

// Main initialization
(async () => {

// Note: Use browserAdapter.executeScript instead of defining a local executeScript
// The browserAdapter version properly handles both 'func' and 'code' parameters
// and avoids CSP issues by not using eval() when possible

// Initialize logger
const logger = new Logger('Blueprint MCP for Chrome');
await logger.init(chrome);
const manifest = chrome.runtime.getManifest();
logger.logAlways(`Blueprint MCP v${manifest.version}`);

// Read build timestamp (read once at startup)
let buildTimestamp = null;
try {
  const buildInfoUrl = chrome.runtime.getURL('build-info.json');
  /* global fetch */
  const response = await fetch(buildInfoUrl);
  const buildInfo = await response.json();
  buildTimestamp = buildInfo.timestamp;
  logger.log(`Build timestamp: ${buildTimestamp}`);
} catch (e) {
  logger.log('Could not read build-info.json:', e.message);
}

// Initialize all managers and handlers
const iconManager = new IconManager(chrome, logger);
tabHandlers = new TabHandlers(chrome, logger, iconManager);
const networkTracker = new NetworkTracker(chrome, logger);
const dialogHandler = new DialogHandler(browserAdapter, logger);
const consoleHandler = new ConsoleHandler(browserAdapter, logger);

// Wire up injectors to tab handlers
tabHandlers.setConsoleInjector((tabId) => consoleHandler.injectConsoleCapture(tabId));
tabHandlers.setDialogInjector((tabId) => dialogHandler.setupDialogOverrides(tabId));

// Set up console message listener (receives messages from content script)
consoleHandler.setupMessageListener();

// Initialize icon manager
iconManager.init();

// Initialize network tracker
networkTracker.init();

// State variables
let techStackInfo = {}; // Stores detected tech stack per tab
// let pendingDialogResponse = null; // Stores response for next dialog (unused - removed)
let debuggerAttached = false; // Track if debugger is attached to current tab
let currentDebuggerTabId = null; // Track which tab has debugger attached

// CDP Network tracking storage
const cdpNetworkRequests = new Map(); // Stores CDP network requests by requestId
const MAX_CDP_REQUESTS = 500; // Keep only last 500 requests

// Set up keepalive alarm (Chrome-specific - prevents service worker suspension)
if (chrome.alarms) {
  chrome.alarms.create('keepalive', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keepalive') {
      logger.log('[Background] Keepalive alarm - service worker active');
    }
  });
}

// Set up CDP debugger event listener for Network and Runtime events
chrome.debugger.onEvent.addListener((source, method, params) => {
  // Only track Network and Runtime events
  if (!method.startsWith('Network.') && !method.startsWith('Runtime.')) return;

  // Only track events for the currently attached tab
  if (!currentDebuggerTabId || source.tabId !== currentDebuggerTabId) return;

  try {
    switch (method) {
      case 'Network.requestWillBeSent': {
        const requestId = params.requestId;
        const request = params.request;
        const type = params.type || 'other';

        cdpNetworkRequests.set(requestId, {
          requestId,
          url: request.url,
          method: request.method,
          requestHeaders: request.headers,
          type,
          timestamp: params.timestamp || Date.now() / 1000
        });

        // Limit storage size
        if (cdpNetworkRequests.size > MAX_CDP_REQUESTS) {
          const firstKey = cdpNetworkRequests.keys().next().value;
          cdpNetworkRequests.delete(firstKey);
        }
        break;
      }

      case 'Network.responseReceived': {
        const requestId = params.requestId;
        const response = params.response;

        const existing = cdpNetworkRequests.get(requestId);
        if (existing) {
          existing.statusCode = response.status;
          existing.statusText = response.statusText;
          existing.responseHeaders = response.headers;
          existing.mimeType = response.mimeType;
        }
        break;
      }

      case 'Network.loadingFinished': {
        const requestId = params.requestId;
        const existing = cdpNetworkRequests.get(requestId);
        if (existing) {
          existing.finished = true;
          existing.encodedDataLength = params.encodedDataLength;
        }
        break;
      }

      case 'Network.loadingFailed': {
        const requestId = params.requestId;
        const existing = cdpNetworkRequests.get(requestId);
        if (existing) {
          existing.failed = true;
          existing.errorText = params.errorText;
        }
        break;
      }

      case 'Runtime.consoleAPICalled': {
        // Capture ALL console messages (page + extensions) via CDP
        const level = params.type; // 'log', 'warning', 'error', 'info', 'debug', etc
        const args = params.args || [];

        // Convert CDP RemoteObject arguments to strings
        const text = args.map(arg => {
          if (arg.value !== undefined) {
            return String(arg.value);
          } else if (arg.description) {
            return arg.description;
          } else if (arg.type) {
            return `[${arg.type}]`;
          }
          return '';
        }).join(' ');

        // Add console message via ConsoleHandler
        consoleHandler.addMessage({
          tabId: source.tabId,
          level: level === 'warning' ? 'warn' : level, // Normalize 'warning' to 'warn'
          text: text,
          timestamp: Date.now(),
          url: params.stackTrace?.callFrames?.[0]?.url || 'unknown'
        });
        break;
      }
    }
  } catch (error) {
    logger.log(`[Background] Error handling CDP event ${method}:`, error);
  }
});

// Set up console message listener from content script
// Use sendResponse callback pattern for Chrome Manifest V3 compatibility
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Wrap in async IIFE to allow await
  (async () => {
    try {
      // Note: Console messages are handled by ConsoleHandler.setupMessageListener()
      // Do NOT handle them here to avoid duplication

      // Handle tech stack detection from content script
      if (message.type === 'techStackDetected' && sender.tab) {
        logger.log('[Background] Received tech stack:', message.stack);
        techStackInfo[sender.tab.id] = message.stack;

        // Update tab handler's tech stack info
        tabHandlers.setTechStackInfo(sender.tab.id, message.stack);
        return; // No response needed
      }

      // Handle stealth mode check from content script
      if (message.type === 'isStealthMode' && sender.tab) {
        const tabId = sender.tab.id;
        const isStealthMode = tabHandlers.tabStealthModes[tabId] === true;
        sendResponse({ isStealthMode });
        return;
      }

      // Handle OAuth login success from content script
      if (message.type === 'loginSuccess') {
        logger.logAlways('[Background] Login success - saving tokens');
        await chrome.storage.local.set({
          accessToken: message.accessToken,
          refreshToken: message.refreshToken,
          isPro: true
        });
        logger.logAlways('[Background] Tokens saved to storage');

        // Reconnect with new PRO mode credentials
        wsConnection.disconnect();
        await wsConnection.connect();

        sendResponse({ success: true });
        return;
      }

      // Handle connection status request from popup
      if (message.type === 'getConnectionStatus') {
        const status = {
          connected: wsConnection.isConnected,
          connectedTabId: tabHandlers.getAttachedTabId(),
          stealthMode: tabHandlers.stealthMode,
          projectName: wsConnection.projectName
        };
        sendResponse(status);
        return;
      }

      // Unknown message type
      logger.log('[Background] Unknown message type:', message.type);
    } catch (error) {
      logger.logAlways('[Background] Message handler error:', error);
      sendResponse({ error: error.message });
    }
  })();

  // Return true to indicate we'll send a response asynchronously
  return true;
});

// Initialize WebSocket connection
wsConnection = new WebSocketConnection(chrome, logger, iconManager, buildTimestamp);

// Listen for debugger detach events to keep state in sync
chrome.debugger.onDetach.addListener((source, reason) => {
  logger.log(`[Background] Debugger detached from tab ${source.tabId}, reason: ${reason}`);

  // Reset debugger state if it was detached from the current tab
  if (source.tabId === currentDebuggerTabId) {
    debuggerAttached = false;
    currentDebuggerTabId = null;
    logger.log('[Background] Debugger state reset');
  }
});

// Helper function to ensure debugger is attached to current tab
async function ensureDebuggerAttached() {
  const attachedTabId = tabHandlers.getAttachedTabId();

  if (!attachedTabId) {
    throw new Error('No tab attached');
  }

  // If debugger is already attached to this tab, we're good
  if (debuggerAttached && currentDebuggerTabId === attachedTabId) {
    return;
  }

  // Detach from previous tab if needed
  if (debuggerAttached && currentDebuggerTabId) {
    try {
      await chrome.debugger.detach({ tabId: currentDebuggerTabId });
      logger.log(`[Background] Detached debugger from tab ${currentDebuggerTabId}`);
    } catch (e) {
      logger.log(`[Background] Failed to detach debugger: ${e.message}`);
    }
  }

  // Attach to new tab
  try {
    await chrome.debugger.attach({ tabId: attachedTabId }, '1.3');
    debuggerAttached = true;
    currentDebuggerTabId = attachedTabId;
    logger.log(`[Background] Attached debugger to tab ${attachedTabId}`);

    // Enable Network domain for CDP network tracking
    try {
      await chrome.debugger.sendCommand(
        { tabId: attachedTabId },
        'Network.enable',
        {}
      );
      logger.log(`[Background] Enabled Network domain for tab ${attachedTabId}`);
    } catch (netError) {
      logger.log(`[Background] Warning: Could not enable Network domain: ${netError.message}`);
    }

    // Enable Runtime domain for console message capture (captures ALL console logs including extensions!)
    try {
      await chrome.debugger.sendCommand(
        { tabId: attachedTabId },
        'Runtime.enable',
        {}
      );
      logger.log(`[Background] Enabled Runtime domain for console capture on tab ${attachedTabId}`);
    } catch (runtimeError) {
      logger.log(`[Background] Warning: Could not enable Runtime domain: ${runtimeError.message}`);
    }
  } catch (error) {
    debuggerAttached = false;
    currentDebuggerTabId = null;
    throw new Error(`Failed to attach debugger: ${error.message}`);
  }
}

// Handle CDP commands from MCP server
async function handleCDPCommand(cdpMethod, cdpParams) {
  const attachedTabId = tabHandlers.getAttachedTabId();

  logger.log(`[Background] handleCDPCommand called: ${cdpMethod} tab: ${attachedTabId}`);

  if (!attachedTabId && cdpMethod !== 'Target.getTargets') {
    throw new Error('No tab attached. Call selectTab or createTab first.');
  }

  switch (cdpMethod) {
    case 'Target.getTargets':
      return await tabHandlers.getTabs();

    case 'Target.attachToTarget': {
      const tabId = cdpParams.targetId;
      return await tabHandlers.selectTab(parseInt(tabId));
    }

    case 'Target.createTarget': {
      const url = cdpParams.url || 'about:blank';
      return await tabHandlers.createTab(url);
    }

    case 'Target.closeTarget': {
      const tabId = cdpParams.targetId;
      return await tabHandlers.closeTab(parseInt(tabId));
    }

    case 'Page.navigate': {
      const url = cdpParams.url;

      // Check if trying to navigate to file:// URL without permission
      if (url.startsWith('file://')) {
        // Check if extension has file access permission
        const extensionInfo = await chrome.management.getSelf();
        if (!extensionInfo.hostPermissions.includes('file:///*') && !extensionInfo.hostPermissions.includes('<all_urls>')) {
          throw new Error(
            'Cannot navigate to file:// URLs. Please enable "Allow access to file URLs" in chrome://extensions/ for Blueprint MCP extension.'
          );
        }
      }

      // Navigate the tab
      await chrome.tabs.update(attachedTabId, { url });

      // Wait for navigation to complete
      await new Promise((resolve) => {
        const listener = (tabId, changeInfo) => {
          if (tabId === attachedTabId && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(resolve, 5000); // Timeout after 5 seconds
      });

      // Get the updated tab
      const navigatedTab = await chrome.tabs.get(attachedTabId);

      // Get tech stack if available
      const detectedStack = techStackInfo[attachedTabId] || null;
      const techStackMessage = detectedStack ? `\n\nDetected tech stack: ${JSON.stringify(detectedStack)}` : '';

      logger.logAlways('[Background] Page.navigate completed with tech stack:', detectedStack);

      return {
        url: navigatedTab.url,
        title: navigatedTab.title,
        techStack: detectedStack,
        message: `Navigated to ${navigatedTab.url}${techStackMessage}`
      };
    }

    case 'Page.reload':
      await chrome.tabs.reload(attachedTabId);
      await new Promise(resolve => setTimeout(resolve, 500));
      return { success: true };

    case 'Runtime.evaluate': {
      let expression = cdpParams.expression;

      try {
        // Wrap expression with method unwrapping if needed (ONLY in stealth mode)
        // This temporarily restores native DOM methods before execution
        // to bypass bot detection wrappers, then restores them after
        // Only enabled in stealth mode to avoid potential side effects
        if (tabHandlers.stealthMode && shouldUnwrap(expression)) {
          expression = wrapWithUnwrap(expression);
          logger.log('[Evaluate] Wrapped expression with unwrap logic (stealth mode)');
        }

        // Use Chrome Debugger Protocol for evaluation (like old TypeScript extension)
        // This provides better isolation and passes mainWorldExecution bot detection test
        await ensureDebuggerAttached();

        const result = await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'Runtime.evaluate',
          {
            expression: expression,
            returnByValue: cdpParams.returnByValue ?? true,
            awaitPromise: cdpParams.awaitPromise
          }
        );

        // Forward exceptionDetails if present (JavaScript syntax/runtime errors)
        if (result.exceptionDetails) {
          return {
            result: {
              type: result.result?.type || 'undefined',
              value: result.result?.value
            },
            exceptionDetails: result.exceptionDetails
          };
        }

        return {
          result: {
            type: result.result?.type || 'undefined',
            value: result.result?.value
          }
        };
      } catch (error) {
        return {
          exceptionDetails: {
            exception: {
              type: 'object',
              subtype: 'error',
              description: error.message
            },
            text: error.message
          }
        };
      }
    }

    case 'Input.dispatchMouseEvent':
      return await handleMouseEvent(cdpParams);

    case 'Input.dispatchKeyEvent': {
      // Use Chrome debugger for real trusted key events (enables form submission, etc.)
      await ensureDebuggerAttached();
      try {
        await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'Input.dispatchKeyEvent',
          cdpParams
        );
        return { success: true };
      } catch (error) {
        logger.log(`[Background] Input.dispatchKeyEvent error: ${error.message}`);
        return { success: false, error: error.message };
      }
    }

    case 'DOM.querySelector': {
      // Use real Chrome debugger DOM APIs for true nodeIds
      const selector = cdpParams.selector;
      const nodeId = cdpParams.nodeId || 1; // Default to document root

      try {
        await ensureDebuggerAttached();

        // Query selector using real Chrome debugger
        const result = await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'DOM.querySelector',
          { nodeId, selector }
        );

        return { nodeId: result.nodeId || 0 };
      } catch (error) {
        return { nodeId: 0, error: error.message };
      }
    }

    case 'DOM.enable': {
      // Enable DOM domain in Chrome debugger
      await ensureDebuggerAttached();

      try {
        await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'DOM.enable',
          {}
        );
        return {};
      } catch {
        // DOM may already be enabled, ignore errors
        return {};
      }
    }

    case 'CSS.enable': {
      // Enable CSS domain in Chrome debugger
      await ensureDebuggerAttached();

      try {
        await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'CSS.enable',
          {}
        );
        return {};
      } catch {
        // CSS may already be enabled, ignore errors
        return {};
      }
    }

    case 'CSS.getMatchedStylesForNode': {
      // Get matched CSS styles for a node
      await ensureDebuggerAttached();

      const selector = cdpParams.selector;
      const pseudoState = cdpParams.pseudoState || [];

      let nodeId = null;

      try {
        // First, enable DOM and CSS domains
        await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'DOM.enable',
          {}
        );

        await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'CSS.enable',
          {}
        );

        // Get document node
        const docResult = await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'DOM.getDocument',
          { depth: 0 }
        );

        const rootNodeId = docResult.root.nodeId;

        // Query selector to get the target node ID
        const queryResult = await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'DOM.querySelector',
          { nodeId: rootNodeId, selector: selector }
        );

        if (!queryResult.nodeId || queryResult.nodeId === 0) {
          throw new Error(`Element not found for selector: ${selector}`);
        }

        nodeId = queryResult.nodeId;

        // Force pseudo-state if requested (like DevTools "Toggle Element State")
        if (pseudoState.length > 0) {
          console.log('[Background Module] Forcing pseudo-state:', pseudoState, 'type:', typeof pseudoState, 'isArray:', Array.isArray(pseudoState));

          // Ensure pseudoState is an array
          const pseudoArray = Array.isArray(pseudoState) ? pseudoState : [pseudoState];

          await chrome.debugger.sendCommand(
            { tabId: attachedTabId },
            'CSS.forcePseudoState',
            {
              nodeId: nodeId,
              forcedPseudoClasses: pseudoArray
            }
          );
        }

        // Get matched styles for the node
        const stylesResult = await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'CSS.getMatchedStylesForNode',
          { nodeId: nodeId }
        );

        // Get stylesheet URLs using document.styleSheets
        // This gives us the actual URLs, but we need to match them to styleSheetIds
        const stylesheetInfo = await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'Runtime.evaluate',
          {
            expression: `
              Array.from(document.styleSheets).map((sheet, index) => {
                try {
                  return {
                    index: index,
                    href: sheet.href,
                    title: sheet.title,
                    disabled: sheet.disabled,
                    ruleCount: sheet.cssRules ? sheet.cssRules.length : 0
                  };
                } catch (e) {
                  return {
                    index: index,
                    href: sheet.href,
                    title: sheet.title,
                    error: e.message
                  };
                }
              })
            `,
            returnByValue: true
          }
        );

        const stylesheets = stylesheetInfo.result?.value || [];

        return {
          nodeId: nodeId,
          matchedCSSRules: stylesResult.matchedCSSRules || [],
          inlineStyle: stylesResult.inlineStyle || null,
          inherited: stylesResult.inherited || [],
          stylesheets: stylesheets
        };
      } catch (error) {
        console.error('[Background Module] Error getting styles:', error);
        throw error;
      } finally {
        // Clear forced pseudo-state if it was set
        if (nodeId && pseudoState.length > 0) {
          try {
            await chrome.debugger.sendCommand(
              { tabId: attachedTabId },
              'CSS.forcePseudoState',
              {
                nodeId: nodeId,
                forcedPseudoClasses: []
              }
            );
          } catch (cleanupError) {
            // Ignore cleanup errors (element may have been removed, etc.)
            console.warn('[Background Module] Error clearing forced pseudo-state:', cleanupError);
          }
        }
      }
    }

    case 'Network.enable': {
      // Enable Network domain in Chrome debugger
      await ensureDebuggerAttached();

      try {
        await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'Network.enable',
          {}
        );
        return {};
      } catch {
        // Network may already be enabled, ignore errors
        return {};
      }
    }

    case 'Network.getResponseBody': {
      // Get response body for a network request
      await ensureDebuggerAttached();

      try {
        const result = await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'Network.getResponseBody',
          { requestId: cdpParams.requestId }
        );
        return result;
      } catch (error) {
        return { error: error.message };
      }
    }

    case 'Network.getRequestPostData': {
      // Get POST data for a network request
      await ensureDebuggerAttached();

      try {
        const result = await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'Network.getRequestPostData',
          { requestId: cdpParams.requestId }
        );
        return { postData: result.postData };
      } catch (error) {
        return { error: error.message };
      }
    }

    case 'Fetch.enable': {
      // Enable Fetch domain in Chrome debugger for request interception
      await ensureDebuggerAttached();

      try {
        await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'Fetch.enable',
          cdpParams || {}
        );
        return {};
      } catch (error) {
        return { error: error.message };
      }
    }

    case 'Fetch.disable': {
      // Disable Fetch domain in Chrome debugger
      await ensureDebuggerAttached();

      try {
        await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'Fetch.disable',
          {}
        );
        return {};
      } catch (error) {
        return { error: error.message };
      }
    }

    case 'DOM.getDocument': {
      // Get real document from Chrome debugger
      await ensureDebuggerAttached();

      try {
        const result = await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'DOM.getDocument',
          { depth: cdpParams.depth || 0 }
        );
        return result;
      } catch (error) {
        throw new Error(`Failed to get document: ${error.message}`);
      }
    }

    case 'CSS.forcePseudoState': {
      // Force pseudo-state on element using CDP
      await ensureDebuggerAttached();

      const params = {
        nodeId: cdpParams.nodeId,
        forcedPseudoClasses: cdpParams.forcedPseudoClasses || []
      };

      try {
        await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'CSS.forcePseudoState',
          params
        );
        return {};
      } catch (error) {
        throw new Error(`Failed to force pseudo-state: ${error.message}`);
      }
    }

    case 'Page.captureScreenshot': {
      const format = cdpParams.format || 'jpeg';
      const quality = cdpParams.quality !== undefined ? cdpParams.quality : 80;
      const clip = cdpParams.clip; // Optional: {x, y, width, height, scale, coordinateSystem: 'viewport'|'page'}
      const selector = cdpParams.selector; // Optional: CSS selector to screenshot
      const padding = cdpParams.padding || 0; // Optional: padding around selector (px)

      try {
        // Use Chrome Debugger Protocol for screenshots (works on non-visible tabs!)
        await ensureDebuggerAttached();

        let finalClip = null;

        // Option 1: Screenshot by selector (get element bounds)
        if (selector) {
          // Find element and get its bounding box
          const evalResult = await chrome.debugger.sendCommand(
            { tabId: attachedTabId },
            'Runtime.evaluate',
            {
              expression: `
                (function() {
                  const el = document.querySelector(${JSON.stringify(selector)});
                  if (!el) return null;
                  const rect = el.getBoundingClientRect();
                  const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
                  const scrollY = window.pageYOffset || document.documentElement.scrollTop;
                  return {
                    x: rect.left,
                    y: rect.top,
                    width: rect.width,
                    height: rect.height,
                    pageX: rect.left + scrollX,
                    pageY: rect.top + scrollY
                  };
                })()
              `,
              returnByValue: true
            }
          );

          if (!evalResult.result.value) {
            throw new Error(`Element not found: ${selector}`);
          }

          const bounds = evalResult.result.value;

          // Apply padding - use page coordinates for captureBeyondViewport
          // scale: 1 captures at native resolution - downscaling handled server-side
          finalClip = {
            x: Math.max(0, bounds.pageX - padding),
            y: Math.max(0, bounds.pageY - padding),
            width: bounds.width + (padding * 2),
            height: bounds.height + (padding * 2),
            scale: 1
          };
        }
        // Option 2: Screenshot by coordinates
        else if (clip) {
          const coordinateSystem = clip.coordinateSystem || 'viewport';

          if (coordinateSystem === 'page') {
            // Convert page coordinates to viewport coordinates
            const scrollResult = await chrome.debugger.sendCommand(
              { tabId: attachedTabId },
              'Runtime.evaluate',
              {
                expression: `({x: window.pageXOffset || document.documentElement.scrollLeft, y: window.pageYOffset || document.documentElement.scrollTop})`,
                returnByValue: true
              }
            );
            const scroll = scrollResult.result.value;

            // scale: 1 captures at native resolution - downscaling handled server-side
            finalClip = {
              x: Number(clip.x) - scroll.x,
              y: Number(clip.y) - scroll.y,
              width: Number(clip.width),
              height: Number(clip.height),
              scale: 1
            };
          } else {
            // Use viewport coordinates as-is
            // scale: 1 captures at native resolution - downscaling handled server-side
            finalClip = {
              x: Number(clip.x) || 0,
              y: Number(clip.y) || 0,
              width: Number(clip.width),
              height: Number(clip.height),
              scale: 1
            };
          }
        }

        const params = {
          format: format,
          quality: format === 'jpeg' ? quality : undefined,
          // Enable captureBeyondViewport for selector screenshots to capture elements
          // that extend beyond the current viewport boundaries
          captureBeyondViewport: selector ? true : (cdpParams.captureBeyondViewport || false)
          // Note: fromSurface: false not allowed when using Debugger API
        };

        if (finalClip) {
          params.clip = finalClip;
        }

        // Capture screenshot (NO highlight yet - it will show AFTER)
        const result = await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'Page.captureScreenshot',
          params
        );

        // Show the actual screenshot AFTER capture with 500ms delay and fade animation
        if (finalClip && result.data) {
          const borderWidth = 3;
          const adjustedX = finalClip.x - borderWidth;
          const adjustedY = finalClip.y - borderWidth;

          setTimeout(async () => {
            try {
              await chrome.debugger.sendCommand(
                { tabId: attachedTabId },
                'Runtime.evaluate',
                {
                  expression: `
                    (function() {
                      const container = document.createElement('div');
                      container.id = 'mcp-screenshot-preview-' + Date.now();
                      container.style.cssText = \`
                        position: fixed;
                        left: ${adjustedX}px;
                        top: ${adjustedY}px;
                        width: ${finalClip.width}px;
                        height: ${finalClip.height}px;
                        z-index: 2147483647;
                        pointer-events: none;
                        opacity: 1;
                        transform: scale(1.2);
                        transform-origin: center center;
                        transition: transform 0.3s ease-out, box-shadow 0.3s ease-out;
                        box-shadow: 0 0 20px rgba(0,0,0,0.5);
                      \`;

                      const img = document.createElement('img');
                      img.src = 'data:image/${format};base64,${result.data}';
                      img.style.cssText = \`
                        width: 100%;
                        height: 100%;
                        border: 3px solid #4CAF50;
                        box-sizing: content-box;
                        border-radius: 4px;
                        transition: border-color 0.3s ease-in-out;
                        display: block;
                      \`;

                      container.appendChild(img);
                      document.body.appendChild(container);

                      // Stay visible at 120% for 1 second, then shrink and fade border/shadow
                      setTimeout(() => {
                        container.style.transform = 'scale(1)';
                        container.style.boxShadow = '0 0 0px rgba(0,0,0,0)';
                        img.style.borderColor = 'transparent';
                      }, 1000);

                      // Remove after animation completes (1s wait + 0.3s animation + 0.5s final display)
                      setTimeout(() => {
                        container.remove();
                      }, 1800);

                      return container.id;
                    })()
                  `,
                  returnByValue: true
                }
              );
            } catch (err) {
              console.error('Failed to show screenshot preview:', err);
            }
          }, 500);
        }

        return { data: result.data };
      } catch (error) {
        throw new Error(`Screenshot failed: ${error.message}`);
      }
    }

    case 'Accessibility.getFullAXTree': {
      // Use DOM-based snapshot with SLIM-style compact notation
      // Includes smart grouping and collapsing optimizations
      try {
        const results = await browserAdapter.executeScript(attachedTabId, {
          world: 'MAIN',  // Use MAIN world for DOM access
          func: function() {
            const maxLines = 200;
            let lineCount = 0;

            // Never group these important navigation/structure elements
            const noGroupTags = new Set(['nav', 'ul', 'ol', 'header', 'footer', 'form', 'table']);

            function getElementSignature(node) {
              // Get a short signature for skip messages
              let sig = node.nodeName.toLowerCase();
              if (node.id) sig += `#${node.id}`;
              else if (node.className && typeof node.className === 'string') {
                const firstClass = node.className.split(' ').filter(c => c)[0];
                if (firstClass) sig += `.${firstClass}`;
              }

              // Add text hint if it's a heading or has short text
              const text = node.textContent?.trim().substring(0, 30);
              if (text && (node.nodeName.match(/^H[1-6]$/) || text.length < 25)) {
                sig += ` "${text}"`;
              }

              return sig;
            }

            function formatChildren(children, depth, parentTag) {
              if (lineCount >= maxLines || depth > 10) return '';
              if (!children || children.length === 0) return '';

              const indent = '  '.repeat(depth);
              let output = '';

              // Check if we should group this level
              const shouldGroup = !noGroupTags.has(parentTag);

              if (!shouldGroup) {
                // Don't group - show all children
                for (let child of children) {
                  if (child.nodeType !== 1) continue;
                  if (lineCount >= maxLines) break;
                  output += formatNode(child, depth);
                }
                return output;
              }

              // Group consecutive children by tag name
              const groups = [];
              let currentGroup = null;

              for (let child of children) {
                if (child.nodeType !== 1) continue;

                const tagName = child.nodeName.toLowerCase();

                if (!currentGroup || currentGroup.tagName !== tagName) {
                  if (currentGroup) groups.push(currentGroup);
                  currentGroup = { tagName, nodes: [child] };
                } else {
                  currentGroup.nodes.push(child);
                }
              }
              if (currentGroup) groups.push(currentGroup);

              // Format groups with deduplication
              for (let group of groups) {
                if (lineCount >= maxLines) break;

                // Show all if 5 or fewer (less aggressive)
                if (group.nodes.length <= 5) {
                  for (let node of group.nodes) {
                    if (lineCount >= maxLines) break;
                    output += formatNode(node, depth);
                  }
                } else {
                  // Repetitive pattern: show first 2, skip middle, show last 1
                  const first = group.nodes.slice(0, 2);
                  const middle = group.nodes.slice(2, -1);
                  const last = group.nodes.slice(-1);

                  for (let node of first) {
                    if (lineCount >= maxLines) break;
                    output += formatNode(node, depth);
                  }

                  // Show what's being skipped
                  if (lineCount < maxLines && middle.length > 0) {
                    const signatures = middle.slice(0, 3).map(n => getElementSignature(n)).join(', ');
                    const more = middle.length > 3 ? `, ...${middle.length - 3} more` : '';
                    output += `${indent}... ${middle.length} more: ${signatures}${more}\n`;
                    lineCount++;
                  }

                  for (let node of last) {
                    if (lineCount >= maxLines) break;
                    output += formatNode(node, depth);
                  }
                }
              }

              return output;
            }

            function formatNode(node, depth) {
              if (lineCount >= maxLines || depth > 10 || !node || node.nodeType !== 1) return '';

              const indent = '  '.repeat(depth);
              const tagName = node.nodeName.toLowerCase();

              // Build SLIM-style selector
              let selector = tagName;
              if (node.id) {
                selector += `#${node.id}`;
              } else if (node.className && typeof node.className === 'string') {
                const classes = node.className.split(' ').filter(c => c).slice(0, 2);
                if (classes.length > 0) {
                  selector += `.${classes.join('.')}`;
                }
              }

              // Get important attributes based on element type
              const attrs = [];
              if (tagName === 'a' && node.href) {
                attrs.push(`href="${node.getAttribute('href')}"`);
              } else if (tagName === 'img' && node.src) {
                attrs.push(`src="${node.getAttribute('src')}"`);
              } else if (tagName === 'link' && node.href) {
                attrs.push(`href="${node.getAttribute('href')}"`);
              } else if (tagName === 'script' && node.src) {
                attrs.push(`src="${node.getAttribute('src')}"`);
              } else if (tagName === 'input') {
                const type = node.getAttribute('type');
                if (type) attrs.push(`type="${type}"`);
                const name = node.getAttribute('name');
                if (name) attrs.push(`name="${name}"`);
                const placeholder = node.getAttribute('placeholder');
                if (placeholder) attrs.push(`placeholder="${placeholder}"`);
              } else if (tagName === 'button' || tagName === 'form') {
                const type = node.getAttribute('type');
                if (type) attrs.push(`type="${type}"`);
                if (tagName === 'form') {
                  const action = node.getAttribute('action');
                  if (action) attrs.push(`action="${action}"`);
                  const method = node.getAttribute('method');
                  if (method) attrs.push(`method="${method}"`);
                }
              } else if (tagName === 'iframe') {
                const src = node.getAttribute('src');
                if (src) attrs.push(`src="${src}"`);
              }

              const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';

              // Get text content for leaf nodes only
              let text = '';
              if (node.children.length === 0 && node.textContent) {
                text = node.textContent.trim().substring(0, 50);
                if (text) {
                  text = ` "${text}"`;
                }
              }

              // Skip useless container divs/spans with no id/class and single child
              const isUselessContainer = (tagName === 'div' || tagName === 'span') &&
                                        selector === tagName &&
                                        !attrStr &&
                                        !text &&
                                        node.children.length === 1;

              if (isUselessContainer) {
                return formatNode(node.children[0], depth);
              }

              // Format the node line
              let output = `${indent}${selector}${attrStr}${text}\n`;
              lineCount++;

              // Process children
              if (lineCount < maxLines && node.children.length > 0) {
                output += formatChildren(node.children, depth + 1, tagName);
              }

              return output;
            }

            let snapshot = formatNode(document.body, 0);

            if (lineCount >= maxLines) {
              snapshot += `\n--- Snapshot truncated at ${maxLines} lines ---\n`;
            }

            return {
              formattedSnapshot: {
                preFormatted: true,
                text: snapshot
              }
            };
          }
        });

        return results[0] || { formattedSnapshot: { preFormatted: true, text: '' } };
      } catch (error) {
        throw new Error(`DOM snapshot failed: ${error.message}`);
      }
    }

    case 'Page.handleJavaScriptDialog': {
      const accept = cdpParams.accept !== false;
      const promptText = cdpParams.promptText || '';

      // Set up dialog overrides for this tab
      await dialogHandler.setupDialogOverrides(attachedTabId, accept, promptText);

      return { success: true };
    }

    case 'Runtime.getConsoleMessages':
      return { messages: consoleHandler.getMessages() };

    case 'Network.getRequestLog': {
      const limit = cdpParams.limit || 20;
      const offset = cdpParams.offset || 0;
      const urlPattern = cdpParams.urlPattern;
      const method = cdpParams.method;
      const status = cdpParams.status;
      const resourceType = cdpParams.resourceType;

      return networkTracker.getRequests({
        limit,
        offset,
        urlPattern,
        method,
        status,
        resourceType
      });
    }

    case 'Network.getRequestDetails': {
      const requestId = cdpParams.requestId;
      const jsonPath = cdpParams.jsonPath;

      return networkTracker.getRequestDetails(requestId, jsonPath);
    }

    case 'Network.clearRequestLog':
      networkTracker.clear();
      return { success: true };

    case 'Browser.getVersion':
      return {
        product: 'Chrome',
        userAgent: navigator.userAgent
      };

    case 'Emulation.setDeviceMetricsOverride': {
      const { width, height } = cdpParams;

      try {
        // Get the window containing the attached tab
        const tab = await chrome.tabs.get(attachedTabId);
        await chrome.windows.update(tab.windowId, {
          width: Math.round(width),
          height: Math.round(height)
        });

        return { success: true };
      } catch (error) {
        throw new Error(`Window resize failed: ${error.message}`);
      }
    }

    case 'Page.printToPDF': {
      try {
        await ensureDebuggerAttached();
        const result = await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'Page.printToPDF',
          {}
        );
        return result;
      } catch (error) {
        throw new Error(`PDF print failed: ${error.message}`);
      }
    }

    case 'Target.getTargetInfo': {
      try {
        // Get tab info
        const tab = await chrome.tabs.get(attachedTabId);

        // Get performance metrics using executeScript
        const results = await browserAdapter.executeScript(attachedTabId, {
          code: `
            (function() {
              const perfData = window.performance.getEntriesByType('navigation')[0];
              const paintData = window.performance.getEntriesByType('paint');

              const fcp = paintData.find(p => p.name === 'first-contentful-paint');
              const result = {
                loadEventEnd: perfData ? Math.round(perfData.loadEventEnd) : 0,
                domContentLoadedEventEnd: perfData ? Math.round(perfData.domContentLoadedEventEnd) : 0,
                firstContentfulPaint: fcp ? Math.round(fcp.startTime) : 0,
                url: window.location.href,
                title: document.title
              };

              return result;
            })()
          `
        });

        return {
          targetInfo: {
            targetId: String(attachedTabId),
            type: 'page',
            title: tab.title,
            url: tab.url,
            attached: true
          },
          performance: results[0] || {}
        };
      } catch (error) {
        throw new Error(`Get target info failed: ${error.message}`);
      }
    }

    case 'Performance.getMetrics': {
      try {
        await ensureDebuggerAttached();
        const result = await chrome.debugger.sendCommand(
          { tabId: attachedTabId },
          'Performance.getMetrics',
          {}
        );
        return result;
      } catch (error) {
        throw new Error(`Performance.getMetrics failed: ${error.message}`);
      }
    }

    case 'Runtime.getDialogEvents': {
      const attachedTabId = tabHandlers.getAttachedTabId();
      if (!attachedTabId) {
        throw new Error('No tab attached');
      }
      const events = await dialogHandler.getDialogEvents(attachedTabId);
      return { events };
    }

    default:
      throw new Error(`Unsupported CDP method: ${cdpMethod}`);
  }
}

// Mouse event handler
// Track last mousedown for click synthesis
let lastMouseDown = null;

async function handleMouseEvent(params) {
  const attachedTabId = tabHandlers.getAttachedTabId();
  const { type, x, y, button = 'left' } = params;
  // clickCount parameter not currently used

  // Only detect side effects on mouseReleased (final action of a click)
  const shouldDetectSideEffects = (type === 'mouseReleased');

  // Step 1: Capture initial state before click
  let initialState = null;
  let initialDialogCount = 0;
  if (shouldDetectSideEffects) {
    const initialTab = await chrome.tabs.get(attachedTabId);
    const dialogEvents = await dialogHandler.getDialogEvents(attachedTabId);
    initialState = {
      url: initialTab.url,
      title: initialTab.title,
      status: initialTab.status
    };
    initialDialogCount = dialogEvents.length;
  }

  // Step 2: Set up listeners for new tabs/windows
  let newTabsCreated = [];
  let tabCreatedListener = null;
  if (shouldDetectSideEffects) {
    tabCreatedListener = (tab) => {
      newTabsCreated.push({
        id: tab.id,
        url: tab.url || tab.pendingUrl,
        openerTabId: tab.openerTabId
      });
    };
    chrome.tabs.onCreated.addListener(tabCreatedListener);
  }

  // Convert CDP event types to DOM event types
  const eventTypeMap = {
    'mousePressed': 'mousedown',
    'mouseReleased': 'mouseup',
    'mouseMoved': 'mousemove'
  };
  const domEventType = eventTypeMap[type] || type;

  // Track mousedown for click synthesis
  if (type === 'mousePressed') {
    lastMouseDown = { x, y, button, timestamp: Date.now() };
  }

  // Step 3: Perform the click
  const results = await browserAdapter.executeScript(attachedTabId, {
    world: 'MAIN',  // Must use MAIN world for events to trigger handlers properly
    func: (eventType, x, y, buttonIndex, buttons, shouldSynthesizeClick) => {
      const el = document.elementFromPoint(x, y);
      if (!el) {
        return { success: false, error: 'No element at coordinates' };
      }

      // Dispatch the mouse event
      const event = new MouseEvent(eventType, {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: buttonIndex,
        buttons: buttons
      });

      el.dispatchEvent(event);

      // If this is mouseup and we should synthesize a click, dispatch click event
      if (shouldSynthesizeClick && eventType === 'mouseup') {
        const clickEvent = new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: buttonIndex,
          buttons: 0  // No buttons pressed during click event
        });
        el.dispatchEvent(clickEvent);
      }

      return { success: true, element: el.tagName, eventType: eventType };
    },
    args: [
      domEventType,
      x,
      y,
      button === 'left' ? 0 : button === 'right' ? 2 : 1,
      button === 'left' ? 1 : button === 'right' ? 2 : 4,
      // Synthesize click if this is mouseup and follows a recent mousedown at same position
      type === 'mouseReleased' && lastMouseDown &&
        lastMouseDown.x === x && lastMouseDown.y === y &&
        lastMouseDown.button === button &&
        (Date.now() - lastMouseDown.timestamp) < 1000  // Within 1 second
    ]
  });

  // Clear mousedown tracking after mouseup
  if (type === 'mouseReleased') {
    lastMouseDown = null;
  }

  const clickResult = results[0] || { success: false };

  // Step 4: Detect side effects (only for mouseReleased)
  if (shouldDetectSideEffects && clickResult.success) {
    // Wait a bit to see if navigation or other side effects start
    await new Promise(resolve => setTimeout(resolve, 200));

    // Check if navigation started
    let currentTab = await chrome.tabs.get(attachedTabId);
    const navigationStarted = currentTab.url !== initialState.url ||
                              currentTab.status === 'loading';

    // If navigation started, wait for it to complete (like Page.navigate does)
    if (navigationStarted && currentTab.status === 'loading') {
      await new Promise((resolve) => {
        const listener = (tabId, changeInfo) => {
          if (tabId === attachedTabId && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(resolve, 5000); // Timeout after 5 seconds
      });

      // Get final tab state after navigation completes
      currentTab = await chrome.tabs.get(attachedTabId);
    }

    // Remove tab creation listener
    if (tabCreatedListener) {
      chrome.tabs.onCreated.removeListener(tabCreatedListener);
    }

    // Detect all side effects
    const sideEffects = {};

    // Side effect 1: Navigation (URL/title changed)
    if (currentTab.url !== initialState.url) {
      sideEffects.navigation = {
        from: initialState.url,
        to: currentTab.url,
        title: currentTab.title,
        techStack: techStackInfo[attachedTabId] || null
      };
    }

    // Side effect 2: New tabs/windows spawned
    if (newTabsCreated.length > 0) {
      // Check which tabs actually loaded vs were blocked
      const tabPromises = newTabsCreated.map(async (tabInfo) => {
        try {
          const tab = await chrome.tabs.get(tabInfo.id);
          return {
            id: tab.id,
            url: tab.url,
            title: tab.title,
            status: 'opened'
          };
        } catch {
          // Tab was closed/blocked - likely popup blocker
          return {
            ...tabInfo,
            status: 'blocked'
          };
        }
      });

      const newTabs = await Promise.all(tabPromises);
      sideEffects.newTabs = newTabs;
    }

    // Side effect 3: Dialogs (alerts/confirms/prompts) shown
    const dialogEvents = await dialogHandler.getDialogEvents(attachedTabId);
    if (dialogEvents.length > initialDialogCount) {
      sideEffects.dialogs = dialogEvents.slice(initialDialogCount);
    }

    // Return enhanced response with side effects (matching Page.navigate pattern)
    return {
      ...clickResult,
      sideEffects: Object.keys(sideEffects).length > 0 ? sideEffects : null,
      url: currentTab.url,
      title: currentTab.title,
      techStack: sideEffects.navigation?.techStack || techStackInfo[attachedTabId] || null
    };
  }

  return clickResult;
}

// Register command handlers with WebSocket connection
wsConnection.registerCommandHandler('getTabs', async () => {
  return await tabHandlers.getTabs();
});

wsConnection.registerCommandHandler('get_build_info', async () => {
  return { buildTimestamp };
});

wsConnection.registerCommandHandler('get_debug_storage', async () => {
  // Read all debug storage values from extension background context
  const storage = await chrome.storage.local.get([
    'backgroundScriptLoaded',
    'listenerRegistered',
    'lastOnUpdatedEvent',
    'lastNavigation',
    'lastNotification'
  ]);
  return storage;
});

wsConnection.registerCommandHandler('selectTab', async (params) => {
  return await tabHandlers.selectTab(params);
});

wsConnection.registerCommandHandler('createTab', async (params) => {
  return await tabHandlers.createTab(params);
});

wsConnection.registerCommandHandler('closeTab', async (params) => {
  return await tabHandlers.closeTab(params?.index);
});

wsConnection.registerCommandHandler('openTestPage', async () => {
  // Open test page in new window
  const testPageUrl = 'https://blueprint-mcp.railsblueprint.com/test-page';
  const window = await chrome.windows.create({
    url: testPageUrl,
    type: 'normal',
    width: 1200,
    height: 900
  });

  return {
    success: true,
    url: testPageUrl,
    windowId: window.id,
    tabId: window.tabs[0].id
  };
});

wsConnection.registerCommandHandler('forwardCDPCommand', async (params) => {
  return await handleCDPCommand(params.method, params.params);
});

wsConnection.registerCommandHandler('reloadExtensions', async (params) => {
  const extensionName = params?.extensionName;
  const currentExtensionId = chrome.runtime.id;

  // Get all extensions
  const extensions = await chrome.management.getAll();
  const reloadedNames = [];
  const skippedPacked = [];

  for (const ext of extensions) {
    // Only reload unpacked/development extensions
    if (ext.type === 'extension' && ext.enabled && ext.installType === 'development') {
      // If specific extension requested, only reload that one
      if (extensionName && ext.name !== extensionName) {
        continue;
      }

      try {
        // Special handling for reloading ourselves
        if (ext.id === currentExtensionId) {
          logger.log(`Reloading self using runtime.reload()...`);
          // Use runtime.reload() for self-reload
          // This triggers a reload without disabling the extension
          chrome.runtime.reload();
          reloadedNames.push(ext.name);
        } else {
          // For other extensions, use management API (like Extensions Reloader)
          await chrome.management.setEnabled(ext.id, false);
          await chrome.management.setEnabled(ext.id, true);
          reloadedNames.push(ext.name);
          logger.log(`${ext.name} reloaded`);
        }
      } catch (e) {
        logger.log(`Could not reload ${ext.name}:`, e.message);
      }
    } else if (ext.type === 'extension' && ext.enabled && extensionName && ext.name === extensionName) {
      // User requested a specific packed extension - track it
      skippedPacked.push(ext.name);
    }
  }

  return {
    reloaded: reloadedNames,
    skippedPacked: skippedPacked,
    extensions: extensions.filter(e => e.type === 'extension').map(e => e.name)
  };
});

wsConnection.registerCommandHandler('getNetworkRequests', async () => {
  // Try CDP-tracked requests first (with proper requestIds for getResponseBody)
  const cdpRequests = Array.from(cdpNetworkRequests.values());

  // Fallback to webRequest tracker if no CDP requests
  if (cdpRequests.length === 0) {
    logger.log('[Background] No CDP requests, falling back to webRequest tracker');
    return { requests: networkTracker.getRequests() };
  }

  return { requests: cdpRequests };
});

wsConnection.registerCommandHandler('clearTracking', async () => {
  // Clear both CDP and webRequest trackers
  cdpNetworkRequests.clear();
  networkTracker.clearRequests();
  return { success: true };
});

wsConnection.registerCommandHandler('getResponseBody', async ({ requestId }) => {
  const attachedTabId = tabHandlers.getAttachedTabId();
  if (!attachedTabId) {
    return { error: 'No tab attached' };
  }

  try {
    // Ensure Network domain is enabled
    await handleCDPCommand('Network.enable', {});

    // Get response body via CDP
    const result = await handleCDPCommand('Network.getResponseBody', { requestId });
    return result;
  } catch (error) {
    return { error: error.message };
  }
});

wsConnection.registerCommandHandler('getRequestPostData', async ({ requestId }) => {
  const attachedTabId = tabHandlers.getAttachedTabId();
  if (!attachedTabId) {
    return { error: 'No tab attached' };
  }

  try {
    // Ensure Network domain is enabled
    await handleCDPCommand('Network.enable', {});

    // Get POST data via CDP
    const result = await handleCDPCommand('Network.getRequestPostData', { requestId });
    return result;
  } catch (error) {
    return { error: error.message };
  }
});

wsConnection.registerCommandHandler('getConsoleMessages', async () => {
  // Only return messages from the currently attached tab
  const attachedTabId = tabHandlers.getAttachedTabId();
  const messages = attachedTabId ? consoleHandler.getMessages(attachedTabId) : [];
  return { messages };
});

wsConnection.registerCommandHandler('clearConsoleMessages', async () => {
  consoleHandler.clearMessages();
  return { success: true };
});

wsConnection.registerCommandHandler('listExtensions', async () => {
  try {
    const extensions = await chrome.management.getAll();

    // Filter to only include extensions (not apps or themes)
    const extensionsList = extensions
      .filter(ext => ext.type === 'extension')
      .map(ext => ({
        id: ext.id,
        name: ext.name,
        version: ext.version,
        enabled: ext.enabled,
        description: ext.description || ''
      }));

    return { extensions: extensionsList };
  } catch (error) {
    throw new Error(`List extensions failed: ${error.message}`);
  }
});

// Listen for page navigation to re-inject console capture and dialog overrides
chrome.webNavigation.onCompleted.addListener(async (details) => {
  const attachedTabId = tabHandlers.getAttachedTabId();
  if (details.tabId === attachedTabId && details.frameId === 0) {
    logger.log('[Background] Page loaded, re-injecting console capture and dialog overrides');
    await consoleHandler.injectConsoleCapture(details.tabId);
    await dialogHandler.setupDialogOverrides(details.tabId);
  }
});

// Listen for storage changes (enable/disable from popup)
chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === 'local' && changes.extensionEnabled) {
    const isEnabled = changes.extensionEnabled.newValue !== false;
    logger.logAlways('[Background] Extension enabled state changed:', isEnabled);

    if (isEnabled) {
      // Connect
      logger.logAlways('[Background] Connecting to MCP server...');
      await wsConnection.connect();
    } else {
      // Disconnect
      logger.logAlways('[Background] Disconnecting from MCP server...');
      wsConnection.disconnect();
    }
  }
});

// Check if extension is enabled before connecting on startup
const storage = await chrome.storage.local.get(['extensionEnabled']);
const isEnabled = storage.extensionEnabled !== false; // default to true if not set

if (isEnabled) {
  // Connect to MCP server on startup
  await wsConnection.connect();
} else {
  logger.log('[Background] Extension is disabled, not connecting');
}

// End of main initialization
})();
