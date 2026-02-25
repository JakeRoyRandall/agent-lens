# Agent Lens

A Chrome extension + MCP server that gives AI coding agents enhanced browser perception capabilities. It bridges the gap between what agents can do (click, type, navigate) and what they can see and understand about a page.

## Why Agent Lens?

Existing browser tools for AI agents handle interaction well -- clicking, typing, navigating, taking screenshots. But they lack a perception layer. After an agent clicks a button, it has no efficient way to know:

- **Is the page ready?** Did the navigation finish? Are spinners still spinning? Is the network idle?
- **What changed?** Which DOM nodes were added, removed, or modified since the last action?
- **Where am I looking?** What percentage of the page is visible? Are the interactive elements above or below the fold?
- **What is this page?** Where are the nav, main content, sidebar, and footer regions?

Agent Lens fills this perception gap with 12 lightweight MCP tools that provide structured, token-efficient answers to these questions.

## Architecture

```
Claude Code (or any MCP client)
    |
    | stdio (MCP protocol)
    v
MCP Server (Node.js)
    |
    | WebSocket (localhost:17731)
    v
Chrome Extension (Manifest V3)
    |
    | Content scripts
    v
Active browser tab
```

The Chrome extension runs content scripts that observe, annotate, and analyze pages. The MCP server exposes these capabilities as tools over the standard MCP stdio transport. The WebSocket connection between them is automatic -- open Chrome and the extension connects.

## Tools

### DOM Change Detection

| Tool | Description |
|------|-------------|
| `dom_watch_start` | Start a MutationObserver on the active tab. Params: `scope` (CSS selector), `mutations` (filter by type). |
| `dom_watch_stop` | Stop observing. |
| `dom_changes_get` | Get buffered mutations: additions, removals, attribute changes, text changes. Auto-clears the buffer. |

### Annotated Screenshots

| Tool | Description |
|------|-------------|
| `screenshot_annotated` | Capture a screenshot with numbered badges overlaid on interactive elements. Returns the image + an element legend with tag, text, bounding rect, and type. Set `includeImage: false` to skip the image and get just the legend. |

### Page Readiness

| Tool | Description |
|------|-------------|
| `page_ready_check` | Composite readiness check: pending network requests, running animations, recent DOM mutations, skeleton loaders, document ready state. |
| `page_ready_wait` | Poll `page_ready_check` until the page is stable or timeout is reached. |

### Viewport Context

| Tool | Description |
|------|-------------|
| `viewport_info` | Scroll position, viewport dimensions, visible page percentage, interactive element distribution above/in/below the viewport. |

### Page Regions

| Tool | Description |
|------|-------------|
| `page_regions` | Semantic page segmentation using ARIA landmarks, HTML5 sectioning elements, and class-name fallbacks. |

### Extension Management

| Tool | Description |
|------|-------------|
| `extensions_list` | List all installed Chrome extensions. |
| `extension_toggle` | Enable or disable an extension by ID. |
| `extension_info` | Get detailed info about a specific extension. |

### Diagnostics

| Tool | Description |
|------|-------------|
| `connection_status` | WebSocket connection health: connected state, uptime, last activity. Use to diagnose connectivity issues. |

## Performance

| Category | Latency | Response Size | Token Cost |
|----------|---------|---------------|------------|
| Non-screenshot tools | <1ms | <200 bytes | ~50 tokens |
| Screenshot (legend only) | ~100ms | ~2KB | ~500 tokens |
| Screenshot (with image) | ~100ms | ~360KB | ~90K tokens |

Setting `includeImage: false` on `screenshot_annotated` drops the cost from ~90K tokens to ~500 tokens while still returning the full element legend.

## Setup

### Requirements

- Chrome or Chromium
- Node.js 18+
- Bun

### 1. Build the extension

```bash
cd extension && bun install && bun run build
```

Then load it in Chrome:
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/dist` directory

### 2. Build the MCP server

```bash
cd mcp-server && bun install && bun run build
```

### 3. Configure Claude Code

Option A -- CLI:

```bash
claude mcp add agent-lens node /absolute/path/to/agent-lens/mcp-server/dist/index.js
```

Option B -- settings file (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "agent-lens": {
      "command": "node",
      "args": ["/absolute/path/to/agent-lens/mcp-server/dist/index.js"]
    }
  }
}
```

### 4. Connect

Open Chrome. The extension auto-connects to the MCP server's WebSocket on `localhost:17731`. The tools are now available in Claude Code.

## Project Structure

```
agent-lens/
├── extension/              # Chrome extension (Manifest V3)
│   ├── src/
│   │   ├── content/        # Content scripts
│   │   │   ├── observer.ts     # DOM MutationObserver
│   │   │   ├── annotator.ts    # Screenshot annotation
│   │   │   ├── readiness.ts    # Page readiness checks
│   │   │   ├── viewport.ts     # Viewport analysis
│   │   │   └── regions.ts      # Semantic page regions
│   │   ├── lib/            # Shared types and messaging
│   │   ├── popup/          # Extension popup UI
│   │   └── service-worker.ts
│   └── dist/               # Built extension (load this in Chrome)
├── mcp-server/             # MCP server (Node.js, stdio transport)
│   ├── src/
│   │   ├── index.ts        # Tool registrations
│   │   ├── types.ts        # Zod schemas
│   │   └── connection.ts   # WebSocket server
│   └── dist/               # Built server
├── test/                   # Integration and E2E tests
├── tsconfig.base.json      # Shared TypeScript config
└── package.json            # Workspace root
```

## Tech Stack

- **Language**: TypeScript
- **Extension build**: esbuild
- **MCP server build**: tsup
- **MCP SDK**: @modelcontextprotocol/sdk
- **Communication**: WebSocket (extension <-> server), stdio (server <-> MCP client)
- **Testing**: Playwright

## Development

Build everything from the repo root:

```bash
bun run build
```

Run the MCP server in watch mode:

```bash
bun run dev:mcp
```

After changing extension code, rebuild and reload:

```bash
cd extension && bun run build
```

Then click the reload button on `chrome://extensions` for the Agent Lens entry.
