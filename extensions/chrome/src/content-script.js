/**
 * Content script - vanilla JS version
 * - Watches for OAuth tokens in DOM (login flow)
 * - Detects tech stack (frameworks, libraries, CSS frameworks)
 * - Sends tech stack info to background script
 * - Forwards console messages from injected script to background
 */

// Listen for console messages from injected script
window.addEventListener('message', (event) => {
  // Only accept messages from same window
  if (event.source !== window) return;

  // Check for console message from injected script
  if (event.data && event.data.__blueprintConsole) {
    const message = event.data.__blueprintConsole;
    // Forward to background script
    chrome.runtime.sendMessage({
      type: 'console',
      level: message.level,
      text: message.text,
      timestamp: message.timestamp
    });
  }
});

// Pages allowed to hand login tokens to the extension.
// Keep in sync with TRUSTED_HOSTS in shared/utils/trust.js
// (content scripts cannot import ES modules). The background script
// re-checks sender.url, this guard just keeps the watcher off other sites.
const TRUSTED_LOGIN_HOSTS = [
  'mcp-for-chrome.railsblueprint.com',
  'mcp-for-firefox.railsblueprint.com',
  'mcp-for-edge.railsblueprint.com',
  'mcp-for-safari.railsblueprint.com',
  'mcp-for-brave.railsblueprint.com',
  'blueprint-mcp.railsblueprint.com'
];
const isTrustedLoginPage = window.location.protocol === 'https:' &&
  TRUSTED_LOGIN_HOSTS.includes(window.location.hostname);

// Watch for a div with class 'mcp-extension-tokens' containing data attributes
let focusRequested = false;
const observer = new MutationObserver(() => {
  // Check for focus request
  const focusElement = document.querySelector('.mcp-extension-focus-tab');
  if (focusElement && !focusRequested) {
    focusRequested = true; // once per page, don't steal focus on later DOM changes
    console.log('[Content Script] Focus request detected, focusing tab...');
    chrome.runtime.sendMessage({ type: 'focusTab' });
    // Don't disconnect - we still need to watch for tokens
  }

  // Check for tokens
  const tokenElement = document.querySelector('.mcp-extension-tokens');
  if (tokenElement) {
    const accessToken = tokenElement.getAttribute('data-access-token');
    const refreshToken = tokenElement.getAttribute('data-refresh-token');

    if (accessToken && refreshToken) {
      console.log('[Content Script] Found tokens in DOM, sending to background...');

      // Send to background script
      chrome.runtime.sendMessage({
        type: 'loginSuccess',
        accessToken: accessToken,
        refreshToken: refreshToken
      }, (response) => {
        console.log('[Content Script] Response from background:', response);

        // Close the window after successful token save
        setTimeout(() => {
          window.close();
        }, 500);
      });

      // Stop observing
      observer.disconnect();
    }
  }
});

