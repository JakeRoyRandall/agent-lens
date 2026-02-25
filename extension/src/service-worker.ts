/**
 * @fileoverview Service worker for Agent Lens Chrome extension.
 * Connects to the MCP server's WebSocket, routes requests to content scripts,
 * and handles extension management APIs directly.
 */
import type { RequestMessage, ResponseMessage, ActionType } from './lib/types'
import { sendToContentScript, clearInjectedTab } from './lib/messaging'

const WS_URL = 'ws://localhost:17731'
const RECONNECT_INTERVAL = 3000

let ws: WebSocket | null = null
let connected = false

// ── WebSocket Connection ────────────────────────────────────────────

function connect(): void {
	if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return

	try {
		ws = new WebSocket(WS_URL)
	} catch {
		scheduleReconnect()
		return
	}

	ws.onopen = () => {
		connected = true
		updateBadge(true)
		console.log('[agent-lens] connected to MCP server')
	}

	ws.onmessage = async (event) => {
		try {
			const msg: RequestMessage = JSON.parse(event.data as string)
			if (msg.type !== 'request') return
			const response = await handleRequest(msg)
			ws?.send(JSON.stringify(response))
		} catch (err) {
			console.error('[agent-lens] message handling error:', err)
		}
	}

	ws.onclose = () => {
		connected = false
		ws = null
		updateBadge(false)
		scheduleReconnect()
	}

	ws.onerror = () => {
		ws?.close()
	}
}

function scheduleReconnect(): void {
	setTimeout(connect, RECONNECT_INTERVAL)
}

// ── Request Routing ─────────────────────────────────────────────────

const EXTENSION_ACTIONS: Set<ActionType> = new Set([
	'ping',
	'extensions_list',
	'extension_toggle',
	'extension_info',
])

async function handleRequest(msg: RequestMessage): Promise<ResponseMessage> {
	const { id, action, params } = msg

	try {
		if (action === 'ping') {
			return { id, type: 'response', success: true, data: { pong: true, timestamp: Date.now() } }
		}

		if (EXTENSION_ACTIONS.has(action)) {
			const data = await handleExtensionAction(action, params)
			return { id, type: 'response', success: true, data }
		}

		// All other actions go to the content script in the active tab
		const tab = await getActiveTab()
		if (!tab?.id) {
			return { id, type: 'response', success: false, error: 'No active tab found' }
		}

		// Annotated screenshots need special handling: content script creates overlay,
		// service worker captures screenshot, then content script cleans up
		if (action === 'screenshot_annotated') {
			return await handleAnnotatedScreenshot(id, tab.id, params)
		}

		const result = await sendToContentScript(tab.id, action, params)
		if (!result.success) {
			return { id, type: 'response', success: false, error: result.error }
		}
		return { id, type: 'response', success: true, data: result.data }
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return { id, type: 'response', success: false, error: message }
	}
}

// ── Extension Management (handled directly in service worker) ───────

async function handleExtensionAction(action: ActionType, params: Record<string, unknown>): Promise<unknown> {
	switch (action) {
		case 'extensions_list': {
			const all = await chrome.management.getAll()
			return {
				extensions: all
					.filter(ext => ext.type === 'extension' && ext.id !== chrome.runtime.id)
					.map(ext => ({
						id: ext.id,
						name: ext.name,
						enabled: ext.enabled,
						version: ext.version,
						description: ext.description,
					})),
			}
		}

		case 'extension_toggle': {
			const { id, name, enabled } = params as { id?: string; name?: string; enabled: boolean }
			let targetId = id
			if (!targetId && name) {
				const all = await chrome.management.getAll()
				const match = all.find(ext =>
					ext.name.toLowerCase().includes((name as string).toLowerCase())
				)
				if (!match) throw new Error(`Extension not found: ${name}`)
				targetId = match.id
			}
			if (!targetId) throw new Error('Must provide id or name')
			await chrome.management.setEnabled(targetId, enabled)
			const ext = await chrome.management.get(targetId)
			return { id: ext.id, name: ext.name, enabled: ext.enabled }
		}

		case 'extension_info': {
			const { id } = params as { id: string }
			if (!id) throw new Error('Must provide extension id')
			const ext = await chrome.management.get(id)
			return {
				id: ext.id,
				name: ext.name,
				enabled: ext.enabled,
				version: ext.version,
				description: ext.description,
				permissions: ext.permissions,
				hostPermissions: ext.hostPermissions,
				optionsUrl: ext.optionsUrl,
				homepageUrl: ext.homepageUrl,
				installType: ext.installType,
				type: ext.type,
			}
		}

		default:
			throw new Error(`Unknown extension action: ${action}`)
	}
}

// ── Annotated Screenshot Coordination ────────────────────────────────

async function handleAnnotatedScreenshot(
	requestId: string,
	tabId: number,
	params: Record<string, unknown>
): Promise<ResponseMessage> {
	// Step 1: Tell content script to find elements and create badge overlay
	const annotationResult = await sendToContentScript(tabId, 'screenshot_annotated', params)
	if (!annotationResult.success) {
		return { id: requestId, type: 'response', success: false, error: annotationResult.error }
	}

	const data = annotationResult.data as {
		image: string
		elements: Record<string, unknown>
		viewport: Record<string, unknown>
	}

	try {
		// Step 2: Small delay for overlay to render
		await new Promise(r => setTimeout(r, 50))

		// Step 3: Capture screenshot with overlay visible
		const dataUrl = await chrome.tabs.captureVisibleTab(undefined, {
			format: 'png',
			quality: 90,
		})

		// Step 4: Clean up overlay
		await sendToContentScript(tabId, 'screenshot_cleanup' as ActionType, {})

		// Step 5: Return screenshot + element legend
		return {
			id: requestId,
			type: 'response',
			success: true,
			data: {
				image: dataUrl,
				elements: data.elements,
				viewport: data.viewport,
			},
		}
	} catch (err) {
		// Always clean up overlay even on error
		await sendToContentScript(tabId, 'screenshot_cleanup' as ActionType, {}).catch(() => {})
		const message = err instanceof Error ? err.message : String(err)
		return { id: requestId, type: 'response', success: false, error: message }
	}
}

// ── Helpers ─────────────────────────────────────────────────────────

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
	return tab
}

function updateBadge(isConnected: boolean): void {
	chrome.action.setBadgeText({ text: isConnected ? 'ON' : '' })
	chrome.action.setBadgeBackgroundColor({ color: isConnected ? '#22c55e' : '#6b7280' })
}

// ── Tab Lifecycle ───────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
	clearInjectedTab(tabId)
})

chrome.webNavigation.onCommitted.addListener(({ tabId }) => {
	clearInjectedTab(tabId)
})

// ── Initialize ──────────────────────────────────────────────────────

connect()
