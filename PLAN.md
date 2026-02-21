# Agent Lens — Chrome Extension for AI Browser Agents

## Context

AI agents (Claude, GPT, etc.) interact with browsers through tools like Playwright MCP, Claude in Chrome, and agent-browser. These tools give agents the ability to navigate, click, fill forms, and take screenshots. But there are critical gaps in what agents can perceive and understand about the page — gaps that cause unnecessary round-trips, wrong assumptions, and wasted tokens.

**The core problem:** Browsers render for human eyes (pixels), but agents need structured understanding. Current tools give agents either raw DOM trees (too noisy) or screenshots (no actionable refs). Nothing bridges the gap well.

**What exists today:**
- **WebMCP (W3C/Chrome 146)** — Lets websites expose structured tools to agents. Website-side, opt-in. Doesn't help with existing sites that haven't adopted it.
- **Chrome DevTools MCP** — Debugging tools (network, console, performance). No DOM diffing, no change detection, no extension management.
- **Chrome MCP Server (hangwin/mcp-chrome)** — 20+ browser tools including semantic search with vector DB. Closest to what we want but missing DOM diffing, annotated screenshots, and extension management.
- **BrowserTools MCP (AgentDesk)** — Console/network monitoring, Lighthouse audits. No DOM diffing or change detection.
- **Playwright MCP / agent-browser** — Navigation and interaction via accessibility tree snapshots. No mutation tracking.
- **Sentience API** — Verification layer with semantic snapshots for assertions/traces. Focused on testing, not agent assistance.

**What nobody is building:** The agent-side perception layer — DOM change detection, annotated screenshots, page readiness signals, and extension management as MCP tools. This is the gap.

## What We're Building

**Agent Lens** — A Chrome extension + MCP server that gives AI agents enhanced perception capabilities when working in the browser. It complements existing tools (Claude in Chrome, Playwright MCP) rather than replacing them.

### Will It Interfere With Normal Browser Use?

**No.** The extension is passive by default:
- It does NOT inject visible UI into web pages (no overlays, no badges, no popups during normal browsing)
- It does NOT intercept or modify network requests
- It does NOT run content scripts until an MCP client connects and requests an action
- The Mutation Observer only activates when an agent session is active
- When no MCP client is connected, the extension is completely inert — zero performance impact
- It's equivalent to having React DevTools installed but never opening the DevTools panel

The only visible element is a small toolbar icon showing connection status (gray = inactive, green = agent connected).

---

## Architecture

```
┌─────────────────────────────────────────┐
│  AI Agent (Claude Code, Cursor, etc.)   │
│  via MCP Client                         │
└──────────────┬──────────────────────────┘
               │ MCP Protocol (stdio or HTTP)
┌──────────────▼──────────────────────────┐
│  MCP Server (Node.js)                   │
│  - Exposes tools to AI agent            │
│  - Translates MCP calls → extension msgs│
└──────────────┬──────────────────────────┘
               │ WebSocket (localhost:17731)
┌──────────────▼──────────────────────────┐
│  Chrome Extension                       │
│  ├─ Service Worker (background)         │
│  │  - WebSocket server                  │
│  │  - chrome.management API             │
│  │  - Tab/window management             │
│  ├─ Content Script (injected on demand) │
│  │  - MutationObserver for DOM diffing  │
│  │  - Element annotation renderer       │
│  │  - Page readiness detection          │
│  │  - Viewport tracking                 │
│  └─ Offscreen Document (optional)       │
│     - Screenshot annotation compositing │
└─────────────────────────────────────────┘
```

---

## MCP Tools to Expose

### Category 1: DOM Change Detection

**`dom_watch_start`**
- Activates MutationObserver on the active tab
- Watches for: element additions, removals, attribute changes, text changes
- Configurable: scope to a CSS selector, filter by mutation type
- Returns: confirmation + watch ID

**`dom_watch_stop`**
- Stops the observer
- Returns: nothing

**`dom_changes_get`**
- Returns structured list of all DOM mutations since last call (or since watch started)
- Output format:
  ```json
  {
    "changes": [
      { "type": "added", "selector": "div.modal.active", "text": "Confirm deletion?", "parent": "body" },
      { "type": "attribute", "selector": "button#submit", "attribute": "disabled", "old": null, "new": "true" },
      { "type": "text", "selector": "span.status", "old": "Saving...", "new": "Saved" },
      { "type": "removed", "selector": "div.loading-spinner" }
    ],
    "count": 4,
    "duration_ms": 1200
  }
  ```
- Clears the buffer after reading (or optionally keeps it)

### Category 2: Annotated Screenshots

