/**
 * Extension WebSocket Server
 *
 * Simple WebSocket server that extension connects to.
 * Replaces Playwright's CDPRelayServer with our own lightweight implementation.
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const { getLogger } = require('./fileLogger');

function debugLog(...args) {
  if (global.DEBUG_MODE) {
    const logger = getLogger();
    logger.log('[ExtensionServer]', ...args);
  }
}

class ExtensionServer {
  constructor(port = 5555, host = '127.0.0.1') {
    this._port = port;
    this._host = host;
    this._httpServer = null;
    this._wss = null;
    this._extensionWs = null; // Current extension WebSocket connection
    this._pendingRequests = new Map(); // requestId -> {resolve, reject}
    this.onReconnect = null; // Callback when extension reconnects (replaces old connection)
    this.onTabInfoUpdate = null; // Callback when tab info changes (for status header updates)
    this._clientId = null; // MCP client_id to display in extension
    this._browserType = 'chrome'; // Browser type: 'chrome' or 'firefox'
    this._buildTimestamp = null; // Extension build timestamp
    this._pingInterval = null; // Ping interval to keep connection alive
  }

  /**
   * Get browser type
   */
  getBrowserType() {
    return this._browserType;
  }

  /**
   * Get extension build timestamp
   */
  getBuildTimestamp() {
    return this._buildTimestamp;
  }

  /**
   * Start the server
   */
  async start() {
    return new Promise((resolve, reject) => {
      // Create HTTP server
      this._httpServer = http.createServer((req, res) => {
        res.writeHead(200);
        res.end('Extension WebSocket Server');
      });

      // Create WebSocket server
      this._wss = new WebSocketServer({ server: this._httpServer });

      // Register WebSocket server error handler
      this._wss.on('error', (error) => {
        debugLog('WebSocketServer error:', error);
        reject(error);
      });

      this._wss.on('connection', (ws) => {
        debugLog('Extension connection attempt');

        // If we already have an active connection, reject the new one
        if (this._extensionWs && this._extensionWs.readyState === 1) {
          debugLog('Rejecting new connection - browser already connected');

          // Send error message to the new connection
          const errorMsg = {
            jsonrpc: '2.0',
            error: {
              code: -32001,
              message: 'Another browser is already connected. Only one browser can be connected at a time.'
            }
          };
          ws.send(JSON.stringify(errorMsg));

          // Close the new connection after a short delay to ensure message is sent
          setTimeout(() => ws.close(1008, 'Already connected'), 100);
          return;
        }

        debugLog('Extension connected');

        // Close previous connection if any (only if it's dead/closing)
        const isReconnection = !!this._extensionWs;
        if (this._extensionWs) {
          debugLog('Closing previous extension connection - RECONNECTION DETECTED');
          this._extensionWs.close();
        }

        this._extensionWs = ws;

        // Clear old ping interval if any
        if (this._pingInterval) {
          clearInterval(this._pingInterval);
          this._pingInterval = null;
        }

        // Start ping interval to keep connection alive (every 10 seconds)
        // This prevents Chrome from suspending the service worker
        this._pingInterval = setInterval(() => {
          if (ws.readyState === 1) { // OPEN
            ws.ping();
            debugLog('Sent ping to extension');
          }
        }, 10000);

        // Notify about reconnection after setting the new connection
        if (isReconnection && this.onReconnect) {
          debugLog('Calling onReconnect callback');
          this.onReconnect();
        }

        ws.on('message', (data) => {
          this._handleMessage(data);
        });

        ws.on('pong', () => {
          debugLog('Received pong from extension');
        });

        ws.on('close', () => {
          debugLog('Extension disconnected');
          if (this._extensionWs === ws) {
            this._extensionWs = null;
          }
          // Clear ping interval when connection closes
          if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
          }
        });

        ws.on('error', (error) => {
          debugLog('WebSocket error:', error);
        });
      });

      // Register HTTP server error handler BEFORE calling listen() to catch port-in-use errors
      this._httpServer.on('error', (error) => {
        debugLog('HTTP Server error:', error);
        reject(error);
      });

      // Start listening
      this._httpServer.listen(this._port, this._host, () => {
        debugLog(`Server listening on ${this._host}:${this._port}`);
        resolve();
      });
    });
  }

  /**
   * Handle incoming message from extension
   */
  _handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      debugLog('Received from extension:', message.method || 'response');

      // Check if it's a response (has id but no method)
      if (message.id !== undefined && !message.method) {
        const pending = this._pendingRequests.get(message.id);
        if (pending) {
          this._pendingRequests.delete(message.id);

          // Extract current tab info from result (not from message itself - that would be non-standard JSON-RPC)
          // Use 'in' operator to detect null values (tab detached) vs missing property
          const result = message.result || {};
          if ('currentTab' in result && this.onTabInfoUpdate) {
            debugLog('Tab info update:', result.currentTab);
            this.onTabInfoUpdate(result.currentTab);
          }

          if (message.error) {
            pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
          } else {
            pending.resolve(message.result);
          }
        }
        return;
      }

      // Handle handshake from extension
      if (message.type === 'handshake') {
        debugLog('Handshake received:', message);
        this._browserType = message.browser || 'chrome';
        this._buildTimestamp = message.buildTimestamp || null;
        debugLog(`Browser type detected: ${this._browserType}, Build timestamp: ${this._buildTimestamp}`);
        return;
      }

      // Handle notifications (has method but no id)
      if (message.method && message.id === undefined) {
        debugLog('Received notification:', message.method);

        // Handle tab_info_update notification from Firefox extension
        if (message.method === 'notifications/tab_info_update' && message.params?.currentTab && this.onTabInfoUpdate) {
          debugLog('Tab info update notification:', message.params.currentTab);
          this.onTabInfoUpdate(message.params.currentTab);
        }

        return;
      }
    } catch (error) {
      debugLog('Error handling message:', error);
    }
  }

  /**
   * Send a command to the extension and wait for response
   */
  async sendCommand(method, params = {}, timeout = 30000) {
    if (!this._extensionWs || this._extensionWs.readyState !== 1) {
      throw new Error('Extension not connected. Please click the extension icon and click "Connect".');
    }

    const id = Math.random().toString(36).substring(7);

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeout);

      this._pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      });

      const message = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      debugLog('Sending to extension:', method);
      this._extensionWs.send(JSON.stringify(message));
    });
  }

  /**
   * Set client_id and notify extension
   */
  setClientId(clientId) {
    this._clientId = clientId;
    debugLog('Client ID set to:', clientId);

    // Send notification to extension if connected
    if (this.isConnected()) {
      const notification = {
        jsonrpc: '2.0',
        method: 'authenticated',
        params: {
          client_id: clientId
        }
      };
      debugLog('Sending client_id notification to extension');
      this._extensionWs.send(JSON.stringify(notification));
    }
  }

  /**
   * Check if extension is connected
   */
  isConnected() {
    return this._extensionWs && this._extensionWs.readyState === 1;
  }

  /**
   * Stop the server
   */
  async stop({ notifyShutdown = false } = {}) {
    debugLog('Stopping server');

    if (this._extensionWs) {
      // Only a deliberate disable tells the extension to release debugger
      // attachments immediately. Process shutdown (SIGINT, client restart)
      // must NOT: the server usually comes right back, and the extension's
      // grace period exists to preserve sessions across exactly that.
      if (notifyShutdown) {
        try {
          this._extensionWs.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'serverShuttingDown',
            params: {}
          }));
        } catch {
          // Socket may already be closing; the grace sweep covers this case
        }
      }
      this._extensionWs.close();
      this._extensionWs = null;
    }

    if (this._wss) {
      this._wss.close();
      this._wss = null;
    }

    if (this._httpServer) {
      return new Promise((resolve) => {
        this._httpServer.close(() => {
          debugLog('Server stopped');
          resolve();
        });
      });
    }
  }
}

module.exports = { ExtensionServer };