// Start observing the document for changes (our own login pages only)
if (isTrustedLoginPage) {
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

// Silently watching for login tokens

/**
 * Tech stack detection
 * Detects frameworks, libraries, CSS frameworks, and dev tools
 */
function detectTechStack() {
  const stack = {
    frameworks: [],
    libraries: [],
    css: [],
    devTools: [],
    spa: false,
    autoReload: false,
    obfuscatedCSS: false
  };

  try {
    // JS Frameworks
    // React - check global object, dev tools hook, or mount point patterns
    if (window.React ||
        window.__REACT_DEVTOOLS_GLOBAL_HOOK__ ||
        document.getElementById('root') ||
        document.getElementById('react-root') ||
        document.querySelector('[id^="mount_"]')) {
      stack.frameworks.push('React');
      stack.spa = true;
    }
    if (window.Vue || window.__VUE__ || window.__VUE_DEVTOOLS_GLOBAL_HOOK__) {
      stack.frameworks.push('Vue');
      stack.spa = true;
    }
    if (window.ng || typeof window.getAllAngularRootElements === 'function') {
      stack.frameworks.push('Angular');
      stack.spa = true;
    }
    // Turbo/Hotwire - check multiple sources
    if (window.Turbo ||
        document.querySelector('turbo-frame') ||
        document.querySelector('meta[name="turbo-cache-control"]') ||
        (() => {
          try {
            const importmap = document.querySelector('script[type="importmap"]');
            return importmap?.textContent && (importmap.textContent.includes('@hotwired/turbo') || importmap.textContent.includes('turbo'));
          } catch { return false; }
        })()) {
      stack.frameworks.push('Turbo');
      stack.spa = true;
    }
    if (window.__NEXT_DATA__) {
      stack.frameworks.push('Next.js');
      stack.spa = true;
    }
    if (document.querySelector('[data-svelte]') || window.__SVELTE__) {
      stack.frameworks.push('Svelte');
      stack.spa = true;
    }
    if (window.Ember) {
      stack.frameworks.push('Ember');
      stack.spa = true;
    }
    // Google Wiz - Google's internal web components framework
    if (document.querySelector('c-wiz') || document.querySelector('c-data')) {
      stack.frameworks.push('Google Wiz');
      stack.spa = true;
    }
    // Polymer - Google's web components library (used on YouTube, etc.)
    if (window.Polymer ||
        document.querySelector('iron-iconset-svg') ||
        document.querySelector('ytd-app') ||
        document.querySelector('[is^="iron-"], [is^="paper-"], [is^="ytd-"]')) {
      stack.frameworks.push('Polymer');
      stack.spa = true;
    }

    // JS Libraries
    if (window.jQuery || window.$) {
      stack.libraries.push('jQuery');
    }
    if (window.htmx) {
      stack.libraries.push('htmx');
    }
    if (window.Stimulus || document.querySelector('[data-controller]')) {
      stack.libraries.push('Stimulus');
    }
    if (window.Alpine || document.querySelector('[x-data]')) {
      stack.libraries.push('Alpine.js');
    }
    if (window._ && window._.VERSION) {
      stack.libraries.push('Lodash');
    }
    if (window.moment) {
      stack.libraries.push('Moment.js');
    }

    // CSS Frameworks - check DOM elements and attributes
    if (document.querySelector('.container') &&
        (document.querySelector('[class*="col-"]') || document.querySelector('[data-bs-]'))) {
      stack.css.push('Bootstrap');
    }
    // Tailwind - check for distinctive patterns (avoid Bootstrap false positives)
    const hasTailwindColors = document.querySelector('[class*="text-"][class*="-500"], [class*="bg-"][class*="-600"], [class*="text-"][class*="-400"], [class*="bg-"][class*="-700"]');
    const hasTailwindUtilities = document.querySelector('[class*="w-full"], [class*="h-screen"], [class*="space-x-"], [class*="divide-"]');
    const bodyClasses = document.body.className;
    const hasStandaloneFlex = bodyClasses && bodyClasses.split(/\s+/).some(cls => cls === 'flex' || cls === 'grid' || cls === 'hidden' || cls === 'block');

    if (hasTailwindColors || hasTailwindUtilities || hasStandaloneFlex) {
      stack.css.push('Tailwind');
    }
    if (document.querySelector('[class*="Mui"]') || window.MaterialUI) {
      stack.css.push('Material-UI');
    }
    if (document.querySelector('.button.is-primary') || document.querySelector('.card.is-fullwidth')) {
      stack.css.push('Bulma');
    }
    // Ant Design - check for actual component classes
    if (document.querySelector('[class^="ant-"], [class*=" ant-"]')) {
      stack.css.push('Ant Design');
    }

    // Dev Tools / Auto-reload
    // Hotwire Spark - check multiple sources
    if (window.Spark ||
        document.querySelector('script[src*="hotwire_spark"]') ||
        document.querySelector('script[src*="hotwire-spark"]') ||
        (() => {
          try {
            const importmap = document.querySelector('script[type="importmap"]');
            return importmap?.textContent && (importmap.textContent.includes('@hotwired/spark') || importmap.textContent.includes('hotwire_spark'));
          } catch { return false; }
        })()) {
      stack.devTools.push('Hotwire Spark');
      stack.autoReload = true;
    }
    if (window.__vite__ || (window.import && window.import.meta && window.import.meta.hot)) {
      stack.devTools.push('Vite HMR');
      stack.autoReload = true;
    }
    if (window.webpackHotUpdate || (window.module && window.module.hot)) {
      stack.devTools.push('Webpack HMR');
      stack.autoReload = true;
    }
    if (window.parcelHotUpdate) {
      stack.devTools.push('Parcel HMR');
      stack.autoReload = true;
    }
    if (window.LiveReload) {
      stack.devTools.push('LiveReload');
      stack.autoReload = true;
    }

    // Check for obfuscated CSS (helps AI know not to guess class names)
    if (bodyClasses && bodyClasses.match(/\b_[a-z0-9]{4,}\b/)) {
      stack.obfuscatedCSS = true;
    }

  } catch (error) {
    console.error('[Content Script] Error detecting tech stack:', error);
  }

  return stack;
}

// Run detection on load (skip if stealth mode enabled)
async function sendTechStackDetection() {
  // Check if stealth mode is enabled for this tab by asking background
  try {
    const response = await chrome.runtime.sendMessage({ type: 'isStealthMode' });

    if (response && response.isStealthMode === true) {
      // Stealth mode enabled - skip tech stack detection
      return;
    }
  } catch {
    // If we can't check stealth mode, proceed with detection
  }

  const stack = detectTechStack();

  chrome.runtime.sendMessage({
    type: 'techStackDetected',
    stack: stack,
    url: window.location.href
  }).catch(() => {
    // Ignore errors if background isn't listening
  });
}

// Initial detection after page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(sendTechStackDetection, 100);
  });
} else {
  // Already loaded
  setTimeout(sendTechStackDetection, 100);
}

// Watch for URL changes (SPA navigation)
let lastUrl = window.location.href;
new MutationObserver(() => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    setTimeout(sendTechStackDetection, 200); // Give SPA time to render
  }
}).observe(document, { subtree: true, childList: true });

// Also listen for navigation events
window.addEventListener('popstate', () => {
  setTimeout(sendTechStackDetection, 200);
});

// Listen for Turbo navigation
if (window.Turbo) {
  document.addEventListener('turbo:load', () => {
    setTimeout(sendTechStackDetection, 100);
  });
}

/**
 * Listen for console messages from injected console capture script
 * The console capture script sends messages via postMessage
 * Guard against multiple content script executions
 */
if (!window.__blueprintContentScriptLoaded) {
  window.__blueprintContentScriptLoaded = true;

  window.addEventListener('message', (event) => {
    // Only accept messages from same origin
    if (event.source !== window) return;

    // Check for console message
    if (event.data && event.data.__blueprintConsole) {
      const message = event.data.__blueprintConsole;

      // Forward to background script
      chrome.runtime.sendMessage({
        type: 'console',
        level: message.level,
        text: message.text,
        timestamp: message.timestamp
      }).catch(() => {
        // Ignore errors if background isn't listening
      });
    }
  });
}
