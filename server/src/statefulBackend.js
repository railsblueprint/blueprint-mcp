/**
 * Stateful Backend for Extension Mode
 *
 * Manages connection states: passive -> active -> connected
 * - passive: Server ready, no connections, only connection tools available
 * - active: WebSocket server open, waiting for extension (standalone mode)
 * - connected: Extension connected
 *
 * Note: Authenticated mode (connecting to remote proxy) is handled separately
 */

const { OAuth2Client } = require('./oauth');
const { MCPConnection } = require('./mcpConnection');
const { UnifiedBackend } = require('./unifiedBackend');
const { ExtensionServer } = require('./extensionServer');
const { DirectTransport, ProxyTransport } = require('./transport');
const wrappers = require('./wrappers');
const fs = require('fs');
const path = require('path');

// Helper function for debug logging
function debugLog(...args) {
  if (global.DEBUG_MODE) {
    console.error(...args);
  }
}

class StatefulBackend {
  constructor(config) {
    debugLog('[StatefulBackend] Constructor - starting in PASSIVE mode');
    this._config = config;
    this._state = 'passive'; // 'passive', 'active', 'connected', 'authenticated_waiting'
    this._activeBackend = null;
    this._extensionServer = null; // Our WebSocket server for extension
    this._proxyConnection = null; // MCPConnection for proxy mode
    this._debugMode = config.debug || false;
    this._isAuthenticated = false; // Will be set based on stored tokens in initialize()
    this._userInfo = null; // Will contain {isPro, email} after authentication
    this._clientId = null; // Human-readable identifier from enable command
    this._availableBrowsers = null; // Cached list of available browsers from proxy (when multiple found)
    this._connectedBrowserName = null; // Name of currently connected browser
    this._attachedTab = null; // Currently attached tab {index, title, url}
    this._stealthMode = false; // Track if current tab is in stealth mode
    this._browserDisconnected = false; // Track if browser extension disconnected (proxy still connected)
    this._lastConnectedBrowserId = null; // Remember browser ID for auto-reconnect
    this._lastAttachedTab = null; // Remember last attached tab for auto-reattach
    this._oauthClient = new OAuth2Client({
      authBaseUrl: process.env.AUTH_BASE_URL || 'https://mcp-for-chrome.railsblueprint.com'
    });
  }

  async initialize(server, clientInfo) {
    debugLog('[StatefulBackend] Initialize called - staying in passive mode');
    this._server = server;
    this._clientInfo = clientInfo;

    // Check for stored authentication tokens (async, in background)
    // Store promise so tools can await it before checking auth status
    this._authCheckPromise = this._oauthClient.isAuthenticated().then(isAuth => {
      this._isAuthenticated = isAuth;
      if (isAuth) {
        debugLog('[StatefulBackend] Found stored authentication tokens');
        return this._oauthClient.getUserInfo();
      }
      return null;
    }).then(userInfo => {
      if (userInfo) {
        this._userInfo = userInfo;
        debugLog('[StatefulBackend] User authenticated:', this._userInfo);
      } else if (this._isAuthenticated) {
        debugLog('[StatefulBackend] Failed to decode token, clearing auth state');
        this._isAuthenticated = false;
        this._oauthClient.clearTokens().catch(err => debugLog('[StatefulBackend] Error clearing tokens:', err));
      }
    }).catch(error => {
      debugLog('[StatefulBackend] Error checking authentication (non-fatal):', error);
      this._isAuthenticated = false;
    });

    // Don't initialize tools backend here - it will be lazy-initialized in listTools()
    debugLog('[StatefulBackend] Initialize complete (tools backend will be lazy-loaded)');
  }

  /**
   * Ensure auth check has completed before proceeding
   * Tools that need auth status should call this first
   */
  async _ensureAuthChecked() {
    if (this._authCheckPromise) {
      await this._authCheckPromise;
    }
  }

  /**
   * Generate status header for all responses (1-liner)
   */
  _getStatusHeader() {
    const parts = [];

    // Mode and version (always shown, even when passive)
    const mode = this._isAuthenticated ? 'PRO' : 'FREE';
    const version = require('../package.json').version;

    // State - return early for passive/waiting states with mode and version
    if (this._state === 'passive') {
      return `🔴 ${mode} v${version} | Disabled\n---\n\n`;
    }

    if (this._state === 'authenticated_waiting') {
      return `⏳ ${mode} v${version} | Waiting for browser selection\n---\n\n`;
    }

    // Get build timestamp from connected extension (not from disk)
    let buildTime = null;
    if (this._activeBackend) {
      if (this._extensionServer) {
        buildTime = this._extensionServer.getBuildTimestamp();
      } else if (this._proxyConnection) {
        buildTime = this._proxyConnection._extensionBuildTimestamp;
      }

      // Format timestamp to HH:MM:SS if it's ISO format
      if (buildTime) {
        try {
          const date = new Date(buildTime);
          buildTime = date.toLocaleTimeString('en-US', { hour12: false });
        } catch (e) {
          // Keep original format if parsing fails
        }
      }
    }

    // Only show timestamp in debug mode
    const versionStr = (buildTime && this._debugMode) ? `v${version} [${buildTime}]` : `v${version}`;
    parts.push(`✅ ${mode} ${versionStr}`);

    // Browser - show disconnected status if browser disconnected
    if (this._browserDisconnected) {
      parts.push(`⚠️ Browser Disconnected`);
    } else if (this._connectedBrowserName) {
      parts.push(`🌐 ${this._connectedBrowserName}`);
    }

    // Tab - only show if browser not disconnected
    if (!this._browserDisconnected) {
      if (this._attachedTab) {
        // Show tab index and current URL (more useful than title for navigation tracking)
        const url = this._attachedTab.url || 'about:blank';
        const shortUrl = url.length > 50 ? url.substring(0, 47) + '...' : url;
        parts.push(`📄 Tab ${this._attachedTab.index}: ${shortUrl}`);

        // Show tech stack if available (compact format)
        if (this._attachedTab.techStack) {
          const tech = this._attachedTab.techStack;
          const techParts = [];
          if (tech.frameworks && tech.frameworks.length > 0) {
            techParts.push(tech.frameworks.join(', '));
          }
          if (tech.libraries && tech.libraries.length > 0) {
            techParts.push(tech.libraries.join(', '));
          }
          if (tech.css && tech.css.length > 0) {
            techParts.push(tech.css.join(', '));
          }
          if (techParts.length > 0) {
            parts.push(`🔧 ${techParts.join(' + ')}`);
          }
          // Show obfuscated CSS warning
          if (tech.obfuscatedCSS) {
            parts.push(`⚠️ Obfuscated CSS`);
          }
        }
      } else {
        parts.push(`⚠️ No tab attached`);
      }
    }

    // Stealth mode - only show if enabled
    if (this._stealthMode) {
      parts.push(`🕵️ Stealth`);
    }

    return parts.join(' | ') + '\n---\n\n';
  }