**`screenshot_annotated`**
- Takes a screenshot of the current viewport
- Overlays numbered badges on all interactive elements (buttons, links, inputs, selects)
- Returns: screenshot image + legend mapping numbers to element details
  ```json
  {
    "image": "base64...",
    "elements": {
      "1": { "tag": "button", "text": "Submit", "rect": { "x": 450, "y": 320, "w": 120, "h": 40 } },
      "2": { "tag": "input", "type": "email", "placeholder": "Enter email", "rect": { "x": 200, "y": 200, "w": 300, "h": 36 } },
      "3": { "tag": "a", "text": "Learn more", "href": "/about", "rect": { "x": 100, "y": 500, "w": 80, "h": 20 } }
    },
    "viewport": { "width": 1280, "height": 720, "scrollY": 0, "pageHeight": 3200 }
  }
  ```
- Options: filter by element type, scope to CSS selector, include/exclude off-screen elements

### Category 3: Page Readiness

**`page_ready_check`**
- Checks multiple signals and returns readiness state:
  ```json
  {
    "ready": false,
    "signals": {
      "pending_network_requests": 2,
      "active_animations": 1,
      "recent_dom_mutations": true,
      "loading_skeletons_visible": true,
      "document_ready_state": "complete"
    },
    "recommendation": "wait"
  }
  ```

**`page_ready_wait`**
- Blocks until all readiness signals clear (or timeout)
- Configurable timeout (default 10s)
- Returns when page is visually stable

### Category 4: Viewport & Spatial Context

**`viewport_info`**
- Returns current viewport context:
  ```json
  {
    "scroll": { "x": 0, "y": 450, "maxX": 0, "maxY": 3200 },
    "viewport": { "width": 1280, "height": 720 },
    "visible_percentage": "14-36%",
    "interactive_elements": {
      "in_viewport": 8,
      "above_viewport": 3,
      "below_viewport": 12
    }
  }
  ```

### Category 5: Extension Management

**`extensions_list`**
- Lists all installed extensions with status
  ```json
  {
    "extensions": [
      { "id": "abc123", "name": "uBlock Origin", "enabled": true, "version": "1.55.0" },
      { "id": "def456", "name": "React DevTools", "enabled": false, "version": "5.0.0" }
    ]
  }
  ```

**`extension_toggle`**
- Enable or disable an extension by ID or name
- Parameters: `id` or `name`, `enabled` (boolean)
- Returns: confirmation with new state

**`extension_info`**
- Get detailed info about a specific extension (permissions, content scripts, options URL)

### Category 6: Page Semantics

**`page_regions`**
- Segments the page into semantic regions using heuristics (landmark roles, common selectors, heading hierarchy)
  ```json
  {
    "regions": [
      { "role": "header", "selector": "header", "rect": { "y": 0, "height": 64 }, "summary": "Navigation with logo, 5 nav links, user menu" },
      { "role": "main", "selector": "main", "rect": { "y": 64, "height": 2800 }, "summary": "Product listing with 24 cards in 4-column grid" },
      { "role": "footer", "selector": "footer", "rect": { "y": 2864, "height": 336 }, "summary": "4 column footer with links, copyright" }
    ]
  }
  ```

---

## Project Structure

```
agent-lens/
├── extension/                    # Chrome Extension (Manifest V3)
│   ├── manifest.json
│   ├── service-worker.ts         # Background script — WebSocket server, chrome.management
│   ├── content/
│   │   ├── observer.ts           # MutationObserver logic
│   │   ├── annotator.ts          # Element annotation overlay
│   │   ├── readiness.ts          # Page readiness detection
│   │   ├── regions.ts            # Semantic page segmentation
│   │   └── viewport.ts           # Viewport tracking
│   ├── lib/
│   │   ├── messaging.ts          # Content script ↔ service worker messaging
│   │   └── types.ts              # Shared types
│   ├── popup/
│   │   ├── popup.html            # Minimal status popup
│   │   └── popup.ts              # Connection status display
│   └── icons/                    # Extension icons
├── mcp-server/                   # MCP Server (Node.js)
│   ├── index.ts                  # Entry point — MCP server setup
│   ├── tools/
│   │   ├── dom-changes.ts        # dom_watch_start, dom_watch_stop, dom_changes_get
│   │   ├── screenshots.ts        # screenshot_annotated
│   │   ├── readiness.ts          # page_ready_check, page_ready_wait
│   │   ├── viewport.ts           # viewport_info
│   │   ├── extensions.ts         # extensions_list, extension_toggle, extension_info
│   │   └── regions.ts            # page_regions
│   ├── connection.ts             # WebSocket client to extension
│   └── types.ts                  # MCP tool schemas
├── package.json                  # Monorepo root
├── tsconfig.json
├── PLAN.md
├── LICENSE
└── README.md
```

## Tech Stack

- **Extension**: TypeScript, Manifest V3, Chrome APIs
- **MCP Server**: TypeScript, `@modelcontextprotocol/sdk`, WebSocket (`ws`)
- **Build**: `bun` for package management, `esbuild` or `tsup` for bundling
- **No frameworks** in the extension — vanilla TS to keep it lightweight

