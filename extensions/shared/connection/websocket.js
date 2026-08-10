/**
 * WebSocket connection manager for browser extensions
 * Handles connections to MCP server (both direct and relay modes)
 */

import { getUserInfoFromStorage, decodeJWT, refreshAccessToken } from '../utils/jwt.js';

/**
 * WebSocket connection manager class
 * Manages WebSocket connections with auto-reconnect, authentication, and message routing
 */
export class WebSocketConnection {
  constructor(browserAPI, logger, iconManager, buildTimestamp = null) {
    this.browser = browserAPI;
    this.logger = logger;
    this.iconManager = iconManager;
    this.buildTimestamp = buildTimestamp;

    this.socket = null;
    this.isConnected = false;
    this.isPro = false;
    this.projectName = null;
    this.connectionUrl = null;
    this.reconnectTimeout = null;
    this.reconnectDelay = 5000; // 5 seconds
    this.tokenRefreshTimer = null; // Periodic token refresh check

    // Command handler map - will be set by the consumer
    this.commandHandlers = new Map();

    // Notification handlers - for handling server notifications
    this.notificationHandlers = new Map();

    // Session lifecycle state. _sessionEstablished tracks an established
    // connection separately from isConnected, which error handlers may
    // clear before the close event arrives; lastConnectedAt lets consumers
    // (e.g. the extension's debugger grace sweep) measure how long the
    // connection has genuinely been down.
    this._sessionEstablished = false;
    // Last moment a session was known to be up: set when a session is
    // established AND when it is lost, so (now - lastConnectedAt) measures
    // how long the connection has actually been down
    this.lastConnectedAt = 0;

    // Bumped by connect() and disconnect(); a connect() attempt whose
    // generation is stale by socket-creation time aborts itself
    this._connectGeneration = 0;
  }

  _markSessionEstablished() {
    if (this._sessionEstablished) {
      return;
    }
    this._sessionEstablished = true;
    // Kept so a connection refused before any real traffic can roll the
    // timestamp back (see _markSessionRejected)
    this._connectedAtBeforeSession = this.lastConnectedAt;
    this._sessionUsed = false;
    this.lastConnectedAt = Date.now();
  }

  _markSessionUsed() {
    this._sessionUsed = true;
  }

  _markSessionRejected() {
    if (this._sessionEstablished && !this._sessionUsed) {
      this.lastConnectedAt = this._connectedAtBeforeSession;
      this._sessionEstablished = false;
    }
  }

  // Unbind all handlers and drop the socket. Handlers must be unbound
  // before close() so a stale socket's events can never fire against the
  // live connection state. close() is a no-op on an already-closed socket.
  _releaseSocket() {
    if (!this.socket) {
      return;
    }
    this.socket.onopen = null;
    this.socket.onmessage = null;
    this.socket.onerror = null;
    this.socket.onclose = null;
    this.socket.close();
    this.socket = null;
  }

  _markSessionLost() {
    if (this._sessionEstablished) {
      this._sessionEstablished = false;
      this.lastConnectedAt = Date.now();
    }
  }

  /**
   * True when no established session exists. Unlike isConnected (which
   * error handlers may clear before lastConnectedAt is stamped), this
   * flips only together with lastConnectedAt, so consumers measuring
   * downtime never see a half-updated pair.
   */
  isSessionDown() {
    return !this._sessionEstablished;
  }

  /**
   * Register a command handler
   * @param {string} method - Command method name
   * @param {function} handler - Handler function
   */
  registerCommandHandler(method, handler) {
    this.commandHandlers.set(method, handler);
  }

  /**
   * Register a notification handler
   * @param {string} method - Notification method name
   * @param {function} handler - Handler function
   */
  registerNotificationHandler(method, handler) {
    this.notificationHandlers.set(method, handler);
  }

  /**
   * Check if extension is enabled
   */
  async isExtensionEnabled() {
    const result = await this.browser.storage.local.get(['extensionEnabled']);
    return result.extensionEnabled !== false;
  }

  /**
   * Start periodic token refresh check (every 60 seconds)
   * Refreshes token when it has < 2 minutes remaining
   */
  startTokenRefreshTimer() {
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
    }

    this.logger.log('[WebSocket] Starting periodic token refresh check (every 60s)');

