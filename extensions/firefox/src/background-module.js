/**
 * Firefox extension background script (modular version)
 * Connects to MCP server and handles browser automation commands
 *
 * Uses native ES6 modules via symlink to shared/ directory
 * No build step required - runs directly in browser
 */

// Import shared modules (via symlink)
import { Logger } from '../shared/utils/logger.js';
import { IconManager } from '../shared/utils/icons.js';
import { WebSocketConnection } from '../shared/connection/websocket.js';
import { TabHandlers } from '../shared/handlers/tabs.js';
import { NetworkTracker } from '../shared/handlers/network.js';
import { DialogHandler } from '../shared/handlers/dialogs.js';
import { ConsoleHandler } from '../shared/handlers/console.js';
import { createBrowserAdapter } from '../shared/adapters/browser.js';
import { wrapWithUnwrap, shouldUnwrap } from '../shared/utils/unwrap.js';
import { setupInstallHandler } from '../shared/handlers/install.js';

// Initialize browser adapter at top level (before async IIFE) for install handler
const browserAdapter = createBrowserAdapter();
const browser = browserAdapter.getRawAPI();

// Set up welcome page to open on first install (must be at top level)
// Browser name is auto-detected from manifest.json
setupInstallHandler(browser);

// Set up keepalive alarm at TOP LEVEL (prevents service worker suspension in MV3)
// This must be synchronous to ensure the listener is registered before service worker sleeps
if (browser.alarms) {
  browser.alarms.create('keepalive', { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keepalive') {
      console.log('[Background] Keepalive alarm - service worker active');
    }
  });
}

// Main initialization
(async () => {

/**
 * Execute script helper - Manifest V3 compatible
 * Uses MAIN world to execute arbitrary code without CSP restrictions
 *
 * @param {number} tabId - Tab ID
 * @param {object} options - Script options {code: string}
 * @returns {Promise<Array>} Array of execution results
 */
async function executeScript(tabId, options) {
  if (browser.scripting && browser.scripting.executeScript) {
    // Use MAIN world (Firefox 128+) - NOT blocked by page CSP
    // Official Firefox approach for executing arbitrary code
    const results = await browser.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',  // Run in page world - page CSP does not apply!
      func: (code) => {
        // In MAIN world, eval is allowed even on CSP-strict pages
        return eval(code);
      },
      args: [options.code]
    });

    // Return results in the same format as old tabs.executeScript
    return results.map(r => r.result);
  }

  throw new Error('No executeScript API available - scripting permission may be missing');
}

// Initialize logger
const logger = new Logger('Blueprint MCP for Firefox');
await logger.init(browser);
logger.logAlways('[Background] Extension loaded (modular version)');

// Read build timestamp (read once at startup)
let buildTimestamp = null;
try {
  const buildInfoUrl = browser.runtime.getURL('build-info.json');
  const response = await fetch(buildInfoUrl);
  const buildInfo = await response.json();
  buildTimestamp = buildInfo.timestamp;
  logger.log(`Build timestamp: ${buildTimestamp}`);
} catch (e) {
  logger.log('Could not read build-info.json:', e.message);
}

// Initialize all managers and handlers
const iconManager = new IconManager(browser, logger);
const tabHandlers = new TabHandlers(browser, logger, iconManager);
const networkTracker = new NetworkTracker(browser, logger);
const dialogHandler = new DialogHandler(browserAdapter, logger);
const consoleHandler = new ConsoleHandler(browserAdapter, logger);

// Initialize icon manager
iconManager.init();

// Initialize network tracker
networkTracker.init();

// State variables
let techStackInfo = {}; // Stores detected tech stack per tab
let pendingDialogResponse = null; // Stores response for next dialog

