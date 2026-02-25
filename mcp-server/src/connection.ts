/**
 * @fileoverview WebSocket server that accepts connections from the Chrome extension.
 * Provides a request/response API for sending commands to the extension.
 */
import { WebSocketServer, WebSocket } from 'ws'

const PORT = 17731

type PendingRequest = {
	resolve: (data: unknown) => void
	reject: (err: Error) => void
	timer: ReturnType<typeof setTimeout>
}

type ConnectionStatus = {
	connected: boolean
	connectedSince: number | null
	lastActivity: number | null
}

let wss: WebSocketServer | null = null
let extensionSocket: WebSocket | null = null
const pendingRequests = new Map<string, PendingRequest>()
let requestCounter = 0
let reconnectCount = 0
let connectedSince: number | null = null
let lastActivity: number | null = null

/**
 * @description Start the WebSocket server and listen for extension connections.
 */
export function startServer(): void {
	wss = new WebSocketServer({ port: PORT })

	wss.on('error', (err: NodeJS.ErrnoException) => {
		if (err.code === 'EADDRINUSE') {
			console.error(`[agent-lens] Port ${PORT} in use. Another agent-lens instance may be running. Tools will return "extension not connected" until the port is freed.`)
		} else {
			console.error(`[agent-lens] WebSocket server error:`, err.message)
		}
	})

	wss.on('connection', (socket) => {
		reconnectCount++
		connectedSince = Date.now()
		lastActivity = Date.now()
		console.error(`[agent-lens] extension connected (connection #${reconnectCount})`)
		extensionSocket = socket

		socket.on('message', (raw) => {
			lastActivity = Date.now()
			try {
				const msg = JSON.parse(raw.toString())
				if (msg.type === 'response' && msg.id) {
					const pending = pendingRequests.get(msg.id)
					if (pending) {
						pendingRequests.delete(msg.id)
						clearTimeout(pending.timer)
						if (msg.success) {
							pending.resolve(msg.data)
						} else {
							pending.reject(new Error(msg.error ?? 'Unknown error'))
						}
					}
				}
			} catch (err) {
				console.error('[agent-lens] failed to parse message:', err)
			}
		})

		socket.on('close', () => {
			console.error('[agent-lens] extension disconnected')
			if (extensionSocket === socket) {
				extensionSocket = null
				connectedSince = null
			}
			// Reject all pending requests
			for (const [id, pending] of pendingRequests) {
				clearTimeout(pending.timer)
				pending.reject(new Error('Extension disconnected'))
				pendingRequests.delete(id)
			}
		})
	})

	console.error(`[agent-lens] WebSocket server listening on ws://localhost:${PORT}`)
}

/**
 * @description Send a request to the extension and wait for a response.
 */
export function sendRequest(action: string, params: Record<string, unknown> = {}, timeout = 30000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
			reject(new Error('Chrome extension not connected. Install Agent Lens extension and open Chrome.'))
			return
		}

		const id = `req_${++requestCounter}_${Date.now()}`
		const timer = setTimeout(() => {
			pendingRequests.delete(id)
			reject(new Error(`Request timed out after ${timeout}ms: ${action}`))
		}, timeout)

		pendingRequests.set(id, { resolve, reject, timer })
		lastActivity = Date.now()

		extensionSocket.send(JSON.stringify({
			id,
			type: 'request',
			action,
			params,
		}))
	})
}

/**
 * @description Check if the extension is currently connected.
 */
export function isConnected(): boolean {
	return extensionSocket !== null && extensionSocket.readyState === WebSocket.OPEN
}

/**
 * @description Get detailed connection status for diagnostics.
 */
export function getConnectionStatus(): ConnectionStatus {
	return {
		connected: isConnected(),
		connectedSince,
		lastActivity,
	}
}

/**
 * @description Stop the WebSocket server.
 */
export function stopServer(): void {
	wss?.close()
	wss = null
}