    // Check immediately, then every 60 seconds
    this.checkAndRefreshToken();
    this.tokenRefreshTimer = setInterval(() => {
      this.checkAndRefreshToken();
    }, 60000); // 60 seconds
  }

  /**
   * Stop periodic token refresh check
   */
  stopTokenRefreshTimer() {
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
      this.logger.log('[WebSocket] Stopped periodic token refresh check');
    }
  }

  /**
   * Check token expiration and refresh if needed
   * Refreshes when < 2 minutes (120 seconds) remaining
   */
  async checkAndRefreshToken() {
    try {
      const result = await this.browser.storage.local.get(['accessToken', 'refreshToken']);

      if (!result.accessToken || !result.refreshToken) {
        return; // No tokens to refresh
      }

      const payload = decodeJWT(result.accessToken);
      if (!payload || !payload.exp) {
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const expiresAt = payload.exp;
      const timeLeft = expiresAt - now;

      // Refresh if token expires within 2 minutes (120 seconds)
      if (timeLeft < 120 && timeLeft > 0) {
        this.logger.log(`[WebSocket] Token expires in ${timeLeft}s, triggering refresh...`);

        try {
          // Call refreshAccessToken directly to force a refresh
          const newTokens = await refreshAccessToken(result.refreshToken);

          // Save new tokens to storage (this will trigger storage.onChanged event in popup!)
          await this.browser.storage.local.set({
            accessToken: newTokens.access_token,
            refreshToken: newTokens.refresh_token,
            isPro: true
          });

          this.logger.log('[WebSocket] ✅ Token refreshed successfully via periodic check');
        } catch (error) {
          this.logger.log('[WebSocket] ❌ Token refresh failed:', error.message);
        }
      } else if (timeLeft < 0) {
        this.logger.log('[WebSocket] ⚠️ Token already expired, will refresh on next connection');
      }
    } catch (error) {
      this.logger.log('[WebSocket] Error checking token:', error);
    }
  }

  /**
   * Get connection URL based on mode (PRO or Free)
   */
  async getConnectionUrl() {
    // Check if user has PRO account with connection URL from JWT
    const userInfo = await getUserInfoFromStorage(this.browser);

    // Debug: Log what we got from JWT
    this.logger.log('[WebSocket] User info from JWT:', userInfo);

    if (userInfo && userInfo.connectionUrl) {
      // PRO user: use connection URL from JWT token
      this.isPro = true;
      this.logger.log(`[WebSocket] PRO mode: Connecting to relay server ${userInfo.connectionUrl}`);

      // Set isPro flag in storage for popup
      await this.browser.storage.local.set({ isPro: true });

      return userInfo.connectionUrl;
    } else {
      // Free user: use local port
      const result = await this.browser.storage.local.get(['mcpPort']);
      const port = result.mcpPort || '5555';
      const url = `ws://127.0.0.1:${port}/extension`;

      this.isPro = false;
      this.logger.log(`[WebSocket] Free mode: Connecting to ${url}`);
      if (userInfo) {
        this.logger.log('[WebSocket] User info found but no connectionUrl - check JWT payload');
      }

      // Clear isPro flag in storage
      await this.browser.storage.local.set({ isPro: false });

      return url;
    }
  }

  /**
   * Connect to MCP server
   */
  async connect() {
    // Only one socket may exist at a time: an orphaned socket's close
    // event would run _handleClose against the live connection. Each call
    // supersedes any earlier connect() still in its async window (the
    // generation check below), and disconnect() bumps the generation so a
    // stale attempt never opens a socket with pre-disconnect settings
    // (e.g. a Free-mode URL resolved before a PRO login).
    if (this.socket) {
      this.logger.log('[WebSocket] Already connected, skipping');
      return;
    }
    const generation = ++this._connectGeneration;

    try {
      // Check if extension is enabled
      const isEnabled = await this.isExtensionEnabled();
      if (!isEnabled) {
        this.logger.log('[WebSocket] Extension is disabled, skipping auto-connect');
        return;
      }

      // Show connecting badge
      if (this.iconManager) {
        await this.iconManager.updateConnectingBadge();
      }

      // Get connection URL (handles PRO vs Free mode)
      const url = await this.getConnectionUrl();

      // Superseded by a newer connect() or a disconnect() while resolving
      // the URL — abort without touching the current state
      if (generation !== this._connectGeneration || this.socket) {
        this.logger.log('[WebSocket] Connect attempt superseded, aborting');
        return;
      }
      this.connectionUrl = url; // Store for logging

      // Create WebSocket connection
      this.socket = new WebSocket(url);

      // Set up event handlers
      this.socket.onopen = () => this._handleOpen();
      this.socket.onmessage = (event) => this._handleMessage(event);
      this.socket.onerror = (error) => this._handleError(error);
      this.socket.onclose = (event) => this._handleClose(event);

    } catch (error) {
      this.logger.logAlways('[WebSocket] Connection error:', error);

      // Reset to normal icon on error
      if (this.iconManager) {
        await this.iconManager.setGlobalIcon('normal', 'Connection failed');
      }

      // Schedule reconnect
      this._scheduleReconnect();
    }
  }

  /**
   * Disconnect from MCP server
   */
  disconnect() {
    // Invalidate any connect() attempt still in its async window
    this._connectGeneration++;

    // Clear reconnect timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Close socket. Unbinding first means the async close event can't run
    // _handleClose, which would notify listeners a second time and
    // schedule a reconnect after an explicit disconnect
    this._releaseSocket();

    this.isConnected = false;

    // The unbound close event can no longer reach _handleClose, so the
    // token refresh timer is stopped here
    this.stopTokenRefreshTimer();
    this._markSessionLost();

    // Update icon manager to show disconnected state
    if (this.iconManager) {
      this.iconManager.setConnected(false);
      this.iconManager.setGlobalIcon('normal', 'Disconnected from MCP server');
    }

    // Notify popup of status change
    this.browser.runtime.sendMessage({ type: 'statusChanged' }).catch(() => {
      // Popup may not be open, ignore error
    });
  }

  /**
   * Send a message through the WebSocket
   */
  send(message) {
    if (this.socket && this.isConnected) {
      this.socket.send(JSON.stringify(message));
    } else {
      this.logger.error('[WebSocket] Cannot send message: not connected');
    }
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   * @param {string} method - Notification method name
   * @param {object} params - Notification parameters
   */
  sendNotification(method, params) {
    console.error('[WebSocket sendNotification] Called with method:', method);
    console.error('[WebSocket sendNotification] Connected:', this.isConnected);

    if (!this.socket || !this.isConnected) {
      console.error('[WebSocket] ❌ Cannot send notification: not connected');
      this.logger.error('[WebSocket] Cannot send notification: not connected');
      return;
    }

    const message = {
      jsonrpc: '2.0',
      method: method,
      params: params
    };

    console.error('[WebSocket] Sending notification:', JSON.stringify(message));
    this.send(message);

    console.error(`[WebSocket] ✅ Sent notification: ${method}`);
    this.logger.log(`[WebSocket] Sent notification: ${method}`);
  }

  /**
   * Handle WebSocket open event
   */
  _handleOpen() {
    this.logger.logAlways(`Connected to ${this.connectionUrl}`);
    this.isConnected = true;
    // Free mode: the local server accepting the socket IS the session —
    // it sends no unsolicited frame to wait for. A refusal (duplicate
    // extension) arrives as an error frame and rolls this back.
    // PRO mode: wait for authentication to actually succeed, so an
    // expired-token reject loop can't keep refreshing lastConnectedAt.
    if (!this.isPro) {
      this._markSessionEstablished();
    }

    // Update icon manager
    if (this.iconManager) {
      this.iconManager.setConnected(true);
      this.iconManager.setGlobalIcon('connected', 'Connected to MCP server');
    }

    // Notify popup of status change
    this.browser.runtime.sendMessage({ type: 'statusChanged' }).catch(() => {
      // Popup may not be open, ignore error
    });

    // In PRO mode (relay), don't send handshake - wait for authenticate request
    // In Free mode, send handshake
    if (!this.isPro) {
      this.send({
        type: 'handshake',
        browser: this._getBrowserName(),
        version: this.browser.runtime.getManifest().version,
        buildTimestamp: this.buildTimestamp
      });
    } else {
      this.logger.log('[WebSocket] PRO mode: Waiting for authenticate request from proxy...');

      // Send build_info notification for PRO mode (Free mode includes it in handshake)
      if (this.buildTimestamp) {
        this.send({
          jsonrpc: '2.0',
          method: 'build_info',
          params: {
            buildTimestamp: this.buildTimestamp
          }
        });
      }

      // Start periodic token refresh check in PRO mode
      this.startTokenRefreshTimer();
    }
  }

  /**
   * Handle WebSocket message event
   */
  async _handleMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
      this.logger.log('[WebSocket] Received command:', message);

      // Handle error responses from server
      if (message.error) {
        this.logger.logAlways('[WebSocket] Server error response:', message.error);
        // A server error before any real traffic means this connection was
        // refused (duplicate extension, failed auth). Undo the timestamp
        // so a rejection loop can't masquerade as a healthy connection
        // and starve consumers measuring downtime.
        this._markSessionRejected();
        return;
      }

      // Real inbound traffic confirms a working session
      this._markSessionUsed();

      // Handle notifications (no id, has method)
      if (!message.id && message.method) {
        await this._handleNotification(message);
        return; // Don't send response for notifications
      }

      // Handle commands with registered handlers
      const response = await this._routeCommand(message);

      // Send response
      this.send({
        jsonrpc: '2.0',
        id: message.id,
        result: response
      });

    } catch (error) {
      this.logger.logAlways('[WebSocket] Command error:', error);

      // Send error response if we have a message id
      if (message && message.id) {
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            message: error.message,
            stack: error.stack
          }
        });
      }
    }
  }

  /**
   * Handle notifications from server
   */
  async _handleNotification(message) {
    const { method, params } = message;

    // Built-in notification handlers
    if (method === 'authenticated' && params?.client_id) {
      this.projectName = params.client_id;
      this.logger.log('[WebSocket] Project name set:', this.projectName);
    }

    if (method === 'connection_status' && params) {
      // Store connection status for popup display
      const status = {
        max_connections: params.max_connections,
        connections_used: params.connections_used,
        connections_to_this_browser: params.connections_to_this_browser,
        total_browsers: params.total_browsers,
        total_mcp_clients: params.total_mcp_clients
      };
      await this.browser.storage.local.set({ connectionStatus: status });
      this.logger.log('[WebSocket] Connection status updated:', status);

      // Extract project_name from active_connections if available
      if (params.active_connections && params.active_connections.length > 0) {
        const firstConnection = params.active_connections[0];
        let extractedProjectName = firstConnection.project_name ||
                                   firstConnection.mcp_client_id ||
                                   firstConnection.client_id ||
                                   firstConnection.clientID ||
                                   firstConnection.name;

        // Strip "mcp-" prefix if present
        if (extractedProjectName && extractedProjectName.startsWith('mcp-')) {
          extractedProjectName = extractedProjectName.substring(4);
        }

        if (extractedProjectName) {
          this.logger.log('[WebSocket] Project name from connection_status:', extractedProjectName);
          this.projectName = extractedProjectName;

          // Broadcast status change to popup
          this.browser.runtime.sendMessage({ type: 'statusChanged' }).catch(() => {});
        }
      }
    }

    // Call registered notification handler if available
    const handler = this.notificationHandlers.get(method);
    if (handler) {
      await handler(params);
    }
  }

  /**
   * Route command to appropriate handler
   */
  async _routeCommand(message) {
    const { method, params } = message;

    // Handle authenticate command (built-in for PRO mode)
    if (method === 'authenticate') {
      return await this._handleAuthenticate();
    }

    // Route to registered handler
    const handler = this.commandHandlers.get(method);
    if (handler) {
      return await handler(params, message);
    }

    throw new Error(`Unknown command: ${method}`);
  }

  /**
   * Handle authenticate command (PRO mode)
   */
  async _handleAuthenticate() {
    // Get stored tokens from browser.storage
    const result = await this.browser.storage.local.get(['accessToken', 'refreshToken', 'stableClientId']);

    if (!result.accessToken) {
      throw new Error('No authentication tokens found. Please login via MCP client first.');
    }

    // Check if token is expired
    const payload = decodeJWT(result.accessToken);
    const now = Math.floor(Date.now() / 1000);
    const isExpired = payload && payload.exp && payload.exp < now;

    this.logger.log('[WebSocket] Token check - Expired:', isExpired, 'Expires:', payload?.exp, 'Now:', now);

    // If token is expired, try to refresh it
    if (isExpired && result.refreshToken) {
      this.logger.log('[WebSocket] Access token expired, refreshing...');
      try {
        const newTokens = await refreshAccessToken(result.refreshToken);

        // Store new tokens
        await this.browser.storage.local.set({
          accessToken: newTokens.access_token,
          refreshToken: newTokens.refresh_token
        });

        this.logger.log('[WebSocket] Token refreshed successfully');
        result.accessToken = newTokens.access_token;
      } catch (error) {
        this.logger.logAlways('[WebSocket] Token refresh failed:', error.message);

        // Only clear tokens if refresh token is invalid (401/403)
        // Keep tokens for network errors or server issues (500, etc.)
        if (error.status === 401 || error.status === 403) {
          this.logger.logAlways('[WebSocket] Refresh token invalid - clearing tokens');
          await this.browser.storage.local.remove(['accessToken', 'refreshToken', 'isPro']);
          throw new Error('Authentication failed: Token expired and refresh token is invalid. Please login again.');
        }

        // For other errors (network, 500, etc.), keep tokens and throw error
        this.logger.logAlways('[WebSocket] Keeping tokens - error may be temporary');
        throw new Error(`Authentication failed: ${error.message}. Tokens preserved for retry.`);
      }
    } else if (isExpired) {
      this.logger.logAlways('[WebSocket] Token expired and no refresh token available');
      await this.browser.storage.local.remove(['accessToken', 'refreshToken', 'isPro']);
      throw new Error('Authentication failed: Token expired. Please login again.');
    }

    // Get custom browser name from storage, fallback to manifest name
    const defaultBrowserName = this._getBrowserName();
    const storedName = await this.browser.storage.local.get(['browserName']);
    const browserName = storedName.browserName || defaultBrowserName;

    // Get or generate stable client_id
    let clientId = result.stableClientId;
    if (!clientId) {
      clientId = await this._generateClientId();
      await this.browser.storage.local.set({ stableClientId: clientId });
    }

    const authResponse = {
      name: browserName,
      access_token: result.accessToken,
      client_id: clientId,
      buildTimestamp: this.buildTimestamp
    };

    // Authentication succeeded (every failure path above throws), so the
    // PRO session is now genuinely established
    this._markSessionEstablished();
    this._markSessionUsed();

    this.logger.log('[WebSocket] Responding to authenticate request');
    return authResponse;
  }

  /**
   * Handle WebSocket error event
   */
  _handleError(error) {
    this.logger.logAlways('[WebSocket] WebSocket error:', error);
    this.isConnected = false;

    // Update icon manager
    if (this.iconManager) {
      this.iconManager.setConnected(false);
    }
  }

  /**
   * Handle WebSocket close event
   */
  _handleClose(event) {
    this.logger.logAlways(`Disconnected - Code: ${event?.code}, Reason: ${event?.reason || 'No reason provided'}, Clean: ${event?.wasClean}`);
    this.isConnected = false;

    // Release the socket so the next connect() isn't blocked by the
    // single-socket guard; unbind handlers so nothing fires twice
    this._releaseSocket();

    this._markSessionLost();

    // Stop periodic token refresh check
    this.stopTokenRefreshTimer();

    // Update icon manager
    if (this.iconManager) {
      this.iconManager.setConnected(false);
      this.iconManager.setGlobalIcon('normal', 'Disconnected from MCP server');
    }

    // Notify popup of status change
    this.browser.runtime.sendMessage({ type: 'statusChanged' }).catch(() => {
      // Popup may not be open, ignore error
    });

    // Schedule reconnect
    this._scheduleReconnect();
  }

  /**
   * Schedule reconnect attempt
   */
  _scheduleReconnect() {
    if (this.reconnectTimeout) {
      return; // Already scheduled
    }

    this.logger.log(`[WebSocket] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, this.reconnectDelay);
  }

  /**
   * Get browser name from manifest
   * This is more reliable than user agent detection
   */
  _getBrowserName() {
    // Get browser name from manifest.json name field
    // e.g. "Blueprint MCP for Chrome" -> "Chrome"
    //      "Blueprint MCP for Opera" -> "Opera"
    //      "Blueprint MCP for Firefox" -> "Firefox"
    const manifest = this.browser.runtime.getManifest();
    const manifestName = manifest.name || '';

    // Extract browser name from "Blueprint MCP for X" pattern
    const match = manifestName.match(/Blueprint MCP for (\w+)/);
    if (match && match[1]) {
      return match[1];
    }

    // Fallback to user agent detection if manifest doesn't match pattern
    // Check Opera first (Chromium-based, has window.opr or OPR in user agent)
    if ((typeof opr !== 'undefined' && opr.addons) || navigator.userAgent.indexOf('OPR') !== -1) {
      return 'Opera';
    }
    // Check Chrome (also matches Edge, Brave, etc. but they're less common)
    else if (typeof chrome !== 'undefined' && chrome.runtime) {
      return 'Chrome';
    }
    // Check Firefox (uses browser API instead of chrome)
    else if (typeof browser !== 'undefined' && browser.runtime) {
      return 'Firefox';
    }
    return 'Unknown';
  }

  /**
   * Generate stable client ID
   */
  async _generateClientId() {
    const browserName = this._getBrowserName().toLowerCase();
    const extensionId = this.browser.runtime.id;

    // Try to get browser info (Firefox only)
    if (this.browser.runtime.getBrowserInfo) {
      try {
        const info = await this.browser.runtime.getBrowserInfo();
        return `${browserName}-${info.name}-${extensionId}`;
      } catch (e) {
        // Fallback if getBrowserInfo not available
      }
    }

    // Fallback for Chrome or if getBrowserInfo fails
    return `${browserName}-${extensionId}-${Date.now()}`;
  }
}