// Set up console message listener from content script
browser.runtime.onMessage.addListener(async (message, sender) => {
  if (message.type === 'console' && sender.tab) {
    consoleHandler.addMessage({
      tabId: sender.tab.id,
      level: message.level,
      text: message.text,
      timestamp: message.timestamp,
      url: sender.url
    });
  }

  // Handle tech stack detection from content script
  if (message.type === 'techStackDetected' && sender.tab) {
    logger.log('[Background] Received tech stack:', message.stack);
    techStackInfo[sender.tab.id] = message.stack;

    // Update tab handler's tech stack info
    tabHandlers.setTechStackInfo(sender.tab.id, message.stack);
  }

  // Handle stealth mode check from content script
  if (message.type === 'isStealthMode' && sender.tab) {
    const tabId = sender.tab.id;
    const isStealthMode = tabHandlers.tabStealthModes[tabId] === true;
    return { isStealthMode };
  }

  // Handle OAuth login success from content script
  if (message.type === 'loginSuccess') {
    logger.logAlways('[Background] Login success - saving tokens');
    await browser.storage.local.set({
      accessToken: message.accessToken,
      refreshToken: message.refreshToken,
      isPro: true
    });
    logger.logAlways('[Background] Tokens saved to storage');

    // Reconnect with new PRO mode credentials
    wsConnection.disconnect();
    await wsConnection.connect();

    return { success: true };
  }

  // Handle connection status request from popup
  if (message.type === 'getConnectionStatus') {
    const attachedTabId = tabHandlers.getAttachedTabId();
    const status = {
      connected: wsConnection.isConnected,
      connectedTabId: attachedTabId,
      stealthMode: attachedTabId ? (tabHandlers.tabStealthModes[attachedTabId] || false) : false,
      projectName: wsConnection.projectName
    };
    return status;
  }

  // Handle focus tab request from content script
  if (message.type === 'focusTab' && sender.tab) {
    logger.log('[Background] Focus tab request');
    await browser.tabs.update(sender.tab.id, { active: true });
    await browser.windows.update(sender.tab.windowId, { focused: true });
  }
});

// Set up console and dialog injectors for tab handlers
tabHandlers.setConsoleInjector((tabId) => consoleHandler.injectConsoleCapture(tabId));
tabHandlers.setDialogInjector((tabId) => dialogHandler.setupDialogOverrides(tabId));

// Listen for tab navigation to re-inject dialog overrides
browser.webNavigation.onCompleted.addListener(async (details) => {
  const attachedTabId = tabHandlers.getAttachedTabId();

  if (details.tabId === attachedTabId && details.frameId === 0) {
    logger.log('[Background] Page loaded, re-injecting dialog overrides and console capture');
    await consoleHandler.injectConsoleCapture(details.tabId);
    await dialogHandler.setupDialogOverrides(details.tabId);
  }
});

// Initialize WebSocket connection
const wsConnection = new WebSocketConnection(browser, logger, iconManager, buildTimestamp);

// Register command handlers with WebSocket connection
wsConnection.registerCommandHandler('getTabs', async () => {
  return await tabHandlers.getTabs();
});

wsConnection.registerCommandHandler('createTab', async (params) => {
  return await tabHandlers.createTab(params);
});

wsConnection.registerCommandHandler('selectTab', async (params) => {
  return await tabHandlers.selectTab(params);
});

wsConnection.registerCommandHandler('closeTab', async () => {
  return await tabHandlers.closeTab();
});