## Manifest Permissions

```json
{
  "manifest_version": 3,
  "name": "Agent Lens",
  "permissions": [
    "management",
    "activeTab",
    "scripting",
    "tabs",
    "webNavigation"
  ],
  "optional_permissions": [
    "webRequest"
  ],
  "host_permissions": ["<all_urls>"]
}
```

- `management` — List/toggle other extensions
- `activeTab` + `scripting` — Inject content scripts on demand (not all pages all the time)
- `tabs` — Tab info and navigation events
- `webNavigation` — Page load lifecycle events
- `webRequest` (optional) — Only activated for pending request tracking in readiness checks

---

## Implementation Plan

### Phase 1: Scaffold & Core Infrastructure (Day 1)
1. Create project folder
2. Initialize monorepo with `bun init`
3. Set up TypeScript config
4. Create Chrome extension manifest
5. Build service worker with WebSocket server (localhost:17731)
6. Build MCP server with WebSocket client
7. Verify extension ↔ MCP server communication round-trip
8. Add build scripts (bundle extension, bundle MCP server)

### Phase 2: DOM Change Detection (Day 1-2)
1. Implement content script MutationObserver
2. Build mutation buffer with structured output format
3. Implement `dom_watch_start`, `dom_watch_stop`, `dom_changes_get` MCP tools
4. Test with a page that has dynamic content (toasts, modals, live updates)

### Phase 3: Annotated Screenshots (Day 2)
1. Implement interactive element detection in content script
2. Build canvas-based annotation overlay (numbered badges)
3. Compose screenshot + overlay using offscreen document or content script canvas
4. Implement `screenshot_annotated` MCP tool with legend
5. Test across different page types (forms, dashboards, landing pages)

### Phase 4: Page Readiness & Viewport (Day 2-3)
1. Implement readiness signal checks (network, animations, DOM stability, skeletons)
2. Build `page_ready_check` and `page_ready_wait` tools
3. Implement viewport tracking with element visibility mapping
4. Build `viewport_info` tool

### Phase 5: Extension Management (Day 3)
1. Implement `chrome.management` API wrappers
2. Build `extensions_list`, `extension_toggle`, `extension_info` tools
3. Test enabling/disabling extensions programmatically

### Phase 6: Page Semantics (Day 3)
1. Implement landmark/region detection heuristics
2. Build `page_regions` tool with summary generation
3. Test across various page layouts

### Phase 7: Polish & Publish (Day 4)
1. Add popup UI showing connection status
2. Create extension icons
3. Write README with setup instructions
4. Package for Chrome Web Store
5. Publish MCP server as npm package (`agent-lens`)
6. Test end-to-end with Claude Code using both stdio and HTTP transport

---

## Verification Plan

### Manual Testing
1. Install extension in Chrome, configure MCP server in Claude Code
2. Navigate to a complex page (e.g., GitHub PR page)
3. Call `dom_watch_start` → click a button → call `dom_changes_get` → verify it reports the correct mutations
4. Call `screenshot_annotated` → verify numbered badges appear on interactive elements and legend is accurate
5. Navigate to a slow-loading SPA → call `page_ready_check` → verify it reports "not ready" during load → call `page_ready_wait` → verify it resolves when stable
6. Call `extensions_list` → verify it shows installed extensions → call `extension_toggle` to disable one → verify it's disabled in `chrome://extensions`
7. Call `page_regions` → verify semantic segmentation matches visible page structure

### Integration Testing
- Use Claude Code to perform a multi-step browser task and verify the tools reduce round-trips compared to using Claude in Chrome alone

---

## Competitive Landscape Summary

| Feature | Agent Lens | Chrome MCP (hangwin) | BrowserTools MCP | DevTools MCP | WebMCP |
|---------|-----------|---------------------|------------------|-------------|--------|
| DOM change detection | Yes | No | No | No | No |
| Annotated screenshots | Yes | No | No | No | No |
| Page readiness signal | Yes | No | No | No | No |
| Viewport context | Yes | No | No | No | No |
| Extension management | Yes | No | No | No | No |
| Semantic regions | Yes | Semantic search | No | No | Website-defined |
| Network monitoring | No* | Yes | Yes | Yes | No |
| Console logs | No* | Yes | Yes | Yes | No |
| Performance profiling | No* | No | Yes (Lighthouse) | Yes | No |

*Not in scope — these are well-served by existing tools. Agent Lens focuses on the perception gap.

---

## Publishing Plan

1. **Chrome Web Store** — Free extension, public listing
2. **npm** — `agent-lens` package for the MCP server (`bunx agent-lens` to run)
3. **GitHub** — Open source, MIT license
4. **Setup**: Users install extension + add MCP server to their claude_desktop_config.json or .claude.json