  async listTools() {
    debugLog(`[StatefulBackend] listTools() - state: ${this._state}, authenticated: ${this._isAuthenticated}, debug: ${this._debugMode}`);

    // Always return connection management tools
    const connectionTools = [
      {
        name: 'enable',
        description: 'STEP 1: Enable browser automation. Activates the browser extension connection and makes browser_ tools available. Provide a client_id (e.g., your project name) for stable connection tracking. In PRO mode with multiple browsers, this will return a list to choose from.',
        inputSchema: {
          type: 'object',
          properties: {
            client_id: {
              type: 'string',
              description: 'Human-readable identifier for this MCP client (e.g., "my-project", "task-automation"). Used for stable connection IDs and reconnection after restarts.'
            },
            force_free: {
              type: 'boolean',
              description: 'Force free mode (local standalone) even if PRO authentication tokens are present. Default: false.'
            }
          },
          required: ['client_id']
        },
        annotations: {
          title: 'Enable browser automation',
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false
        }
      },
      {
        name: 'disable',
        description: 'Disable browser automation and return to passive mode. Closes browser extension connection. After this, browser_ tools will not work until you call enable again.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        annotations: {
          title: 'Disable browser automation',
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false
        }
      },
      {
        name: 'browser_list',
        description: 'List all available browsers connected to the relay (PRO mode only). Use this to see what browsers are available before calling browser_connect to switch.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        },
        annotations: {
          title: 'List available browsers',
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false
        }
      },
      {
        name: 'browser_connect',
        description: 'Connect to a specific browser when multiple browsers are available (PRO mode only). Called after enable or browser_list returns a list of browsers to choose from.',
        inputSchema: {
          type: 'object',
          properties: {
            browser_id: {
              type: 'string',
              description: 'Browser extension ID from the list returned by enable or browser_list'
            }
          },
          required: ['browser_id']
        },
        annotations: {
          title: 'Connect to browser',
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false
        }
      },
      {
        name: 'status',
        description: 'Check current state: passive (not connected) or active/connected (browser automation enabled). Use this to verify connection status before calling browser_ tools.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        annotations: {
          title: 'Connection status',
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false
        }
      },
      {
        name: 'auth',
        description: 'Manage Blueprint MCP PRO authentication. Login to access unlimited browser tabs, logout to clear credentials, or check current authentication status.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['login', 'logout', 'status'],
              description: 'Action to perform: login (authenticate and get PRO access), logout (clear tokens), status (check current auth state)'
            }
          },
          required: ['action']
        },
        annotations: {
          title: 'Manage authentication',
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false
        }
      },
      {
        name: 'scripting',
        description: 'Automate repetitive browser tasks with external scripts. Use when page structure and selectors are already known. Scripts run independently without LLM involvement. Get instructions or install a wrapper for Python, JavaScript, or Ruby.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['instructions', 'install_wrapper'],
              description: 'Action: instructions (show usage guide) or install_wrapper (save wrapper file to disk)'
            },
            language: {
              type: 'string',
              enum: ['python', 'javascript', 'ruby'],
              description: 'Wrapper language (required for install_wrapper)'
            },
            path: {
              type: 'string',
              description: 'File path to save the wrapper (required for install_wrapper)'
            }
          },
          required: ['action']
        },
        annotations: {
          title: 'Scripting automation',
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false
        }
      }
    ];

    // Get browser tools from UnifiedBackend (with null transport, just for schemas)
    const dummyBackend = new UnifiedBackend(this._config, null);
    const browserTools = await dummyBackend.listTools();

    // Add debug tools if debug mode is enabled
    const debugTools = [];
    if (this._debugMode) {
      debugTools.push({
        name: 'reload_mcp',
        description: 'Reload the MCP server without disconnecting. Only available in debug mode. The server will exit with code 42, causing the wrapper to restart it.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        annotations: {
          title: 'Reload MCP server',
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false
        }
      });
    }

    debugLog(`[StatefulBackend] Returning ${connectionTools.length} connection tools + ${browserTools.length} browser tools + ${debugTools.length} debug tools`);

    return [...connectionTools, ...browserTools, ...debugTools];
  }

  async callTool(name, rawArguments, options = {}) {
    debugLog(`[StatefulBackend] callTool(${name}) - state: ${this._state}`);

    // Handle connection management tools
    switch (name) {
      case 'enable':
        return await this._handleEnable(rawArguments, options);

      case 'disable':
        return await this._handleDisable(options);

      case 'browser_list':
        return await this._handleBrowserList(options);

      case 'browser_connect':
        return await this._handleBrowserConnect(rawArguments, options);

      case 'status':
        return await this._handleStatus(options);

      case 'auth':
        return await this._handleAuth(rawArguments, options);

      case 'scripting':
        return await this._handleScripting(rawArguments, options);

      case 'reload_mcp':
        return await this._handleReloadMCP(options);
    }

    // Forward to active backend
    if (!this._activeBackend) {
      // Check if we're in authenticated_waiting state (PRO mode with multiple browsers)
      if (this._state === 'authenticated_waiting' && this._availableBrowsers) {
        const browserList = this._availableBrowsers.map(b => `  - ${b.name || 'Browser'} (${b.id})`).join('\n');
        if (options.rawResult) {
          return {
            success: false,
            error: 'browser_not_selected',
            message: 'Browser not selected. In PRO mode with multiple browsers, call browser_connect() after enable().',
            available_browsers: this._availableBrowsers.map(b => ({ id: b.id, name: b.name || 'Browser' })),
            hint: 'Or use: enable(client_id=..., auto_connect=true)'
          };
        }
        return {
          content: [{
            type: 'text',
            text: `### ⚠️ Browser Not Selected\n\n**Current State:** Authenticated, waiting for browser selection\n\nIn PRO mode with multiple browsers, you need to call \`browser_connect()\` after \`enable()\`.\n\n**Available browsers:**\n${browserList}\n\n**Example:**\n\`\`\`\nbrowser_connect browser_id='${this._availableBrowsers[0]?.id || 'ext-chrome-xxx'}'\n\`\`\`\n\n**Or use auto-connect:**\n\`\`\`\nenable client_id='my-script' auto_connect=true\n\`\`\``
          }],
          isError: true
        };
      }

      if (options.rawResult) {
        return {
          success: false,
          error: 'not_enabled',
          message: 'Browser automation not active. Call enable first.'
        };
      }
      return {
        content: [{
          type: 'text',
          text: `### ⚠️ Browser Automation Not Active\n\n**Current State:** Passive (disabled)\n\n**You must call \`enable\` first to activate browser automation.**\n\nAfter enabling:\n1. Browser automation will be active\n2. Then use \`browser_tabs\` to select or create a tab\n3. Then you can use other browser tools (navigate, interact, etc.)`
        }],
        isError: true
      };
    }

    return await this._activeBackend.callTool(name, rawArguments, options);
  }

  async _handleEnable(args = {}, options = {}) {
    // Validate client_id parameter
    if (!args.client_id || typeof args.client_id !== 'string' || args.client_id.trim().length === 0) {
      if (options.rawResult) {
        return { success: false, error: 'missing_client_id', message: 'client_id parameter is required' };
      }
      return {
        content: [{
          type: 'text',
          text: `### ⚠️ Missing Required Parameter\n\n**Error:** \`client_id\` parameter is required\n\n**Example:**\n\`\`\`\nenable client_id='my-project'\n\`\`\`\n\nProvide a human-readable identifier (e.g., your project name). This enables stable connection IDs and seamless reconnection after restarts.`
        }],
        isError: true
      };
    }

    if (this._state !== 'passive') {
      if (options.rawResult) {
        return {
          success: true,
          already_enabled: true,
          state: this._state,
          mode: this._isAuthenticated ? 'pro' : 'free',
          browser: this._connectedBrowserName,
          client_id: this._clientId
        };
      }
      return {
        content: [{
          type: 'text',
          text: this._getStatusHeader() +
                `### ✅ Already Enabled\n\n**Current State:** ${this._state}\n**Client ID:** ${this._clientId || 'unknown'}\n\n**Browser automation is already active!**\n\nYou can now use browser tools:\n- \`browser_tabs\` - List, select, or create tabs\n- \`browser_navigate\` - Navigate to URLs\n- \`browser_interact\` - Click, type, etc.\n- And more...\n\nTo restart, call \`disable\` first.`
        }]
      };
    }

    // Store client_id for this session
    this._clientId = args.client_id.trim();
    debugLog('[StatefulBackend] Client ID set to:', this._clientId);

    // Wait for auth check to complete before deciding connection mode
    await this._ensureAuthChecked();

    debugLog('[StatefulBackend] Attempting to connect...');

    // Check for force_free flag (overrides authentication)
    const forceFree = args.force_free === true;
    if (forceFree) {
      debugLog('[StatefulBackend] force_free=true, forcing free mode (standalone)');
      return await this._becomePrimary(options);
    }

    // Check if user has invalid token (authenticated but missing connectionUrl)
    if (this._isAuthenticated && !this._userInfo?.connectionUrl) {
      debugLog('[StatefulBackend] Invalid token: missing connection_url');
      if (options.rawResult) {
        return { success: false, error: 'invalid_token', message: 'Authentication token is missing connection_url' };
      }
      return {
        content: [{
          type: 'text',
          text: `### ❌ Invalid Authentication Token\n\n` +
                `Your authentication token is missing required information (connection_url).\n\n` +
                `**This can happen if:**\n` +
                `- The relay server was updated and token format changed\n` +
                `- The token was corrupted\n\n` +
                `**Please choose one option:**\n\n` +
                `1. **Continue in free mode (standalone):**\n` +
                `   Use the auth tool to logout:\n` +
                `   \`\`\`\n   auth action='logout'\n   \`\`\`\n` +
                `   Then connect again - you'll use local browser only\n\n` +
                `2. **Login again for relay access:**\n` +
                `   First logout, then login:\n` +
                `   \`\`\`\n   auth action='logout'\n   auth action='login'\n   \`\`\`\n` +
                `   Then connect - you'll get a fresh token with relay access`
        }],
        isError: true
      };
    }

    // Choose mode based on authentication
    if (this._isAuthenticated && this._userInfo?.connectionUrl) {
      debugLog('[StatefulBackend] Starting authenticated proxy mode');
      return await this._connectToProxy(options);
    } else {
      debugLog('[StatefulBackend] Starting standalone mode');
      return await this._becomePrimary(options);
    }
  }

  async _becomePrimary(options = {}) {
    try {
      debugLog('[StatefulBackend] Starting extension server...');

      // Create our WebSocket server for extension connection
      const port = this._config.port || 5555;
      this._extensionServer = new ExtensionServer(port, '127.0.0.1');
      await this._extensionServer.start();

      // Send client_id to extension if connected
      if (this._clientId) {
        this._extensionServer.setClientId(this._clientId);
      }

      // Handle extension reconnections (e.g., after extension reload)
      this._extensionServer.onReconnect = () => {
        debugLog('[StatefulBackend] Extension reconnected, resetting attached tab state...');
        this._attachedTab = null; // Clear attached tab since extension reloaded
        // Resend client_id to newly connected extension
        if (this._clientId) {
          this._extensionServer.setClientId(this._clientId);
        }
        // Keep the same state and backend since the server connection is still valid
      };

      // Monitor tab info updates (keep _attachedTab in sync with actual browser state)
      this._extensionServer.onTabInfoUpdate = (tabInfo) => {
        debugLog('[StatefulBackend] Tab info update:', tabInfo);

        // If tabInfo is null, clear the attached tab (tab was closed/detached)
        if (tabInfo === null) {
          debugLog('[StatefulBackend] Tab detached, clearing cached state');
          this._attachedTab = null;
          return;
        }

        // Update cached tab info with fresh data from browser
        // Accept updates even if tab ID changes (can happen after navigation or tab recreation)
        if (this._attachedTab) {
          this._attachedTab = {
            ...this._attachedTab,
            id: tabInfo.id,  // Update ID in case it changed
            title: tabInfo.title,
            url: tabInfo.url,
            index: tabInfo.index,
            techStack: tabInfo.techStack || null
          };
          debugLog('[StatefulBackend] Updated cached tab info:', this._attachedTab);
        }
      };

      // Create transport using the extension server
      const transport = new DirectTransport(this._extensionServer);

      // Create unified backend
      this._activeBackend = new UnifiedBackend(this._config, transport);
      await this._activeBackend.initialize(this._server, this._clientInfo, this);

      this._state = 'active';
      this._connectedBrowserName = 'Local Browser';  // Store browser name for standalone mode

      debugLog('[StatefulBackend] Standalone mode activated');

      // Notify client that tool list has changed (don't await - send async)
      this._notifyToolsListChanged().catch(err =>
        debugLog('[StatefulBackend] Error sending notification:', err)
      );

      if (options.rawResult) {
        return {
          success: true,
          state: this._state,
          mode: 'free',
          browser: this._connectedBrowserName,
          client_id: this._clientId,
          port: this._config.port || 5555
        };
      }

      return {
        content: [{
          type: 'text',
          text: this._getStatusHeader() +
                `### ✅ Browser Automation Activated!\n\n` +
                `**State:** Connected (standalone mode)\n` +
                `**Browser:** ${this._connectedBrowserName}\n\n` +
                `**Next Steps:**\n` +
                `1. Call \`browser_tabs action='list'\` to see available tabs\n` +
                `2. Call \`browser_tabs action='attach' index=N\` to attach to a tab\n` +
                `3. Or call \`browser_tabs action='new' url='https://...'\` to create a new tab\n\n` +
                `After attaching to a tab, you can use:\n` +
                `- \`browser_navigate\` - Navigate to URLs\n` +
                `- \`browser_interact\` - Click, type, etc.\n` +
                `- \`browser_snapshot\` - Get page content\n` +
                `- And more...`
        }]
      };
    } catch (error) {
      debugLog('[StatefulBackend] Failed to start standalone mode:', error);
      this._activeBackend = null;
      this._state = 'passive';

      // Check if it's a port binding error
      const port = this._config.port || 5555;
      const isPortError = error.message && (
        error.message.includes('EADDRINUSE') ||
        error.message.includes('address already in use') ||
        error.message.includes(`port ${port}`)
      );

      if (options.rawResult) {
        return {
          success: false,
          error: isPortError ? 'port_in_use' : 'connection_failed',
          message: error.message,
          port: port
        };
      }

      const errorMsg = isPortError
        ? `Port ${port} already in use. Disable MCP in other project or switch to PRO mode: https://blueprint-mcp.railsblueprint.com/pro`
        : `### Connection Failed\n\nFailed to start server:\n${error.message}`;

      return {
        content: [{
          type: 'text',
          text: errorMsg
        }],
        isError: true
      };
    }
  }

  async _connectToProxy(options = {}) {
    try {
      debugLog('[StatefulBackend] Connecting to remote proxy:', this._userInfo.connectionUrl);
      debugLog('[StatefulBackend] Client ID:', this._clientId);

      // Get stored tokens for authentication
      const tokens = await this._oauthClient.getStoredTokens();
      if (!tokens || !tokens.accessToken) {
        throw new Error('No access token found - please authenticate first');
      }

      // Create temporary MCPConnection to list browsers
      const mcpConnection = new MCPConnection({
        mode: 'proxy',
        url: this._userInfo.connectionUrl,
        accessToken: tokens.accessToken,
        clientId: this._clientId
      });

      // Connect and authenticate, then list extensions
      await mcpConnection._connectWebSocket(this._userInfo.connectionUrl);

      const handshakeParams = { access_token: tokens.accessToken };
      if (this._clientId) {
        handshakeParams.client_id = this._clientId;
      }

      await mcpConnection.sendRequest('mcp_handshake', handshakeParams);
      debugLog('[StatefulBackend] Authenticated with proxy');

      // List available extensions with retry logic to handle race condition
      // Extension might be connecting at the same time, give it more time
      let extensionsResult = null;
      let browsers = [];
      const maxRetries = 5;
      const retryDelays = [2000, 3000, 4000, 5000]; // 2s, 3s, 4s, 5s (total: 14s)

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        extensionsResult = await mcpConnection.sendRequest('list_extensions', {});
        debugLog(`[StatefulBackend] Available extensions (attempt ${attempt + 1}/${maxRetries}):`, extensionsResult);

        if (extensionsResult && extensionsResult.extensions && extensionsResult.extensions.length > 0) {
          browsers = extensionsResult.extensions;
          break;
        }

        // Wait before retrying (unless this is the last attempt)
        if (attempt < maxRetries - 1) {
          debugLog(`[StatefulBackend] No extensions found, waiting ${retryDelays[attempt]}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        }
      }

      if (browsers.length === 0) {
        await mcpConnection.close();
        const version = require('../package.json').version;
        throw new Error(`No browser extensions are connected to the proxy.\n\n` +
                        `**MCP Server:** v${version}\n` +
                        `**Tried:** ${maxRetries} times over 14 seconds\n\n` +
                        `The extension might still be connecting. Please:\n` +
                        `1. Check that the browser extension is installed and enabled\n` +
                        `2. Click the extension icon to verify it shows "Connected"\n` +
                        `3. Wait a few seconds and try again\n\n` +
                        `If the problem persists, try reloading the extension or restarting your browser.`);
      }

      if (browsers.length === 1) {
        // Single browser - auto-connect
        debugLog('[StatefulBackend] Single browser found, auto-connecting:', browsers[0].name);

        const connectResult = await mcpConnection.sendRequest('connect', { extension_id: browsers[0].id });
        mcpConnection._connectionId = connectResult.connection_id;
        mcpConnection._authenticated = true;
        mcpConnection._connected = true;

        // Monitor connection close events
        mcpConnection.onClose = (code, reason) => {
          debugLog('[StatefulBackend] Connection closed:', code, reason);
          console.error(`[StatefulBackend] ⚠️  Connection to browser "${browsers[0].name}" lost - resetting to passive state`);
          this._state = 'passive';
          this._activeBackend = null;
          this._proxyConnection = null;
        };

        // Monitor tab info updates (keep _attachedTab in sync with actual browser state)
        mcpConnection.onTabInfoUpdate = (tabInfo) => {
          console.error('[StatefulBackend] Tab info update callback called with:', tabInfo);
          console.error('[StatefulBackend] Current _attachedTab before update:', this._attachedTab);

          // If tabInfo is null, clear the attached tab (tab was closed/detached)
          if (tabInfo === null) {
            console.error('[StatefulBackend] Tab detached, clearing cached state');
            this._attachedTab = null;
            console.error('[StatefulBackend] _attachedTab after clearing:', this._attachedTab);
            return;
          }

          // Update cached tab info with fresh data from browser
          // Accept updates even if tab ID changes (can happen after navigation or tab recreation)
          if (this._attachedTab) {
            this._attachedTab = {
              ...this._attachedTab,
              id: tabInfo.id,  // Update ID in case it changed
              title: tabInfo.title,
              url: tabInfo.url,
              index: tabInfo.index,
              techStack: tabInfo.techStack || null
            };
            console.error('[StatefulBackend] Updated cached tab info:', this._attachedTab);
          }
        };

        // Create ProxyTransport using the MCPConnection
        const transport = new ProxyTransport(mcpConnection);

        // Create unified backend
        this._activeBackend = new UnifiedBackend(this._config, transport);
        await this._activeBackend.initialize(this._server, this._clientInfo, this);

        this._proxyConnection = mcpConnection;
        this._state = 'connected';
        this._connectedBrowserName = browsers[0].name || 'Browser';  // Store browser name

        debugLog('[StatefulBackend] Successfully auto-connected to single browser');

        // Get build timestamp from extension
        try {
          const buildInfo = await mcpConnection.sendRequest('get_build_info', {}, 5000);
          if (buildInfo && buildInfo.buildTimestamp) {
            mcpConnection._extensionBuildTimestamp = buildInfo.buildTimestamp;
            debugLog('[StatefulBackend] Extension build timestamp:', buildInfo.buildTimestamp);
          }
        } catch (e) {
          debugLog('[StatefulBackend] Failed to get build info:', e.message);
        }

        if (options.rawResult) {
          return {
            success: true,
            state: this._state,
            mode: 'pro',
            browser: this._connectedBrowserName,
            browser_id: browsers[0].id,
            client_id: this._clientId,
            email: this._userInfo.email
          };
        }

        return {
          content: [{
            type: 'text',
            text: this._getStatusHeader() +
                  `### ✅ Browser Automation Activated!\n\n` +
                  `**State:** Connected (proxy mode)\n` +
                  `**Email:** ${this._userInfo.email}\n` +
                  `**Browser:** ${this._connectedBrowserName}\n` +
                  `**Client ID:** ${this._clientId}\n\n` +
                  `**Next Steps:**\n` +
                  `1. Call \`browser_tabs action='list'\` to see available tabs\n` +
                  `2. Call \`browser_tabs action='attach' index=N\` to attach to a tab\n` +
                  `3. Or call \`browser_tabs action='new' url='https://...'\` to create a new tab\n\n` +
                  `After attaching to a tab, you can use:\n` +
                  `- \`browser_navigate\` - Navigate to URLs\n` +
                  `- \`browser_interact\` - Click, type, etc.\n` +
                  `- \`browser_snapshot\` - Get page content\n` +
                  `- And more...`
          }]
        };
      } else {
        // Multiple browsers - close connection and wait for user selection
        debugLog('[StatefulBackend] Multiple browsers found, waiting for user selection');
        await mcpConnection.close();

        // Store browsers and enter waiting state
        this._availableBrowsers = browsers;
        this._state = 'authenticated_waiting';

        // Format the browser list
        let browserList = '### 🔍 Multiple Browsers Found\n\n';
        browserList += `Found ${browsers.length} browsers connected to the proxy:\n\n`;

        browsers.forEach((browser, index) => {
          browserList += `${index + 1}. **${browser.name || 'Browser'}**\n`;
          browserList += `   - ID: \`${browser.id}\`\n`;
          if (browser.version) {
            browserList += `   - Version: ${browser.version}\n`;
          }
          browserList += `\n`;
        });

        browserList += `\n**Next Step:**\n`;
        browserList += `Call \`browser_connect browser_id='<id>'\` to connect to your chosen browser.\n\n`;
        browserList += `**Example:**\n`;
        browserList += `\`\`\`\nbrowser_connect browser_id='${browsers[0].id}'\n\`\`\``;

        if (options.rawResult) {
          return {
            success: true,
            state: this._state,
            mode: 'pro',
            multiple_browsers: true,
            browsers: browsers.map(b => ({ id: b.id, name: b.name || 'Browser', version: b.version })),
            client_id: this._clientId,
            email: this._userInfo.email
          };
        }

        return {
          content: [{
            type: 'text',
            text: browserList
          }]
        };
      }
    } catch (error) {
      debugLog('[StatefulBackend] Failed to connect to proxy:', error);

      if (options.rawResult) {
        return { success: false, error: 'connection_failed', message: error.message };
      }

      return {
        content: [{
          type: 'text',
          text: `### ❌ Connection Failed\n\nFailed to connect to remote proxy:\n${error.message}`
        }],
        isError: true
      };
    }
  }

  async _handleDisable(options = {}) {
    if (this._state === 'passive') {
      if (options.rawResult) {
        return { success: true, already_disabled: true, state: 'passive' };
      }
      return {
        content: [{
          type: 'text',
          text: this._getStatusHeader() +
                `### Already Disabled\n\n**State:** Passive (disabled)\n\nBrowser automation is not active. Call \`enable\` to activate it.`
        }]
      };
    }

    debugLog('[StatefulBackend] Disconnecting...');

    if (this._activeBackend) {
      this._activeBackend.serverClosed();
      this._activeBackend = null;
    }

    // Close proxy connection if we're in proxy mode. The extension stays
    // connected to the relay after we leave, so tell it this is a
    // deliberate disable — otherwise its debugger sessions (and the
    // "being debugged" banners) would persist indefinitely.
    if (this._proxyConnection) {
      try {
        this._proxyConnection.sendNotification('serverShuttingDown', {});
      } catch (error) {
        debugLog('[StatefulBackend] Could not notify extension of shutdown:', error.message);
      }
      await this._proxyConnection.close();
      this._proxyConnection = null;
    }

    // Stop extension server if in direct mode. This is a deliberate
    // disable, so the extension is told to drop debugger attachments now
    if (this._extensionServer) {
      debugLog('[StatefulBackend] Stopping ExtensionServer...');
      await this._extensionServer.stop({ notifyShutdown: true });
      this._extensionServer = null;
      debugLog('[StatefulBackend] ExtensionServer stopped');
    }

    this._state = 'passive';
    this._connectedBrowserName = null;  // Clear browser name
    this._attachedTab = null;  // Clear attached tab

    // Notify client that tool list has changed (back to connection tools only, don't await - send async)
    this._notifyToolsListChanged().catch(err =>
      debugLog('[StatefulBackend] Error sending notification:', err)
    );

    if (options.rawResult) {
      return { success: true, state: 'passive' };
    }

    return {
      content: [{
        type: 'text',
        text: this._getStatusHeader() +
              `### ✅ Disabled Successfully\n\n**State:** Passive (disabled)\n\nBrowser automation has been deactivated. Browser_ tools are no longer available.\n\nTo reactivate, call \`enable\` again.`
      }]
    };
  }

  async _handleStatus(options = {}) {
    // Build structured status for rawResult mode
    const statusData = {
      state: this._state,
      mode: this._isAuthenticated ? 'pro' : 'free',
      browser: this._connectedBrowserName,
      client_id: this._clientId,
      attached_tab: this._attachedTab ? {
        index: this._attachedTab.index,
        title: this._attachedTab.title,
        url: this._attachedTab.url
      } : null
    };

    if (options.rawResult) {
      return statusData;
    }

    if (this._state === 'passive') {
      return {
        content: [{
          type: 'text',
          text: this._getStatusHeader() +
                `### ❌ Disabled\n\n**State:** Passive\n\nBrowser automation is not active.\n\nUse the \`enable\` tool to activate browser automation.`
        }]
      };
    }

    if (this._state === 'authenticated_waiting') {
      return {
        content: [{
          type: 'text',
          text: this._getStatusHeader() +
                `### ⏳ Waiting for Browser Selection\n\n**State:** Authenticated, waiting\n\nMultiple browsers found. Use \`browser_connect\` to choose one.`
        }]
      };
    }

    const mode = this._isAuthenticated ? 'PRO' : 'Free';
    let statusText = `### ✅ Enabled\n\n`;
    statusText += `**Mode:** ${mode}\n`;

    if (this._connectedBrowserName) {
      statusText += `**Browser:** ${this._connectedBrowserName}\n`;
    }

    if (this._attachedTab) {
      statusText += `**Attached Tab:** #${this._attachedTab.index} - ${this._attachedTab.title || 'Untitled'}\n`;
      statusText += `**Tab URL:** ${this._attachedTab.url || 'N/A'}\n\n`;
      statusText += `✅ Ready for automation!`;
    } else {
      statusText += `\n⚠️  No tab attached yet. Use \`browser_tabs action='attach' index=N\` to attach to a tab.`;
    }

    return {
      content: [{
        type: 'text',
        text: this._getStatusHeader() + statusText
      }]
    };
  }

  async _handleBrowserList() {
    debugLog('[StatefulBackend] Handling browser_list...');

    // Only works in PRO mode when connected
    if (this._state !== 'connected' && this._state !== 'authenticated_waiting') {
      return {
        content: [{
          type: 'text',
          text: `### ⚠️ Not Connected\n\n` +
                `**Current State:** ${this._state}\n\n` +
                `\`browser_list\` only works in PRO mode after calling \`enable\`.\n\n` +
                `**How to use:**\n` +
                `1. Call \`enable client_id='my-project'\` in PRO mode\n` +
                `2. Call \`browser_list\` to see available browsers\n` +
                `3. Call \`browser_connect browser_id='...'\` to switch browsers`
        }],
        isError: true
      };
    }

    // Must be in PRO mode (proxy mode)
    if (!this._proxyConnection) {
      return {
        content: [{
          type: 'text',
          text: `### ⚠️ PRO Mode Only\n\n` +
                `\`browser_list\` only works in PRO mode (proxy connection).\n\n` +
                `You are currently in FREE mode (direct local connection).\n\n` +
                `To use PRO mode:\n` +
                `1. Call \`auth action='login'\` to authenticate\n` +
                `2. Call \`enable client_id='my-project'\` without \`force_free=true\``
        }],
        isError: true
      };
    }

    try {
      // Get list of available browsers from relay
      debugLog('[StatefulBackend] Requesting list of extensions from relay...');
      const result = await this._proxyConnection.sendRequest('list_extensions', {});

      const browsers = result.extensions || [];
      debugLog(`[StatefulBackend] Found ${browsers.length} browser(s)`);

      // Cache the list for browser_connect
      this._availableBrowsers = browsers;

      if (browsers.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `### No Browsers Available\n\n` +
                  `No browser extensions are currently connected to the relay.\n\n` +
                  `**To connect a browser:**\n` +
                  `1. Open your browser (Chrome/Firefox/Edge/Opera) with Blueprint MCP extension installed\n` +
                  `2. Extension should auto-connect to the relay\n` +
                  `3. Call \`browser_list\` again to see it`
          }],
          isError: false
        };
      }

      // Format browser list
      const browserList = browsers.map((browser, index) => {
        const current = (this._connectedBrowserName === browser.name) ? ' **(CURRENT)**' : '';
        return `${index + 1}. **${browser.name}**${current}\n   - ID: \`${browser.id}\``;
      }).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `### Available Browsers (${browsers.length})\n\n` +
                `${browserList}\n\n` +
                `**To switch browsers:**\n` +
                `\`\`\`\nbrowser_connect browser_id='<id>'\n\`\`\``
        }],
        isError: false
      };
    } catch (error) {
      debugLog('[StatefulBackend] Error listing browsers:', error);
      return {
        content: [{
          type: 'text',
          text: `### Error\n\n` +
                `Failed to list browsers: ${error.message}\n\n` +
                `The relay connection may have been lost. Try calling \`disable\` then \`enable\` again.`
        }],
        isError: true
      };
    }
  }

  async _handleBrowserConnect(args) {
    debugLog('[StatefulBackend] Handling browser_connect...');

    // Validate browser_id parameter
    if (!args?.browser_id || typeof args.browser_id !== 'string') {
      return {
        content: [{
          type: 'text',
          text: `### ⚠️ Missing Required Parameter\n\n` +
                `**Error:** \`browser_id\` parameter is required\n\n` +
                `**Example:**\n` +
                `\`\`\`\nbrowser_connect browser_id='chrome-abc123...'\n\`\`\`\n\n` +
                `Use the browser ID from the list shown by \`enable\`.`
        }],
        isError: true
      };
    }

    // Check if we're in the right state
    if (this._state !== 'authenticated_waiting' && this._state !== 'connected') {
      return {
        content: [{
          type: 'text',
          text: `### ⚠️ Invalid State\n\n` +
                `**Current State:** ${this._state}\n\n` +
                `\`browser_connect\` can only be called in PRO mode after authentication.\n\n` +
                `**Correct Flow:**\n` +
                `1. Call \`enable client_id='my-project'\`\n` +
                `2. Call \`browser_list\` to see available browsers\n` +
                `3. Then call \`browser_connect browser_id='...'\` to switch`
        }],
        isError: true
      };
    }

    // Check if we have cached browsers list
    if (!this._availableBrowsers || this._availableBrowsers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `### ⚠️ No Browsers Available\n\n` +
                `No browsers list cached. Please call \`browser_list\` first to see available browsers.`
        }],
        isError: true
      };
    }

    const browserId = args.browser_id.trim();

    // Find the selected browser
    const selectedBrowser = this._availableBrowsers.find(b => b.id === browserId);
    if (!selectedBrowser) {
      const availableIds = this._availableBrowsers.map(b => `- \`${b.id}\``).join('\n');
      return {
        content: [{
          type: 'text',
          text: `### ⚠️ Browser Not Found\n\n` +
                `Browser ID \`${browserId}\` not found in available browsers.\n\n` +
                `**Available browser IDs:**\n${availableIds}`
        }],
        isError: true
      };
    }

    try {
      debugLog('[StatefulBackend] Connecting to selected browser:', selectedBrowser.name);

      // Get stored tokens
      const tokens = await this._oauthClient.getStoredTokens();
      if (!tokens || !tokens.accessToken) {
        throw new Error('No access token found - please authenticate first');
      }

      // Create new MCPConnection for this browser
      const mcpConnection = new MCPConnection({
        mode: 'proxy',
        url: this._userInfo.connectionUrl,
        accessToken: tokens.accessToken,
        clientId: this._clientId
      });

      // Connect and authenticate
      await mcpConnection._connectWebSocket(this._userInfo.connectionUrl);

      const handshakeParams = { access_token: tokens.accessToken };
      if (this._clientId) {
        handshakeParams.client_id = this._clientId;
      }

      await mcpConnection.sendRequest('mcp_handshake', handshakeParams);

      // Connect to the selected browser
      const connectResult = await mcpConnection.sendRequest('connect', { extension_id: browserId });
      mcpConnection._connectionId = connectResult.connection_id;
      mcpConnection._authenticated = true;
      mcpConnection._connected = true;

      // Monitor browser disconnection (extension disconnects, proxy stays connected)
      mcpConnection.onBrowserDisconnected = (params) => {
        debugLog('[StatefulBackend] Browser disconnected:', params);
        console.error(`[StatefulBackend] ⚠️  Browser extension "${this._connectedBrowserName}" disconnected`);

        // Mark browser as disconnected but keep proxy connection alive
        this._browserDisconnected = true;

        // Remember what we were connected to for auto-reconnect
        this._lastConnectedBrowserId = this._lastConnectedBrowserId || selectedBrowser.id;
        this._lastAttachedTab = this._attachedTab; // Remember current tab

        // Clear current connection state
        this._attachedTab = null;
      };

      // Handle browser reconnection
      mcpConnection.onBrowserReconnected = async (params) => {
        debugLog('[StatefulBackend] Browser reconnected:', params);
        console.error(`[StatefulBackend] ✅ Browser extension "${params.name || this._connectedBrowserName}" reconnected`);

        // Re-establish connection to the extension (get new connection_id)
        try {
          debugLog('[StatefulBackend] Re-connecting to extension:', params.id);
          const connectResult = await mcpConnection.sendRequest('connect', { extension_id: params.id });
          mcpConnection._connectionId = connectResult.connection_id;
          debugLog('[StatefulBackend] Re-connected with new connection_id:', connectResult.connection_id);

          // Clear the disconnected flag - browser is back online and connected
          this._browserDisconnected = false;

          console.error(`[StatefulBackend] ✅ Connection re-established to "${params.name}"`);

          // Fetch build timestamp from extension (may have been updated on reload)
          try {
            const buildInfo = await mcpConnection.sendRequest('get_build_info', {}, 5000);
            if (buildInfo && buildInfo.buildTimestamp) {
              mcpConnection._extensionBuildTimestamp = buildInfo.buildTimestamp;
              debugLog('[StatefulBackend] Extension build timestamp updated:', buildInfo.buildTimestamp);
            }
          } catch (e) {
            debugLog('[StatefulBackend] Failed to get build info on reconnect:', e.message);
          }
        } catch (error) {
          console.error(`[StatefulBackend] ⚠️  Failed to re-connect to extension:`, error.message);
          // Keep disconnected flag set if reconnection failed
        }

        // Note: We don't automatically restore _attachedTab here because the tab may have been closed
        // during the disconnection. The user can re-attach to a tab manually if needed.
      };

      // Monitor tab info updates (keep _attachedTab in sync with actual browser state)
      mcpConnection.onTabInfoUpdate = (tabInfo) => {
        debugLog('[StatefulBackend] Tab info update:', tabInfo);

        // If tabInfo is null, clear the attached tab (tab was closed/detached)
        if (tabInfo === null) {
          debugLog('[StatefulBackend] Tab detached, clearing cached state');
          this._attachedTab = null;
          return;
        }

        // Update cached tab info with fresh data from browser
        // Accept updates even if tab ID changes (can happen after navigation or tab recreation)
        if (this._attachedTab) {
          this._attachedTab = {
            ...this._attachedTab,
            id: tabInfo.id,  // Update ID in case it changed
            title: tabInfo.title,
            url: tabInfo.url,
            index: tabInfo.index,
            techStack: tabInfo.techStack || null
          };
          debugLog('[StatefulBackend] Updated cached tab info:', this._attachedTab);
        }
      };

      // Monitor connection close events (proxy connection lost)
      mcpConnection.onClose = (code, reason) => {
        debugLog('[StatefulBackend] Proxy connection closed:', code, reason);
        console.error(`[StatefulBackend] ⚠️  Proxy connection lost - resetting to passive state`);
        this._state = 'passive';
        this._activeBackend = null;
        this._proxyConnection = null;
        this._attachedTab = null;
        this._connectedBrowserName = null;
        this._browserDisconnected = false;
        this._lastConnectedBrowserId = null;
        this._lastAttachedTab = null;
      };

      // Create ProxyTransport using the MCPConnection
      const transport = new ProxyTransport(mcpConnection);

      // Create unified backend
      this._activeBackend = new UnifiedBackend(this._config, transport);
      await this._activeBackend.initialize(this._server, this._clientInfo, this);

      this._proxyConnection = mcpConnection;
      this._state = 'connected';
      this._connectedBrowserName = selectedBrowser.name || 'Browser';  // Store browser name
      this._lastConnectedBrowserId = selectedBrowser.id; // Remember for auto-reconnect
      this._browserDisconnected = false; // Reset disconnected flag
      this._availableBrowsers = null; // Clear the cache

      debugLog('[StatefulBackend] Successfully connected to selected browser');

      // Get build timestamp from extension
      try {
        const buildInfo = await mcpConnection.sendRequest('get_build_info', {}, 5000);
        if (buildInfo && buildInfo.buildTimestamp) {
          mcpConnection._extensionBuildTimestamp = buildInfo.buildTimestamp;
          debugLog('[StatefulBackend] Extension build timestamp:', buildInfo.buildTimestamp);
        }
      } catch (e) {
        debugLog('[StatefulBackend] Failed to get build info:', e.message);
      }

      return {
        content: [{
          type: 'text',
          text: this._getStatusHeader() +
                `### ✅ Browser Automation Activated!\n\n` +
                `**State:** Connected (proxy mode)\n` +
                `**Email:** ${this._userInfo.email}\n` +
                `**Browser:** ${this._connectedBrowserName}\n` +
                `**Client ID:** ${this._clientId}\n\n` +
                `**Next Steps:**\n` +
                `1. Call \`browser_tabs action='list'\` to see available tabs\n` +
                `2. Call \`browser_tabs action='attach' index=N\` to attach to a tab\n` +
                `3. Or call \`browser_tabs action='new' url='https://...'\` to create a new tab\n\n` +
                `After attaching to a tab, you can use:\n` +
                `- \`browser_navigate\` - Navigate to URLs\n` +
                `- \`browser_interact\` - Click, type, etc.\n` +
                `- \`browser_snapshot\` - Get page content\n` +
                `- And more...`
        }]
      };
    } catch (error) {
      debugLog('[StatefulBackend] Failed to connect to browser:', error);
      this._state = 'passive';
      this._availableBrowsers = null;

      return {
        content: [{
          type: 'text',
          text: `### ❌ Connection Failed\n\nFailed to connect to browser "${selectedBrowser.name}":\n${error.message}\n\nPlease try calling \`enable\` again.`
        }],
        isError: true
      };
    }
  }

  async _notifyToolsListChanged() {
    if (!this._server) {
      debugLog('[StatefulBackend] Cannot send notification - no server reference');
      return;
    }

    try {
      debugLog('[StatefulBackend] Sending notifications/tools/list_changed');
      // Use the official MCP SDK helper method
      await this._server.sendToolListChanged();
      debugLog('[StatefulBackend] Notification sent successfully');
    } catch (error) {
      debugLog('[StatefulBackend] Failed to send tool list changed notification:', error);
    }
  }

  async _handleAuth(args) {
    const action = args?.action;

    if (!action) {
      return {
        content: [{
          type: 'text',
          text: `### Error\n\nMissing required 'action' parameter.\n\nValid actions: login, logout, status`
        }],
        isError: true
      };
    }

    switch (action) {
      case 'login':
        return await this._handleLogin();
      case 'logout':
        return await this._handleLogout();
      case 'status':
        return await this._handleAuthStatus();
      default:
        return {
          content: [{
            type: 'text',
            text: `### Error\n\nInvalid action: ${action}\n\nValid actions: login, logout, status`
          }],
          isError: true
        };
    }
  }

  async _handleReloadMCP() {
    if (!this._debugMode) {
      return {
        content: [{
          type: 'text',
          text: '### Error\n\nreload_mcp is only available in debug mode. Start the server with --debug flag.'
        }],
        isError: true
      };
    }

    debugLog('[StatefulBackend] Reload requested, exiting with code 42...');

    // Send success response before exiting
    setTimeout(() => {
      process.exit(42);  // Exit code 42 triggers wrapper to restart
    }, 100);

    return {
      content: [{
        type: 'text',
        text: '### ✅ Reloading MCP Server\n\nThe server will restart momentarily...'
      }]
    };
  }

  async _handleLogin() {
    debugLog('[StatefulBackend] Handling login...');

    if (this._isAuthenticated) {
      return {
        content: [{
          type: 'text',
          text: `### Already Authenticated\n\nYou are already logged in as: ${this._userInfo?.email || 'Unknown'}\n\nUse auth action='logout' to sign out and authenticate with a different account.`
        }]
      };
    }

    try {
      debugLog('[StatefulBackend] Starting OAuth flow...');

      const tokens = await this._oauthClient.authenticate();

      debugLog('[StatefulBackend] Authentication successful, decoding token...');

      // Decode token and get user info
      this._userInfo = await this._oauthClient.getUserInfo();

      if (!this._userInfo) {
        debugLog('[StatefulBackend] Failed to decode token');
        await this._oauthClient.clearTokens();

        return {
          content: [{
            type: 'text',
            text: `### Authentication Failed\n\nFailed to decode authentication token. Please try again.`
          }],
          isError: true
        };
      }

      this._isAuthenticated = true;

      debugLog('[StatefulBackend] Authentication complete:', this._userInfo);

      return {
        content: [{
          type: 'text',
          text: `### ✅ Authentication Successful!\n\n` +
                `**Email:** ${this._userInfo.email}\n` +
                `**Status:** ✅ PRO Account\n\n` +
                `You now have access to PRO features including unlimited browser tabs!`
        }]
      };
    } catch (error) {
      debugLog('[StatefulBackend] Authentication error:', error);

      return {
        content: [{
          type: 'text',
          text: `### Authentication Failed\n\n${error.message}\n\nPlease try again or contact support if the problem persists.`
        }],
        isError: true
      };
    }
  }

  async _handleLogout() {
    debugLog('[StatefulBackend] Handling logout...');

    if (!this._isAuthenticated) {
      return {
        content: [{
          type: 'text',
          text: `### Not Authenticated\n\nYou are not currently logged in.\n\nUse auth action='login' to sign in.`
        }]
      };
    }

    try {
      await this._oauthClient.clearTokens();
      this._isAuthenticated = false;
      this._userInfo = null;

      debugLog('[StatefulBackend] Logout successful');

      return {
        content: [{
          type: 'text',
          text: `### ✅ Logged Out\n\nYou have been successfully logged out.\n\nUse auth action='login' to sign in again.`
        }]
      };
    } catch (error) {
      debugLog('[StatefulBackend] Logout error:', error);

      return {
        content: [{
          type: 'text',
          text: `### Logout Failed\n\n${error.message}`
        }],
        isError: true
      };
    }
  }

  async _handleAuthStatus() {
    debugLog('[StatefulBackend] Handling auth status...');

    // Wait for auth check to complete before returning status
    await this._ensureAuthChecked();

    if (!this._isAuthenticated || !this._userInfo) {
      return {
        content: [{
          type: 'text',
          text: `### ❌ Not Authenticated\n\nYou are not currently logged in.\n\nUse auth action='login' to sign in with your Blueprint MCP PRO account.`
        }]
      };
    }

    return {
      content: [{
        type: 'text',
        text: `### Authentication Status\n\n` +
              `**Email:** ${this._userInfo.email}\n` +
              `**Status:** ✅ PRO Account\n\n` +
              `You have access to all PRO features including unlimited browser tabs!`
      }]
    };
  }

  async _handleScripting(args, options = {}) {
    debugLog('[StatefulBackend] Handling scripting:', args);

    const action = args.action;

    if (action === 'instructions') {
      // Get all tools for method list
      const allTools = await this.listTools();
      const instructions = wrappers.getInstructions(allTools);

      if (options.rawResult) {
        return {
          languages: wrappers.getAvailableLanguages(),
          tools: allTools.filter(t => t.name !== 'scripting').map(t => t.name)
        };
      }

      return {
        content: [{
          type: 'text',
          text: instructions
        }]
      };
    }

    if (action === 'install_wrapper') {
      // Validate parameters
      if (!args.language) {
        const errorMsg = 'Missing required parameter: language (python, javascript, or ruby)';
        if (options.rawResult) {
          return { success: false, error: 'missing_language', message: errorMsg };
        }
        return {
          content: [{ type: 'text', text: `### Error\n\n${errorMsg}` }],
          isError: true
        };
      }

      if (!args.path) {
        const errorMsg = 'Missing required parameter: path (file path to save wrapper)';
        if (options.rawResult) {
          return { success: false, error: 'missing_path', message: errorMsg };
        }
        return {
          content: [{ type: 'text', text: `### Error\n\n${errorMsg}` }],
          isError: true
        };
      }

      const language = args.language.toLowerCase();
      const availableLanguages = wrappers.getAvailableLanguages();

      if (!availableLanguages.includes(language)) {
        const errorMsg = `Unknown language: ${language}. Available: ${availableLanguages.join(', ')}`;
        if (options.rawResult) {
          return { success: false, error: 'unknown_language', message: errorMsg };
        }
        return {
          content: [{ type: 'text', text: `### Error\n\n${errorMsg}` }],
          isError: true
        };
      }

      try {
        // Get all tools and generate wrapper
        const allTools = await this.listTools();
        const wrapperCode = wrappers.generateWrapper(language, allTools);

        // Resolve the path
        const filePath = path.resolve(args.path);

        // Ensure directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // Write the wrapper file
        fs.writeFileSync(filePath, wrapperCode, 'utf-8');

        debugLog('[StatefulBackend] Wrapper written to:', filePath);

        if (options.rawResult) {
          return {
            success: true,
            language,
            path: filePath,
            methods: allTools.filter(t => t.name !== 'scripting').map(t => t.name)
          };
        }

        const ext = wrappers.getFileExtension(language);
        const importExample = language === 'python'
          ? `from ${path.basename(filePath, ext)} import BlueprintMCP`
          : language === 'javascript'
          ? `import { BlueprintMCP } from './${path.basename(filePath)}';`
          : `require_relative '${path.basename(filePath, ext)}'`;

        return {
          content: [{
            type: 'text',
            text: `### Wrapper Installed\n\n` +
                  `**Language:** ${language}\n` +
                  `**Path:** ${filePath}\n\n` +
                  `**Usage:**\n\`\`\`\n${importExample}\n\n` +
                  `bp = BlueprintMCP${language === 'javascript' ? '()' : language === 'python' ? '()' : '.new'}\n` +
                  `bp.enable(client_id${language === 'ruby' ? ':' : language === 'javascript' ? ': ' : '='}\'my-script\')\n` +
                  `\`\`\``
          }]
        };
      } catch (error) {
        debugLog('[StatefulBackend] Error writing wrapper:', error);

        if (options.rawResult) {
          return { success: false, error: 'write_failed', message: error.message };
        }

        return {
          content: [{
            type: 'text',
            text: `### Error\n\nFailed to write wrapper: ${error.message}`
          }],
          isError: true
        };
      }
    }

    const errorMsg = `Unknown scripting action: ${action}. Use 'instructions' or 'install_wrapper'.`;
    if (options.rawResult) {
      return { success: false, error: 'unknown_action', message: errorMsg };
    }
    return {
      content: [{ type: 'text', text: `### Error\n\n${errorMsg}` }],
      isError: true
    };
  }

  async serverClosed() {
    debugLog('[StatefulBackend] Server closing...');
    if (this._activeBackend) {
      this._activeBackend.serverClosed();
    }
    if (this._extensionServer) {
      await this._extensionServer.stop();
    }
    if (this._proxyConnection) {
      await this._proxyConnection.close();
    }
  }
}

module.exports = { StatefulBackend };
