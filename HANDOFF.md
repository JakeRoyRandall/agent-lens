# Agent Lens — Handoff Document

Status: **Work in progress**
Last updated: 2026-02-25

## What This Project Is

Agent Lens is a Chrome extension + MCP server that gives AI coding agents (Claude Code, etc.) enhanced browser perception. It provides 12 MCP tools for DOM change detection, annotated screenshots, page readiness signals, viewport context, semantic page regions, extension management, and connection diagnostics.

## Current State

**Functional and tested.** All planned features are implemented. 20/20 E2E tests pass against real Chromium. MCP stdio protocol verified. Performance benchmarks captured.

### Commits

```
a131a66  Add screenshot optimization, error handling, diagnostics, tests, and docs
2e62a49  Implement Agent Lens Chrome extension + MCP server
ab20c62  Initial plan for Agent Lens
```

## Architecture

```
Claude Code ──stdio──> MCP Server (Node.js) ──WebSocket:17731──> Chrome Extension ──content scripts──> Page
```

- **MCP Server** (`mcp-server/`): Registers 12 tools via `@modelcontextprotocol/sdk`, stdio transport. Runs a WebSocket server on `localhost:17731` for extension communication.
- **Chrome Extension** (`extension/`): Manifest V3. Service worker connects as WebSocket client, routes requests to on-demand content scripts. Content scripts are injected via `chrome.scripting.executeScript()` on first use per tab.
- **Content Scripts** (`extension/src/content/`): Five modules — observer (MutationObserver), annotator (badge overlays), readiness (5-signal composite), viewport (scroll/element distribution), regions (semantic segmentation).

## File Map

```
extension/
  src/
    service-worker.ts        # WebSocket client, request router, screenshot coordination
    content/
      index.ts               # Message dispatcher to modules
      observer.ts            # DOM MutationObserver with 1000-entry capped buffer
      annotator.ts           # Numbered badge overlay + element metadata
      readiness.ts           # Network, animations, mutations, skeletons, readyState
      viewport.ts            # Scroll position, viewport dims, element distribution
      regions.ts             # ARIA landmarks > HTML5 elements > class fallbacks
    lib/
      types.ts               # All shared types, WebSocket protocol messages
      messaging.ts           # Service worker <-> content script bridge with injection
    popup/
      popup.html / popup.ts  # Simple connection status indicator
  manifest.json              # MV3, permissions: management, activeTab, scripting, tabs, webNavigation, offscreen
  build.ts                   # esbuild bundler (3 entry points)

mcp-server/
  src/
    index.ts                 # 12 tool registrations, screenshot image handler
    types.ts                 # Zod schemas for all tool params
    connection.ts            # WebSocket server, request/response correlation, diagnostics

test/
    e2e.ts                   # 20 tests — real Chromium + extension via Playwright
    integration.ts           # 13 tests — mock extension, MCP protocol
    mcp-handshake.ts         # 4 tests — stdio protocol verification
```

## All 12 Tools

| Tool | Category | Key Params |
|------|----------|------------|
| `dom_watch_start` | DOM Changes | `scope` (CSS selector), `mutations` (type filter) |
| `dom_watch_stop` | DOM Changes | — |
| `dom_changes_get` | DOM Changes | `clear` (default true) |
| `screenshot_annotated` | Screenshots | `scope`, `elementTypes`, `includeImage` (false = legend only, saves ~90K tokens) |
| `page_ready_check` | Readiness | — |
| `page_ready_wait` | Readiness | `timeout` (default 10s) |
| `viewport_info` | Viewport | — |
| `extensions_list` | Ext Mgmt | — |
| `extension_toggle` | Ext Mgmt | `id` or `name`, `enabled` |
| `extension_info` | Ext Mgmt | `id` |
| `page_regions` | Semantics | — |
| `connection_status` | Diagnostics | — |

## Performance

| Tool | Avg Latency | Response Size |
|------|-------------|---------------|
| Non-screenshot tools | <1ms | <200 bytes (~50 tokens) |
| Screenshot (legend only) | ~100ms | ~2KB (~500 tokens) |
| Screenshot (with image) | ~100ms | ~360KB (~90K tokens) |

## Known Issues to Fix

### TypeScript Strict Mode Errors (9 total, non-fatal)

