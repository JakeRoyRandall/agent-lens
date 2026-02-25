/**
 * @fileoverview Popup UI for Agent Lens. Shows MCP server connection status.
 */

const dot = document.getElementById('dot')!
const label = document.getElementById('label')!

async function checkStatus() {
	try {
		const ws = new WebSocket('ws://localhost:17731')
		ws.onopen = () => {
			dot.className = 'dot connected'
			label.textContent = 'MCP server connected'
			ws.close()
		}
		ws.onerror = () => {
			dot.className = 'dot disconnected'
			label.textContent = 'MCP server not running'
		}
	} catch {
		dot.className = 'dot disconnected'
		label.textContent = 'MCP server not running'
	}
}

checkStatus()
