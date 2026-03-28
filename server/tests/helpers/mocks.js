/**
 * Mock factories for testing
 * Creates reusable mock objects for common test scenarios
 */

/**
 * Create mock MCP server
 */
function createMockServer() {
  return {
    sendToolListChanged: jest.fn()
  };
}

/**
 * Create mock transport (DirectTransport or ProxyTransport)
 */
function createMockTransport() {
  return {
    sendCommand: jest.fn().mockResolvedValue({ success: true }),
    close: jest.fn().mockResolvedValue(true)
  };
}

/**
 * Create mock extension server (WebSocket server)
 */
function createMockExtensionServer(port = 5555) {
  return {
    start: jest.fn().mockResolvedValue(true),
    close: jest.fn().mockResolvedValue(true),
    sendCommand: jest.fn().mockResolvedValue({ success: true }),
    setClientId: jest.fn(),
    getBuildTimestamp: jest.fn().mockReturnValue('2025-10-31T12:00:00.000Z'),
    port,
    _isRunning: false
  };
}

/**
 * Create mock MCP connection (proxy)
 */
function createMockMCPConnection() {
  return {
    connect: jest.fn().mockResolvedValue(true),
    close: jest.fn().mockResolvedValue(true),
    listBrowsers: jest.fn().mockResolvedValue([]),
    sendRequest: jest.fn().mockResolvedValue({ success: true })
  };
}

/**
 * Create mock OAuth client
 */
function createMockOAuthClient() {
  return {
    login: jest.fn().mockResolvedValue({
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token'
    }),
    logout: jest.fn().mockResolvedValue(true),
    isAuthenticated: jest.fn().mockReturnValue(false),
    getUserInfo: jest.fn().mockReturnValue(null)
  };
}

/**
 * Create mock extension response
 */
function createMockExtensionResponse(type, data) {
  return {
    id: '123',
    result: {
      type,
      data
    }
  };
}

/**
 * Create mock browser list
 */
function createMockBrowserList(count = 1) {
  return Array.from({ length: count }, (_, i) => ({
    browser_id: `ext-chrome-kdjfnlfbbbafdlgibjmdahpmlhemkmgi-${1000 + i}`,
    name: `Chrome ${i === 0 ? 'Macbook Pro' : `Browser ${i}`}`,
    connected: true,
    version: '1.7.2'
  }));
}

/**
 * Create mock tab list
 */
function createMockTabList(count = 3) {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    id: `${100 + i}`,
    url: `https://example.com/page${i}`,
    title: `Page ${i}`,
    active: i === 0
  }));
}

/**
 * Create mock network request
 */
function createMockNetworkRequest(overrides = {}) {
  return {
    requestId: '12345.67',
    url: 'https://api.example.com/users',
    method: 'GET',
    status: 200,
    resourceType: 'xhr',
    timestamp: Date.now(),
    ...overrides
  };
}

/**
 * Create mock snapshot data
 */
function createMockSnapshot() {
  return {
    html: '<html><body><h1>Test Page</h1><button>Click Me</button></body></html>',
    accessibility: {
      role: 'WebArea',
      name: 'Test Page',
      children: [
        { role: 'heading', name: 'Test Page', level: 1 },
        { role: 'button', name: 'Click Me' }
      ]
    }
  };
}

async function mockCDPCommandRuntimeEvaluate({ params: { expression, awaitPromise } }) {
  try {
    return {
      success: true,
      result: {
        value: awaitPromise ? await eval(expression) : eval(expression)
      }
    };
  } catch (exception) {
    return {
      success: false,
      exceptionDetails: {
        exception,
        text: typeof exception === 'string' ? exception : exception?.message ?? 'Unknown JavaScript exception',
        stackTrace: exception?.stack,
      }
    };
  }
}

module.exports = {
  createMockServer,
  createMockTransport,
  createMockExtensionServer,
  createMockMCPConnection,
  createMockOAuthClient,
  createMockExtensionResponse,
  createMockBrowserList,
  createMockTabList,
  createMockNetworkRequest,
  createMockSnapshot,
  mockCDPCommandRuntimeEvaluate
};