The extension builds via esbuild which ignores type errors. These need fixing before `tsc --noEmit` passes clean:

1. **NodeList iterable errors** in `observer.ts` (lines 53, 75) and `regions.ts` (lines 164, 171, 179)
   - Fix: Add `"DOM.Iterable"` to `lib` in `extension/tsconfig.json`

2. **`captureVisibleTab` overload** in `service-worker.ts` (line 195)
   - Currently: `chrome.tabs.captureVisibleTab(undefined, { format: 'png', quality: 90 })`
   - Fix: `chrome.tabs.captureVisibleTab({ format: 'png', quality: 90 })` (drop `undefined` first arg)

3. **Dead `connected` variable** in `service-worker.ts` (line 13)
   - Fix: Remove it or use it in the badge update logic

4. **`DomWatchParams.mutations` type mismatch** in `content/index.ts` (line 31)
   - Fix: Cast `params.mutations` as `MutationType[]` or validate at runtime

### Functional Edge Cases

5. **Popup WebSocket conflict**: `popup.ts` opens a raw WebSocket to `localhost:17731` to check server status. The MCP server treats this as an extension connection, then immediately loses it when popup closes. Causes misleading reconnect logs.
   - Fix: Add a handshake/identification message so the server can distinguish popup pings from the real extension connection.

6. **`page_ready_check` network counting gap**: Uses `PerformanceResourceTiming` entries with `responseEnd === 0` to detect in-flight requests. This only sees requests that started after the page loaded and doesn't reliably detect XHR/fetch initiated after initial load.
   - Fix: Could use the `webRequest` permission (already declared as optional) or a `PerformanceObserver` to track requests in real-time.

7. **`page_regions` class fallback threshold**: Only triggers class-based detection when <3 landmark/semantic elements are found. Pages with 3+ semantic elements plus important class-based zones miss those zones.
   - Consider: Always include class-based zones that don't overlap with existing regions, regardless of count.

8. **Screenshot rate limiting**: Chrome's `captureVisibleTab` allows ~2 calls/second. Rapid consecutive calls throw `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`. The E2E test works around this with delays, but the service worker doesn't queue or throttle — an agent calling screenshot rapidly could hit this.
   - Fix: Add a throttle/queue in `handleAnnotatedScreenshot` in `service-worker.ts`.

## Not Yet Done (from PLAN.md)

| Item | Priority | Notes |
|------|----------|-------|
| npm publish for MCP server | Medium | `package.json` already has `bin` field set up |
| Chrome Web Store listing | Low | Manual install via `Load unpacked` works fine |
| LICENSE file | Low | Plan says MIT |
| HTTP/SSE transport option | Low | Only stdio transport implemented — limits to local use |
| Root-level test script | Low | Tests run manually: `bun test/e2e.ts`, etc. |
| `webRequest` optional permission | Low | Declared in manifest but never requested at runtime |

## How to Run

### Build

```bash
bun install              # root
bun run build            # builds both extension and mcp-server
```

### Load Extension

1. `chrome://extensions` > Developer mode > Load unpacked > select `extension/dist`
2. Extension auto-connects when MCP server is running

### Configure Claude Code

```bash
claude mcp add agent-lens node /absolute/path/to/agent-lens/mcp-server/dist/index.js
```

### Run Tests

```bash
bun test/integration.ts     # 13 tests, mock extension (no Chrome needed)
bun test/mcp-handshake.ts   # 4 tests, stdio protocol verification
bun test/e2e.ts             # 20 tests, real Chromium (needs extension built)
```

### Key Port

WebSocket server: `localhost:17731` — must be free. Kill stale processes with `lsof -i :17731`.

## Competitive Context

See `RESEARCH.md` for full analysis. Summary: No existing tool (Claude in Chrome, Chrome MCP Server, BrowserTools MCP, Playwright MCP) provides any of Agent Lens's 5 core capabilities. The closest is Playwright MCP's incremental snapshot diffs, but those are poll-based, not event-driven like our MutationObserver approach.

## Dependencies

**Extension:** `@types/chrome`, `esbuild`, `typescript` (all dev)
**MCP Server:** `@modelcontextprotocol/sdk`, `ws` (runtime); `@types/ws`, `tsup`, `typescript`, `zod` (dev)
**Root:** `@playwright/test`, `playwright` (dev, for E2E tests)
