# v1.9.22 (2026-08-10)

## Changes

- Fix off-screen clicks, tab index consistency, and startup hardening (#52)
- Apply review follow-ups: closeTab index, header normalization, guard consistency (#51)
- Fix release blockers: header rendering, disable scoping, no-tab guards (#50)
- Enable multi-tab debugger support with per-tab capture scoping (#39)
- Fix Firefox extension stuck at "Connecting" to local MCP server (#48)


# v1.9.21 (2025-12-21)

## Changes

- Improve client libraries with auto-connect and documentation (#38)


# v1.9.20 (2025-12-21)

## Changes

- Add script mode for non-MCP scripting (PRO feature) (#37)


# v1.9.19 (2025-12-17)

## Changes

- Fix browser_evaluate to show JavaScript errors instead of undefined (#35)


# v1.9.18 (2025-12-08)

## Changes

- Force English 'for Firefox' in all locale extName fields


# v1.9.17 (2025-12-08)

## Changes

- Rename Firefox extension to avoid trademark linter issue


# v1.9.16 (2025-12-08)

## Changes

- Clean up extension locales to match Chrome Web Store supported list
- Make :has-text() selector fully case-insensitive (#33)
- Add keepalive alarm to Firefox extension to prevent service worker suspension (#32)
- Add Chrome store banner 1280x800


# v1.9.15 (2025-11-26)

## Changes

- Fix Enter key not triggering form submission in textareas (#30)
- Add i18n support to all browser extensions (#29)
- Add welcome page on extension install (#28)
- Fix selector-based screenshots capturing wrong area (#27)


# v1.9.14 (2025-11-19)

## Changes

- Fix screenshot failures from debugger detachment (#26)


# v1.9.13 (2025-11-19)

## Changes

- Fix custom browser names not appearing in browser list (#25)


# v1.9.12 (2025-11-11)

## Changes

- Update extension manifest descriptions (#23)
- Document --port command line option (#22)


# v1.9.11 (2025-11-10)

## Changes

- Fix release script to automatically copy README to server directory
- Fix: Copy README to server directory for npm package


# v1.9.10 (2025-11-10)

## Changes

- Improve npm package distribution and deprecate old package name (#21)


# v1.9.9 (2025-11-09)

## Changes

- Fix full-page screenshots and improve file URL error handling (#20)


# v1.9.8 (2025-11-08)

## Changes

- Fix WebSocket connection stability issues (#19)


# v1.9.7 (2025-11-08)

## Changes

- Fix outdated project structure in README (#18)
- Update README to be browser-agnostic and add published extension links (#17)
- Refactor naming to be browser-agnostic (#16)
- Fix Edge version: update manifest to 1.9.6 and fix release script
- Fix release script: include Edge extension in releases


# v1.9.6 (2025-11-04)

## Changes

- Optimize extension builds: exclude logo source files and documentation
- Fix critical Firefox packaging bug - add missing shared modules
- Add Edge extension support to build system


# v1.9.5 (2025-11-04)

## Changes

- Apply build exclusions to Firefox, Opera, and Safari build scripts
- Fix Chrome extension build and packaging issues (v1.9.5)
- Add Firefox improvements and Edge extension support (#13)
- Add Opera Add-ons store submission materials
- Fix Opera extension version to 1.9.4
- Update release script summary to include Opera extension
- Update Opera package and release script
- Add Opera extension package to v1.9.4 release


# v1.9.4 (2025-11-02)

## Changes

- Add Opera browser support (#12)


# v1.9.3 (2025-11-02)

## Changes

- Fix browser_list showing incorrect 'FREE mode' error in PRO mode (#11)


# v1.9.2 (2025-11-02)

## Changes

- Add CSS inspection tool with pseudo-state support (#10)


# v1.9.1 (2025-11-02)

## Changes

- Fix browser_tabs attach action to not steal focus by default (#9)


# v1.9.0 (2025-11-02)

## Changes

- Implement CDP-based console capture for extension debugging (#8)


# v1.8.2 (2025-11-01)

## Changes

- Fix browser_reload_extensions to only reload development extensions
- Fix dates in FEATURES.md: correct year to 2025 and development period
- Update documentation for 2025 and remove useless Dockerfile
- Add Chrome Web Store promotional materials and submission documentation (#7)


# v1.8.1 (2025-11-01)

## Changes

- Add proactive token refresh and live token expiration display (#6)


# v1.8.0 (2025-10-31)

## Changes

- Complete comprehensive testing suite and critical bug fixes (v1.7.3) (#5)


# v1.7.2 (2025-10-28)

## Changes

- Fix: Create log directory and use proper user data path


# v1.7.1 (2025-10-28)

## Changes

- Add version logging to debug mode
- Fix: Sync root package.json version and update release script


# v1.7.0 (2025-10-28)

## Changes

- Refactor Chrome extension to vanilla JS with shared modules and optimizations (#4)
- Refactor Firefox extension to Manifest V3 with shared modules (#3)


# v1.6.2 (2025-10-26)

## Changes

- Fix: Escape selector in browser_interact to prevent JavaScript syntax errors (#2)
- Fix release script: Add --access public and -y flag


# v1.6.1 (2025-10-26)

## Changes




# v1.6.0 (2025-10-26)

## Changes

- Refactor: Monorepo structure + Complete Playwright removal (#1)
- Rename project to blueprint-mcp
- Update CLAUDE.md with current project state and architecture
- Clean up documentation: delete outdated files and organize into docs/ structure
- v1.5.5 - Fix compound selector bug with :has-text()
- Fix compound selector bug with :has-text()
- Bump version to 1.5.4
- Implement browser_tabs close action
- Bump version to 1.5.3
- 1.5.3
- Add click coordinate reporting to help debug click positioning
- Bump extension version to 1.5.2
- 1.5.2
- Fix tab switching - allow reattaching to previously used tabs
- Add smart select element detection and selection
- Fix disable button to actually disconnect and prevent auto-reconnect
- Fix popup Enable/Disable button sync issues
- Fix Firefox console access buttons to work within browser restrictions
- Add console access buttons to both Chrome and Firefox popups
- Improve connection status display in popups
- Bump extension versions to 1.5.1
- 1.5.1
- Fix: Critical bugs and replace badges with icon overlays
- Add React mount point detection and obfuscated CSS warnings
- Add detection for Polymer framework
- Add detection for Google Wiz framework
- Fix: Prevent Bootstrap being misdetected as Tailwind
- Fix: Improve Turbo and Spark detection for ES module imports
- Critical fix: Prevent stale tech stack data in navigation responses
- Fix: Include currentTab with techStack in all Firefox tool responses
- Fix: Accept tab info updates even when tab ID changes
- Fix tech stack propagation from Firefox to MCP server
- MCP server: Store and display tech stack in status header
- Add tech stack detection to both Chrome and Firefox extensions
- Remove bundled test pages and use remote URL
- Remove old mcp-wrapper.js (functionality now integrated into cli.js)
- Add Firefox extension PRO mode features and MCP improvements
- Fix reloadExtensions response format and add logging
- Fix Firefox extension reload to send response before reloading
- Fix Firefox extension PRO mode authentication and browser name display
- Add detailed render logging to debug popup visibility
- Fix infinite reconnection loop in Firefox extension
- Add error handling and logging to Firefox popup
- Rewrite Firefox popup to match Chrome UX and add OAuth PRO mode support
- Add test results: All 17 tests passed (100%)
- Add comprehensive test documentation and implementation summary
- Complete Firefox parity features and Chrome dialog auto-handling
- Add dialog event reporting and navigation listener for Firefox
- Don't delete dialog response - persist for all dialogs
- Auto-install dialog handlers on tab attach (Firefox)
- Fix Firefox test page: remove inline handlers, fix script reference
- Fix logEvent scope issue in test page JavaScript
- Add shared test page infrastructure with dialog testing section
- Implement browser_console_messages with content script
- Implement browser_fill_form, browser_lookup, browser_window, and browser_drag
- Implement browser_handle_dialog for alert, confirm, and prompt
- Add DOM commands for form operations and complete Phase 5.3-5.5
- Implement click, type, press_key interactions for Firefox extension
- Implement browser navigation commands for Firefox
- Add extension management tools for Firefox
- Add Firefox test page for interaction testing
- Redesign Firefox popup to match Chrome extension exactly
- Add Firefox extension MVP with basic automation support
- Bump version to 1.5.0
- Add visual click effect for all click actions
- Fix: Return downscaled screenshot buffer instead of original
- Fix: Auto-downscale screenshots exceeding 2000px limit
- Bump version to 1.4.1
- Add element detection to mouse_click action
- Add intelligent selector suggestions and lookup tool
- Add release script to automate version bumps and builds
- Make :has-text() selector case-insensitive and trim whitespace
- Add screenshot features: clickable highlighting and 1:1 scaling
- Bump version to 1.3.11
- 1.3.11
- Add mouseMoved event before click for better React compatibility
- Add visibility detection and multi-element warnings
- Fix button selector expansion with :has-text() pseudo-selector
- Bump version to 1.3.10
- 1.3.10
- Add helpful next steps recommendations after tab attach/create
- Update extension manifest version to 1.3.9
- Bump version to 1.3.9
- 1.3.9
- Implement per-tab storage for console logs and network requests
- Add Playwright-style selector preprocessing support
- Bump version to 1.3.8
- Add dynamic iframe monitoring with MutationObserver
- Add viewport info and coordinate system clarification to screenshots
- Add scroll improvements and scrollable area detection
- Bump root package version to 1.3.6
- Add debug mode toggle and improve logging
- Add safety checks for chrome.alarms API
- 1.3.5
- Add alarms permission to manifest
- 1.3.4
- Extract project_name from connection_status notification
- 1.3.3
- Send client_id to extension in Free tier mode
- 1.3.2
- Fix extension auto-reconnect using chrome.alarms
- Increase retry attempts and add version to error messages
- 1.3.1
- Add retry logic for list_extensions to handle stale extension list
- 1.3.0
- Add filtering and pagination to browser_network_requests
- 1.2.4
- Fix image-size import for CommonJS compatibility
- 1.2.3
- Fix browser_network_requests tool schema
- 1.2.2
- Add version display to status line and extension popup
- 1.2.1
- Add image-size dependency for screenshot dimension checking
- Add dimension check for screenshots to prevent API errors
- 1.2.0
- Add action-based network requests tool with replay and filtering
- 1.1.0
- Enhance network requests tool with headers and response bodies
- 1.0.1
- Remove dotenv dependency for clean MCP protocol output
- Fix production authentication and debug mode
- v1.0.0 - Open source release