wsConnection.registerCommandHandler('openTestPage', async () => {
  // Open test page in new window
  const testPageUrl = 'https://blueprint-mcp.railsblueprint.com/test-page';
  const window = await browser.windows.create({
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

wsConnection.registerCommandHandler('getNetworkRequests', async () => {
  return { requests: networkTracker.getRequests() };
});

wsConnection.registerCommandHandler('clearTracking', async () => {
  networkTracker.clearRequests();
  return { success: true };
});

wsConnection.registerCommandHandler('getConsoleMessages', async () => {
  return { messages: consoleHandler.getMessages() };
});

wsConnection.registerCommandHandler('clearConsoleMessages', async () => {
  consoleHandler.clearMessages();
  return { success: true };
});

wsConnection.registerCommandHandler('forwardCDPCommand', async (params) => {
  return await handleCDPCommand(params);
});

wsConnection.registerCommandHandler('listExtensions', async () => {
  return await handleListExtensions();
});

wsConnection.registerCommandHandler('reloadExtensions', async (params) => {
  return await handleReloadExtensions(params);
});

wsConnection.registerCommandHandler('openTestPage', async () => {
  return await handleOpenTestPage();
});

// Start connection
wsConnection.connect();

//
// Firefox-specific handlers below
// These handle CDP translation and Firefox-specific features
//

/**
 * Handle CDP commands (translate to Firefox equivalents)
 * This is Firefox-specific since we need to translate Chrome DevTools Protocol
 * commands to Firefox WebExtensions API equivalents
 */
async function handleCDPCommand(params) {
  const { method, params: cdpParams } = params;
  const attachedTabId = tabHandlers.getAttachedTabId();

  logger.log('[Background] handleCDPCommand called:', method, 'tab:', attachedTabId);

  if (!attachedTabId) {
    throw new Error('No tab attached. Call selectTab or createTab first.');
  }

  switch (method) {
    case 'Page.navigate': {
      const targetUrl = cdpParams.url;

      // Clear old tech stack data before navigation
      if (techStackInfo[attachedTabId]) {
        logger.logAlways('[Background] Clearing old tech stack before navigation');
        delete techStackInfo[attachedTabId];
      }

      await browser.tabs.update(attachedTabId, { url: targetUrl });

      // Wait for navigation to complete
      logger.logAlways('[Background] Waiting for navigation to:', targetUrl);
      await new Promise((resolve) => {
        const listener = (details) => {
          logger.logAlways('[Background] webNavigation.onCompleted:', details.tabId, details.url, details.frameId);
          if (details.tabId === attachedTabId && details.url === targetUrl && details.frameId === 0) {
            logger.logAlways('[Background] Navigation completed to target URL');
            browser.webNavigation.onCompleted.removeListener(listener);
            resolve();
          }
        };
        browser.webNavigation.onCompleted.addListener(listener);

        // Timeout after 10 seconds
        setTimeout(() => {
          logger.logAlways('[Background] Navigation timeout - proceeding anyway');
          browser.webNavigation.onCompleted.removeListener(listener);
          resolve();
        }, 10000);
      });

      // Wait for tech stack detection
      logger.logAlways('[Background] Waiting for tech stack detection...');
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Get updated tab info
      const navigatedTab = await browser.tabs.get(attachedTabId);
      const detectedStack = techStackInfo[navigatedTab.id] || null;

      // Update tab handler with new tech stack
      tabHandlers.setTechStackInfo(navigatedTab.id, detectedStack);

      // Build tech stack message
      let techStackMessage = buildTechStackMessage(detectedStack);

      logger.logAlways('[Background] Page.navigate completed with tech stack:', detectedStack);

      return {
        url: navigatedTab.url,
        title: navigatedTab.title,
        techStack: detectedStack,
        message: `Navigated to ${navigatedTab.url}${techStackMessage}`
      };
    }

    case 'Page.reload':
      await browser.tabs.reload(attachedTabId);
      await new Promise(resolve => setTimeout(resolve, 500));
      return { success: true };

    case 'Runtime.evaluate': {
      let expression = cdpParams.expression;

      try {
        // Wrap expression with method unwrapping if needed (ONLY in stealth mode)
        // This temporarily restores native DOM methods before execution
        // to bypass bot detection wrappers, then restores them after
        // Only enabled in stealth mode to avoid potential side effects
        const isStealthMode = tabHandlers.tabStealthModes[attachedTabId] === true;
        if (isStealthMode && shouldUnwrap(expression)) {
          expression = wrapWithUnwrap(expression);
          logger.log('[Evaluate] Wrapped expression with unwrap logic (stealth mode)');
        }

        const results = await executeScript(attachedTabId, {
          code: expression
        });

        const result = results && results[0];

        return {
          result: {
            type: typeof result,
            value: result
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

    case 'Input.dispatchKeyEvent':
      return await handleKeyEvent(cdpParams);

    case 'Page.captureScreenshot': {
      try {
        // Get the attached tab info
        const tab = await browser.tabs.get(attachedTabId);
        const windowId = tab.windowId;

        // Check if attached tab is currently active in its window
        if (!tab.active) {
          throw new Error(`Cannot screenshot: attached tab (index ${tab.index}) is not active in its window. Please ensure the tab you want to screenshot is visible, or use browser_tabs with activate=true when attaching.`);
        }

        // Capture the visible tab in that window (which should be the attached tab)
        const dataUrl = await browser.tabs.captureVisibleTab(windowId, {
          format: cdpParams.format || 'png',
          quality: cdpParams.quality
        });

        const base64Data = dataUrl.split(',')[1];
        return { data: base64Data };
      } catch (error) {
        throw new Error(`Screenshot failed: ${error.message}`);
      }
    }

    case 'DOM.getDocument':
      // Return simplified document structure
      return {
        root: {
          nodeId: 1,
          nodeType: 9,
          nodeName: '#document',
          childNodeCount: 1
        }
      };

    case 'DOM.querySelector': {
      const selector = cdpParams.selector;

      try {
        const results = await executeScript(attachedTabId, {
          code: `
            (() => {
              const element = document.querySelector(${JSON.stringify(selector)});
              return element ? { exists: true } : { exists: false };
            })();
          `
        });

        if (results && results[0] && results[0].exists) {
          return { nodeId: Math.floor(Math.random() * 1000000) };
        } else {
          return { nodeId: 0 }; // 0 indicates not found
        }
      } catch (error) {
        return { nodeId: 0 };
      }
    }

    case 'Accessibility.getFullAXTree': {
      try {
        const results = await executeScript(attachedTabId, {
          code: `
            (() => {
              const maxLines = 200;
              const lines = [];

              const normalizeText = (value) => {
                if (!value) return '';
                return String(value).replace(/\\s+/g, ' ').trim();
              };

              const clip = (value, max = 80) => {
                if (!value) return '';
                return value.length > max ? value.substring(0, max - 1) + '…' : value;
              };

              const isSignificant = (el) => {
                const tag = el.tagName.toLowerCase();
                if (/^h[1-6]$/.test(tag)) return true;
                if (['main', 'nav', 'header', 'footer', 'aside', 'form', 'article', 'section'].includes(tag)) return true;
                if (el.matches('a, button, input, select, textarea, summary, [contenteditable="true"]')) return true;
                if (el.hasAttribute('role')) return true;
                const text = normalizeText(el.innerText || el.textContent);
                return text.length > 0 && text.length <= 60 && el.children.length === 0;
              };

              const describe = (el) => {
                const tag = el.tagName.toLowerCase();
                const role = el.getAttribute('role') || tag;
                const label = normalizeText(
                  el.getAttribute('aria-label') ||
                  el.getAttribute('title') ||
                  (el.tagName === 'INPUT' ? el.getAttribute('placeholder') : '') ||
                  el.innerText ||
                  el.textContent
                );
                let line = role;
                if (label) line += ': ' + clip(label);
                return line;
              };

              const walk = (el, depth) => {
                if (!(el instanceof Element)) return;
                if (lines.length >= maxLines) return;

                let nextDepth = depth;
                if (isSignificant(el)) {
                  lines.push('  '.repeat(depth) + describe(el));
                  nextDepth = depth + 1;
                }

                for (const child of el.children) {
                  if (lines.length >= maxLines) break;
                  walk(child, nextDepth);
                }
              };

              walk(document.body || document.documentElement, 0);

              const totalLines = lines.length;
              const truncated = totalLines >= maxLines;
              return {
                preFormatted: true,
                text: totalLines > 0 ? lines.join('\\n') : 'document',
                totalLines,
                truncated,
                truncationMessage: truncated ? 'Snapshot truncated at 200 lines' : null
              };
            })();
          `
        });

        return {
          formattedSnapshot: results[0] || {
            preFormatted: true,
            text: 'document',
            totalLines: 1,
            truncated: false
          }
        };
      } catch (error) {
        throw new Error(`Accessibility snapshot failed: ${error.message}`);
      }
    }

    case 'Target.getTargetInfo': {
      try {
        const tab = await browser.tabs.get(attachedTabId);
        const results = await executeScript(attachedTabId, {
          code: `
            (() => {
              const perfData = window.performance.getEntriesByType('navigation')[0];
              const paintData = window.performance.getEntriesByType('paint');
              const fcp = paintData.find(p => p.name === 'first-contentful-paint');

              return {
                loadEventEnd: perfData ? Math.round(perfData.loadEventEnd) : 0,
                domContentLoadedEventEnd: perfData ? Math.round(perfData.domContentLoadedEventEnd) : 0,
                firstContentfulPaint: fcp ? Math.round(fcp.startTime) : 0,
                url: window.location.href,
                title: document.title
              };
            })();
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

    case 'Performance.getMetrics':
      // Firefox extension mode does not expose CDP metrics; server calculates via Runtime.evaluate.
      return { metrics: [] };

    default:
      throw new Error(`Unsupported CDP method: ${method}`);
  }
}

/**
 * Handle mouse events via JavaScript injection
 */
async function handleMouseEvent(params) {
  const { type, x, y, button = 'left', clickCount = 1 } = params;
  const attachedTabId = tabHandlers.getAttachedTabId();

  if (!attachedTabId) {
    throw new Error('No tab attached');
  }

  const buttonMap = { left: 0, middle: 1, right: 2 };
  const buttonNum = buttonMap[button] || 0;

  let script = '';

  if (type === 'mouseMoved') {
    script = `
      (() => {
        const element = document.elementFromPoint(${x}, ${y});
        if (element) {
          const event = new MouseEvent('mousemove', {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: ${x},
            clientY: ${y}
          });
          element.dispatchEvent(event);
        }
      })();
    `;
  } else if (type === 'mousePressed') {
    script = `
      (() => {
        const element = document.elementFromPoint(${x}, ${y});
        if (element) {
          const event = new MouseEvent('mousedown', {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: ${x},
            clientY: ${y},
            button: ${buttonNum},
            detail: ${clickCount}
          });
          element.dispatchEvent(event);
        }
      })();
    `;
  } else if (type === 'mouseReleased') {
    script = `
      (() => {
        const element = document.elementFromPoint(${x}, ${y});
        if (element) {
          const mouseupEvent = new MouseEvent('mouseup', {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: ${x},
            clientY: ${y},
            button: ${buttonNum},
            detail: ${clickCount}
          });
          element.dispatchEvent(mouseupEvent);

          const clickEvent = new MouseEvent('click', {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: ${x},
            clientY: ${y},
            button: ${buttonNum},
            detail: ${clickCount}
          });
          element.dispatchEvent(clickEvent);
        }
      })();
    `;
  }

  try {
    await executeScript(attachedTabId, { code: script });
    return { success: true };
  } catch (error) {
    throw new Error(`Mouse event failed: ${error.message}`);
  }
}

/**
 * Handle keyboard events via JavaScript injection
 */
async function handleKeyEvent(params) {
  const { type, key, code, text } = params;
  const attachedTabId = tabHandlers.getAttachedTabId();

  if (!attachedTabId) {
    throw new Error('No tab attached');
  }

  // Map CDP event types to DOM event types
  const eventTypeMap = {
    keyDown: 'keydown',
    keyUp: 'keyup',
    char: 'keypress'
  };

  const domEventType = eventTypeMap[type] || type;

  const script = `
    (() => {
      const activeElement = document.activeElement || document.body;

      const event = new KeyboardEvent(${JSON.stringify(domEventType)}, {
        key: ${JSON.stringify(key || text || '')},
        code: ${JSON.stringify(code || '')},
        bubbles: true,
        cancelable: true
      });

      activeElement.dispatchEvent(event);

      // For text input, also update the value
      if (${JSON.stringify(text)} && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
        activeElement.value += ${JSON.stringify(text)};
        activeElement.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })();
  `;

  try {
    await executeScript(attachedTabId, { code: script });
    return { success: true };
  } catch (error) {
    throw new Error(`Key event failed: ${error.message}`);
  }
}

/**
 * Handle listExtensions command
 */
async function handleListExtensions() {
  try {
    const extensions = await browser.management.getAll();

    return {
      extensions: extensions
        .filter(ext => ext.type === 'extension' && ext.id !== browser.runtime.id)
        .map(ext => ({
          id: ext.id,
          name: ext.name,
          version: ext.version,
          enabled: ext.enabled,
          description: ext.description || ''
        }))
    };
  } catch (error) {
    throw new Error(`Failed to list extensions: ${error.message}`);
  }
}

/**
 * Handle reloadExtensions command
 * Only reloads unpacked/development extensions (like Extensions Reloader)
 */
async function handleReloadExtensions(params) {
  const extensionName = params?.extensionName;
  const currentExtensionId = browser.runtime.id;

  // Get all extensions
  const extensions = await browser.management.getAll();
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
          browser.runtime.reload();
          reloadedNames.push(ext.name);
        } else {
          // For other extensions, use management API (like Extensions Reloader)
          await browser.management.setEnabled(ext.id, false);
          await browser.management.setEnabled(ext.id, true);
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
}

/**
 * Handle openTestPage command
 */
async function handleOpenTestPage() {
  const testPageUrl = 'https://mcp-for-chrome.railsblueprint.com/test-page';

  const tab = await browser.tabs.create({
    url: testPageUrl,
    active: true
  });

  // Wait for page to load
  await new Promise(resolve => setTimeout(resolve, 1000));

  return {
    tab: { id: tab.id, url: tab.url },
    message: `Test page opened: ${testPageUrl}`
  };
}

/**
 * Build tech stack message from detected stack
 */
function buildTechStackMessage(detectedStack) {
  if (!detectedStack) {
    return '\n\n**Tech Stack:** Detection pending or page not yet loaded';
  }

  const parts = [];

  if (detectedStack.frameworks && detectedStack.frameworks.length > 0) {
    parts.push(`Frameworks: ${detectedStack.frameworks.join(', ')}`);
  }
  if (detectedStack.libraries && detectedStack.libraries.length > 0) {
    parts.push(`Libraries: ${detectedStack.libraries.join(', ')}`);
  }
  if (detectedStack.css && detectedStack.css.length > 0) {
    parts.push(`CSS: ${detectedStack.css.join(', ')}`);
  }
  if (detectedStack.devTools && detectedStack.devTools.length > 0) {
    parts.push(`Dev Tools: ${detectedStack.devTools.join(', ')}`);
  }

  if (parts.length > 0) {
    let message = '\n\n**Tech Stack Detected:**\n' + parts.map(p => `- ${p}`).join('\n');

    if (detectedStack.spa) {
      message += '\n- Single Page Application (SPA) detected';
    }
    if (detectedStack.obfuscatedCSS) {
      message += '\n\n⚠️ **Obfuscated CSS Detected:** Class names are minified/randomized. Do not attempt to use specific class names for selectors - use semantic HTML elements, ARIA labels, or data attributes instead.';
    }

    return message;
  } else {
    let message = '\n\n**Tech Stack:** None detected (static HTML or unknown frameworks)';

    if (detectedStack.obfuscatedCSS) {
      message += '\n\n⚠️ **Obfuscated CSS Detected:** Class names are minified/randomized. Do not attempt to use specific class names for selectors - use semantic HTML elements, ARIA labels, or data attributes instead.';
    }

    return message;
  }
}

logger.logAlways('[Background] Background script initialized with modular architecture');

})().catch(error => {
  console.error('[Background] Initialization failed:', error);
});
