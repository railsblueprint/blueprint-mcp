[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/railsblueprint-blueprint-mcp-badge.png)](https://mseep.ai/app/railsblueprint-blueprint-mcp)

# Blueprint MCP

> Control your real browser with AI through the Model Context Protocol

[![npm version](https://badge.fury.io/js/@railsblueprint%2Fblueprint-mcp.svg)](https://www.npmjs.com/package/@railsblueprint/blueprint-mcp)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

## What is this?

An MCP (Model Context Protocol) server that lets AI assistants control your actual browser (Chrome, Firefox, or Opera) through a browser extension. Unlike headless automation tools, this uses your real browser profile with all your logged-in sessions, cookies, and extensions intact.

**Perfect for:** AI agents that need to interact with sites where you're already logged in, or that need to avoid bot detection.

## Why use this instead of Playwright/Puppeteer?

| Blueprint MCP | Playwright/Puppeteer |
|-------------------------|---------------------|
| ✅ Real browser (not headless) | ❌ Headless or new browser instance |
| ✅ Stays logged in to all your sites | ❌ Must re-authenticate each session |
| ✅ Avoids bot detection (uses real fingerprint) | ⚠️ Often detected as automated browser |
| ✅ Works with your existing browser extensions | ❌ No extension support |
| ✅ Zero setup - works out of the box | ⚠️ Requires browser installation |
| ✅ Chrome, Firefox, Edge, Opera support | ✅ Chrome, Firefox, Safari support |

## Installation

### 1. Install the MCP Server

```bash
npm install -g @railsblueprint/blueprint-mcp
```

### 2. Install the Browser Extension

Choose your browser:

**Chrome / Edge / Opera**
- [Chrome Web Store](https://chromewebstore.google.com/detail/blueprint-mcp-for-chrome/kpfkpbkijebomacngfgljaendniocdfp) (works for all Chromium browsers)
- Manual: Download from [Releases](https://github.com/railsblueprint/blueprint-mcp/releases), then load unpacked at `chrome://extensions/` (Chrome), `edge://extensions/` (Edge), or `opera://extensions/` (Opera)

**Firefox**
- [Firefox Add-ons](https://addons.mozilla.org/addon/blueprint-mcp-for-firefox/)
- Manual: Download from [Releases](https://github.com/railsblueprint/blueprint-mcp/releases), then load at `about:debugging#/runtime/this-firefox`

### 3. Configure your MCP client

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["@railsblueprint/blueprint-mcp@latest"]
    }
  }
}
```

**Claude Code** (AI-powered CLI):
```bash
claude mcp add browser npx @railsblueprint/blueprint-mcp@latest
```

**VS Code / Cursor** (`.vscode/settings.json`):
```json
{
  "mcp.servers": {
    "browser": {
      "command": "npx",
      "args": ["@railsblueprint/blueprint-mcp@latest"]
    }
  }
}
```

## Quick Start

1. **Start your MCP client** (Claude Desktop, Cursor, etc.)
2. **Click the Blueprint MCP extension icon** in your browser
3. The extension auto-connects to the MCP server
4. **Ask your AI assistant to browse!**

**Example conversations:**
```
You: "Go to GitHub and check my notifications"
AI: *navigates to github.com, clicks notifications, reads content*

You: "Fill out this form with my info"
AI: *reads form fields, fills them in, submits*

You: "Take a screenshot of this page"
AI: *captures screenshot and shows you*
```

## How it works

```
┌─────────────────────────┐
│   AI Assistant          │
│   (Claude, GPT, etc)    │
└───────────┬─────────────┘
            │
            │ MCP Protocol
            ↓
┌─────────────────────────┐
│   MCP Client            │
│   (Claude Desktop, etc) │
└───────────┬─────────────┘
            │
            │ stdio/JSON-RPC
            ↓
┌─────────────────────────┐
│   blueprint-mcp         │
│   (this package)        │
└───────────┬─────────────┘
            │
            │ WebSocket (localhost:5555 or cloud relay)
            ↓
┌─────────────────────────┐
│   Browser Extension     │
└───────────┬─────────────┘
            │
            │ Browser Extension APIs
            ↓
┌─────────────────────────┐
│   Your Browser          │
│   (real profile)        │
└─────────────────────────┘
```

## Free vs PRO

### Free Tier (Default)
- ✅ Local WebSocket connection (port 5555)
- ✅ Single browser instance
- ✅ All browser automation features
- ✅ No account required
- ❌ Limited to same machine

### PRO Tier
- ✅ **Cloud relay** - connect from anywhere
- ✅ **Multiple browsers** - control multiple browser instances
- ✅ **Shared access** - multiple AI clients can use same browser
- ✅ **Auto-reconnect** - maintains connection through network changes
- ✅ **Priority support**

[Upgrade to PRO](https://blueprint-mcp.railsblueprint.com)

## Available Tools

The MCP server provides these tools to AI assistants:

### Connection Management
- `enable` - Activate browser automation (required first step)
- `disable` - Deactivate browser automation
- `status` - Check connection status
- `auth` - Login to PRO account (for cloud relay features)

### Tab Management
- `browser_tabs` - List, create, attach to, or close browser tabs

### Navigation
- `browser_navigate` - Navigate to a URL
- `browser_navigate_back` - Go back in history

### Content & Inspection
- `browser_snapshot` - Get accessible page content (recommended for reading pages)
- `browser_take_screenshot` - Capture visual screenshot
- `browser_console_messages` - Get browser console logs
- `browser_network_requests` - Powerful network monitoring and replay tool with multiple actions:
  - **List mode** (default): Lightweight overview with filtering and pagination (default: 20 requests)
    - Filters: `urlPattern` (substring), `method` (GET/POST), `status` (200/404), `resourceType` (xhr/fetch/script)
    - Pagination: `limit` (default: 20), `offset` (default: 0)
    - Example: `action='list', urlPattern='api/users', method='GET', limit=10`
  - **Details mode**: Full request/response data for specific request including headers and bodies
  - **JSONPath filtering**: Query large JSON responses using JSONPath syntax (e.g., `$.data.items[0]`)
  - **Replay mode**: Re-execute captured requests with original headers and authentication
  - **Clear mode**: Clear captured history to free memory
  - Example: `action='details', requestId='12345.67', jsonPath='$.data.users[0]'`
- `browser_extract_content` - Extract page content as markdown

### Interaction
- `browser_interact` - Perform multiple actions in sequence (click, type, hover, wait, etc.)
- `browser_click` - Click on elements
- `browser_type` - Type text into inputs
- `browser_hover` - Hover over elements
- `browser_select_option` - Select dropdown options
- `browser_fill_form` - Fill multiple form fields at once
- `browser_press_key` - Press keyboard keys
- `browser_drag` - Drag and drop elements

### Advanced
- `browser_evaluate` - Execute JavaScript in page context
- `browser_handle_dialog` - Handle alert/confirm/prompt dialogs
- `browser_file_upload` - Upload files through file inputs
- `browser_window` - Resize, minimize, maximize browser window
- `browser_pdf_save` - Save current page as PDF
- `browser_performance_metrics` - Get performance metrics
- `browser_verify_text_visible` - Verify text is present (for testing)
- `browser_verify_element_visible` - Verify element exists (for testing)

### Extension Management
- `browser_list_extensions` - List installed browser extensions
- `browser_reload_extensions` - Reload unpacked extensions (useful during development)

## Development

### Prerequisites
- Node.js 18+
- A supported browser (Chrome, Firefox, Edge, or Opera)
- npm or yarn

### Setup

```bash
# Clone the repository
git clone https://github.com/railsblueprint/blueprint-mcp.git
cd blueprint-mcp

# Install server dependencies
cd server
npm install
cd ..

# Install Chrome extension dependencies
cd extensions/chrome
npm install
cd ../..
```

### Running in Development

**Terminal 1: Start MCP server in debug mode**
```bash
cd server
node cli.js --debug
```

**Terminal 2: Build Chrome extension**
```bash
cd extensions/chrome
npm run build
# or for watch mode:
npm run dev
```

**Note:** Firefox extension doesn't require a build step - it uses vanilla JavaScript and can be loaded directly from `extensions/firefox/`

**Load extension in your browser:**

For Chromium browsers (Chrome, Edge, Opera):
1. Open `chrome://extensions/` (Chrome), `edge://extensions/` (Edge), or `opera://extensions/` (Opera)
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extensions/chrome/dist` folder

For Firefox:
1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select any file from the `extensions/firefox` folder

### Project Structure

```
blueprint-mcp/
├── server/                     # MCP Server
│   ├── cli.js                  # Server entry point
│   ├── src/
│   │   ├── statefulBackend.js  # Connection state management
│   │   ├── unifiedBackend.js   # MCP tool implementations
│   │   ├── extensionServer.js  # WebSocket server for extension
│   │   ├── mcpConnection.js    # Proxy/relay connection handling
│   │   ├── transport.js        # Transport abstraction layer
│   │   ├── oauth.js            # OAuth2 client for PRO features
│   │   └── fileLogger.js       # Debug logging
│   └── tests/                  # Server test suites
├── extensions/                 # Browser Extensions
│   ├── chrome/                 # Chrome extension (TypeScript + Vite)
│   │   └── src/
│   │       ├── background.ts   # Extension service worker
│   │       ├── content-script.ts # Page content injection
│   │       └── utils/          # Utility functions
│   ├── firefox/                # Firefox extension (Vanilla JS)
│   │   └── src/
│   │       ├── background.js   # Service worker
│   │       └── content-script.js # Page injection
│   ├── shared/                 # Shared code between extensions
│   └── build-*.js              # Build scripts for each browser
├── docs/                       # Documentation
│   ├── testing/                # Test documentation
│   ├── architecture/           # Architecture docs
│   └── stores/                 # Browser store assets
└── releases/                   # Built extensions for distribution
    ├── chrome/
    ├── firefox/
    ├── edge/
    └── opera/
```

### Testing

```bash
# Run tests
npm test

# Run with coverage
npm run test:coverage
```

**Documentation:**
- [Manual Test Procedures](docs/testing/MANUAL_TEST_PROCEDURES.md) - Comprehensive manual testing guide
- [Feature Specification](docs/testing/FEATURE_SPEC.md) - Complete feature documentation
- [Test Progress](docs/testing/TEST_PROGRESS.md) - Current test coverage status

## Configuration

The server works out-of-the-box with sensible defaults. For advanced configuration:

### Environment Variables

Create a `.env` file in the project root:

```bash
# Authentication server (PRO features)
AUTH_BASE_URL=https://blueprint-mcp.railsblueprint.com

# Local WebSocket port (Free tier)
MCP_PORT=5555

# Debug mode
DEBUG=false
```

### Command Line Options

```bash
blueprint-mcp --debug              # Enable verbose logging
blueprint-mcp --port 8080          # Use custom WebSocket port (default: 5555)
blueprint-mcp --debug --port 8080  # Combine options
```

**Note:** If you change the port, you'll need to update your browser extension settings to match.

## Troubleshooting

### Extension won't connect
1. Check the extension is installed and enabled
2. Click the extension icon - it should show "Connected"
3. Check the MCP server is running (look for process on port 5555)
4. Try reloading the extension

### "Port 5555 already in use"
Another instance is running. You can either:

1. Kill the existing process:
```bash
lsof -ti:5555 | xargs kill -9
```

2. Use a different port:
```bash
blueprint-mcp --port 8080
```

### Browser tools not working
1. Make sure you've called `enable` first
2. Check you've attached to a tab with `browser_tabs`
3. Verify the tab still exists (wasn't closed)

### Getting help
- [GitHub Issues](https://github.com/railsblueprint/blueprint-mcp/issues)
- [Documentation](https://blueprint-mcp.railsblueprint.com/docs)

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Security

This tool gives AI assistants control over your browser. Please review:
- The MCP server only accepts local connections by default (localhost:5555)
- PRO relay connections are authenticated via OAuth
- The extension requires explicit user action to connect
- All browser actions go through the browser's permission system

Found a security issue? Please email security@railsblueprint.com instead of filing a public issue.

## Credits

This project was originally inspired by Microsoft's Playwright MCP implementation but has been completely rewritten to use browser extension-based automation instead of Playwright. The architecture, implementation, and approach are fundamentally different.

**Key differences:**
- Uses browser extensions with DevTools Protocol (not Playwright)
- Works with real browser profiles (not isolated contexts)
- WebSocket-based communication (not CDP relay)
- Cloud relay option for remote access
- Free and PRO tier model
- Multi-browser support (Chrome, Firefox, Edge, Opera)

We're grateful to the Playwright team for pioneering browser automation via MCP.

## License

Apache License 2.0 - see [LICENSE](LICENSE)

Copyright (c) 2025 Rails Blueprint

---

**Built with ❤️ by [Rails Blueprint](https://railsblueprint.com)**

[Website](https://blueprint-mcp.railsblueprint.com) •
[GitHub](https://github.com/railsblueprint/blueprint-mcp) •
[NPM](https://www.npmjs.com/package/@railsblueprint/blueprint-mcp)
