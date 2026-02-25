#!/usr/bin/env node
/**
 * @fileoverview Agent Lens MCP server entry point.
 * Registers all tools and starts the WebSocket server for extension communication.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { startServer, sendRequest, isConnected, getConnectionStatus } from './connection.js'
import {
	DomWatchStartSchema,
	DomWatchStopSchema,
	DomChangesGetSchema,
	ScreenshotAnnotatedSchema,
	PageReadyCheckSchema,
	PageReadyWaitSchema,
	ViewportInfoSchema,
	ExtensionsListSchema,
	ExtensionToggleSchema,
	ExtensionInfoSchema,
	PageRegionsSchema,
} from './types.js'

const server = new McpServer({
	name: 'agent-lens',
	version: '0.1.0',
})

// ── Helper ──────────────────────────────────────────────────────────

type ToolResult = { content: { type: 'text'; text: string }[] }

function toolHandler(action: string, timeout?: number) {
	return async (args: Record<string, unknown>): Promise<ToolResult> => {
		if (!isConnected()) {
			return {
				content: [{ type: 'text' as const, text: 'Error: Chrome extension not connected. Install Agent Lens extension and open Chrome.' }],
			}
		}

		try {
			const result = await sendRequest(action, args, timeout)
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return {
				content: [{ type: 'text' as const, text: `Error: ${message}` }],
			}
		}
	}
}

// ── DOM Change Detection Tools ──────────────────────────────────────

server.tool(
	'dom_watch_start',
	'Start watching for DOM mutations on the active tab. Activates a MutationObserver that tracks element additions, removals, attribute changes, and text changes. Optionally scope to a CSS selector and filter by mutation type.',
	DomWatchStartSchema,
	toolHandler('dom_watch_start'),
)

server.tool(
	'dom_watch_stop',
	'Stop the DOM mutation observer on the active tab.',
	DomWatchStopSchema,
	toolHandler('dom_watch_stop'),
)

server.tool(
	'dom_changes_get',
	'Get all DOM mutations captured since the last read (or since watch started). Returns a structured list of changes with selectors, old/new values, and parent context. Clears the buffer by default.',
	DomChangesGetSchema,
	toolHandler('dom_changes_get'),
)

// ── Annotated Screenshots ───────────────────────────────────────────

type ImageContent = { type: 'image'; data: string; mimeType: string }
type TextContent = { type: 'text'; text: string }
type ContentBlock = ImageContent | TextContent

server.tool(
	'screenshot_annotated',
	'Take a screenshot of the current viewport with numbered badges overlaid on all interactive elements (buttons, links, inputs, selects). Returns the annotated image as base64 plus a structured legend mapping each number to element details (tag, text, type, bounding rect). Optionally scope to a CSS selector or filter by element type. Set includeImage=false to skip the image and only return the element legend (saves ~90K tokens).',
	ScreenshotAnnotatedSchema,
	async (args: Record<string, unknown>): Promise<{ content: ContentBlock[] }> => {
		if (!isConnected()) {
			return {
				content: [{ type: 'text' as const, text: 'Error: Chrome extension not connected. Install Agent Lens extension and open Chrome.' }],
			}
		}

		try {
			const includeImage = args.includeImage !== false
			const result = await sendRequest('screenshot_annotated', args) as Record<string, unknown>
			const content: ContentBlock[] = []

			// Extract and return the annotated screenshot as a proper image content block
			if (includeImage && typeof result.image === 'string') {
				const raw = result.image as string
				const base64 = raw.replace(/^data:image\/png;base64,/, '')
				content.push({ type: 'image' as const, data: base64, mimeType: 'image/png' })
			}

			// Return the element legend and viewport info as structured text
			const { image: _image, ...legend } = result
			content.push({ type: 'text' as const, text: JSON.stringify(legend, null, 2) })

			return { content }
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return {
				content: [{ type: 'text' as const, text: `Error: ${message}` }],
			}
		}
	},
)

// ── Page Readiness ──────────────────────────────────────────────────

server.tool(
	'page_ready_check',
	'Check if the current page is visually stable and ready for interaction. Returns composite readiness signals: pending network requests, active animations, recent DOM mutations, visible loading skeletons, and document ready state. Includes a recommendation of "ready" or "wait".',
	PageReadyCheckSchema,
	toolHandler('page_ready_check'),
)

server.tool(
	'page_ready_wait',
	'Block until the page is visually stable (all readiness signals clear) or timeout is reached. Default timeout: 10 seconds. Returns the final readiness state.',
	PageReadyWaitSchema,
	toolHandler('page_ready_wait', 15000),
)

// ── Viewport & Spatial Context ──────────────────────────────────────

server.tool(
	'viewport_info',
	'Get current viewport context: scroll position, viewport dimensions, visible page percentage, and count of interactive elements in/above/below the viewport.',
	ViewportInfoSchema,
	toolHandler('viewport_info'),
)

// ── Extension Management ────────────────────────────────────────────

server.tool(
	'extensions_list',
	'List all installed Chrome extensions with their enabled/disabled status, version, and description.',
	ExtensionsListSchema,
	toolHandler('extensions_list'),
)

server.tool(
	'extension_toggle',
	'Enable or disable a Chrome extension by ID or name (partial match). Returns the new state.',
	ExtensionToggleSchema,
	toolHandler('extension_toggle'),
)

server.tool(
	'extension_info',
	'Get detailed information about a Chrome extension: permissions, host permissions, options URL, homepage, install type.',
	ExtensionInfoSchema,
	toolHandler('extension_info'),
)

// ── Page Semantics ──────────────────────────────────────────────────

server.tool(
	'page_regions',
	'Segment the current page into semantic regions using landmarks, headings, and common layout patterns. Returns regions with role, CSS selector, bounding rect, and a text summary of contents.',
	PageRegionsSchema,
	toolHandler('page_regions'),
)

// ── Diagnostics ────────────────────────────────────────────────────

server.tool(
	'connection_status',
	'Check the WebSocket connection health between the MCP server and Chrome extension. Returns connected state, uptime, and last activity timestamp. Use this to diagnose "extension not connected" issues.',
	{},
	async (): Promise<ToolResult> => {
		const status = getConnectionStatus()
		const info: Record<string, unknown> = {
			connected: status.connected,
			connectedSince: status.connectedSince ? new Date(status.connectedSince).toISOString() : null,
			uptimeMs: status.connectedSince ? Date.now() - status.connectedSince : null,
			lastActivity: status.lastActivity ? new Date(status.lastActivity).toISOString() : null,
			lastActivityAgoMs: status.lastActivity ? Date.now() - status.lastActivity : null,
		}
		return {
			content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
		}
	},
)

// ── Start ───────────────────────────────────────────────────────────

async function main() {
	startServer()

	const transport = new StdioServerTransport()
	await server.connect(transport)
	console.error('[agent-lens] MCP server running (stdio transport)')
}

main().catch((err) => {
	console.error('[agent-lens] fatal error:', err)
	process.exit(1)
})
