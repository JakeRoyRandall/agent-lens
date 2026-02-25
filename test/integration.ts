#!/usr/bin/env bun
/**
 * @fileoverview Integration test for Agent Lens MCP server.
 * Spawns the MCP server, connects a fake extension via WebSocket,
 * sends MCP tool calls via stdio, and verifies responses.
 */
import { spawn } from 'child_process'
import WebSocket from 'ws'

const MCP_SERVER_PATH = new URL('../mcp-server/dist/index.js', import.meta.url).pathname
const WS_PORT = 17731

type TestResult = { name: string; pass: boolean; duration: number; error?: string; response?: unknown }
const results: TestResult[] = []

// ── MCP Protocol Helpers ────────────────────────────────────────────

let requestId = 0

function mcpRequest(method: string, params: Record<string, unknown> = {}) {
	return JSON.stringify({
		jsonrpc: '2.0',
		id: ++requestId,
		method,
		params,
	}) + '\n'
}

function parseMcpResponse(line: string): { id: number; result?: unknown; error?: unknown } | null {
	try {
		const parsed = JSON.parse(line)
		if (parsed.jsonrpc === '2.0' && parsed.id) return parsed
		return null
	} catch {
		return null
	}
}

// ── Test Runner ─────────────────────────────────────────────────────

async function runTest(name: string, fn: () => Promise<unknown>): Promise<void> {
	const start = performance.now()
	try {
		const response = await fn()
		const duration = Math.round(performance.now() - start)
		results.push({ name, pass: true, duration, response })
		console.log(`  ✓ ${name} (${duration}ms)`)
	} catch (err) {
		const duration = Math.round(performance.now() - start)
		const error = err instanceof Error ? err.message : String(err)
		results.push({ name, pass: false, duration, error })
		console.log(`  ✗ ${name} (${duration}ms) — ${error}`)
	}
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
	console.log('\n═══ Agent Lens Integration Tests ═══\n')

	// Step 1: Start MCP server
	console.log('Starting MCP server...')
	const server = spawn('node', [MCP_SERVER_PATH], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, NODE_ENV: 'test' },
	})

	let serverReady = false
	const stderrChunks: string[] = []
	server.stderr?.on('data', (data: Buffer) => {
		const msg = data.toString()
		stderrChunks.push(msg)
		if (msg.includes('WebSocket server listening')) serverReady = true
	})

	// Wait for server to be ready
	const serverStart = performance.now()
	while (!serverReady && performance.now() - serverStart < 5000) {
		await new Promise(r => setTimeout(r, 100))
	}

	if (!serverReady) {
		console.error('Server failed to start. stderr:', stderrChunks.join(''))
		server.kill()
		process.exit(1)
	}
	console.log(`MCP server started in ${Math.round(performance.now() - serverStart)}ms\n`)

	// Step 2: MCP initialization handshake
	console.log('── MCP Protocol Tests ──')

	const pendingResponses = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

	let stdoutBuffer = ''
	server.stdout?.on('data', (data: Buffer) => {
		stdoutBuffer += data.toString()
		const lines = stdoutBuffer.split('\n')
		stdoutBuffer = lines.pop() ?? ''
		for (const line of lines) {
			if (!line.trim()) continue
			const parsed = parseMcpResponse(line)
			if (parsed?.id) {
				const pending = pendingResponses.get(parsed.id)
				if (pending) {
					pendingResponses.delete(parsed.id)
					if (parsed.error) pending.reject(new Error(JSON.stringify(parsed.error)))
					else pending.resolve(parsed.result)
				}
			}
		}
	})

	function sendMcp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = ++requestId
			pendingResponses.set(id, { resolve, reject })
			server.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
			setTimeout(() => {
				if (pendingResponses.has(id)) {
					pendingResponses.delete(id)
					reject(new Error(`Timeout waiting for response to ${method}`))
				}
			}, 10000)
		})
	}

	await runTest('MCP initialize handshake', async () => {
		const result = await sendMcp('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'test-client', version: '1.0' },
		}) as { serverInfo?: { name: string } }
		if (!result?.serverInfo?.name) throw new Error('Missing serverInfo')
		if (result.serverInfo.name !== 'agent-lens') throw new Error(`Wrong server name: ${result.serverInfo.name}`)
		return result
	})

	await runTest('MCP initialized notification', async () => {
		server.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
		return 'sent'
	})

	await runTest('List tools', async () => {
		const result = await sendMcp('tools/list', {}) as { tools: { name: string }[] }
		const toolNames = result.tools.map((t: { name: string }) => t.name)
		const expected = [
			'dom_watch_start', 'dom_watch_stop', 'dom_changes_get',
			'screenshot_annotated', 'page_ready_check', 'page_ready_wait',
			'viewport_info', 'extensions_list', 'extension_toggle',
			'extension_info', 'page_regions',
		]
		const missing = expected.filter(t => !toolNames.includes(t))
		if (missing.length) throw new Error(`Missing tools: ${missing.join(', ')}`)
		console.log(`    Found ${toolNames.length} tools: ${toolNames.join(', ')}`)
		return result
	})

	// Step 3: Test tools without extension (should return connection error)
	console.log('\n── Tool Error Handling (no extension connected) ──')

	await runTest('Tool call without extension returns error', async () => {
		const result = await sendMcp('tools/call', {
			name: 'viewport_info',
			arguments: {},
		}) as { content: { text: string }[] }
		const text = result.content?.[0]?.text ?? ''
		if (!text.includes('not connected')) throw new Error(`Expected connection error, got: ${text}`)
		return text
	})

	// Step 4: Connect fake extension via WebSocket
	console.log('\n── WebSocket Communication Tests ──')

	let fakeExtension: WebSocket | null = null
	const extensionMessages: { id: string; action: string; params: Record<string, unknown> }[] = []

	await runTest('Fake extension connects via WebSocket', async () => {
		return new Promise<string>((resolve, reject) => {
			fakeExtension = new WebSocket(`ws://localhost:${WS_PORT}`)
			fakeExtension.on('open', () => resolve('connected'))
			fakeExtension.on('error', (err) => reject(new Error(`WebSocket error: ${err.message}`)))

			fakeExtension.on('message', (data) => {
				try {
					const msg = JSON.parse(data.toString())
					extensionMessages.push(msg)

					// Auto-respond to requests
					if (msg.type === 'request') {
						const response: Record<string, unknown> = { id: msg.id, type: 'response', success: true }

						switch (msg.action) {
							case 'ping':
								response.data = { pong: true, timestamp: Date.now() }
								break
							case 'dom_watch_start':
								response.data = { watching: true }
								break
							case 'dom_watch_stop':
								response.data = { watching: false }
								break
							case 'dom_changes_get':
								response.data = {
									changes: [
										{ type: 'added', selector: 'div.modal', text: 'Confirm?', parent: 'body' },
										{ type: 'attribute', selector: 'button#submit', attribute: 'disabled', oldValue: null, newValue: 'true' },
									],
									count: 2,
									duration_ms: 500,
								}
								break
							case 'page_ready_check':
								response.data = {
									ready: true,
									signals: {
										pending_network_requests: 0,
										active_animations: 0,
										recent_dom_mutations: false,
										loading_skeletons_visible: false,
										document_ready_state: 'complete',
									},
									recommendation: 'ready',
								}
								break
							case 'viewport_info':
								response.data = {
									scroll: { x: 0, y: 450, maxX: 0, maxY: 3200 },
									viewport: { width: 1280, height: 720 },
									visible_percentage: '14-36%',
									interactive_elements: { in_viewport: 8, above_viewport: 3, below_viewport: 12 },
								}
								break
							case 'extensions_list':
								response.data = {
									extensions: [
										{ id: 'abc123', name: 'uBlock Origin', enabled: true, version: '1.55.0' },
										{ id: 'def456', name: 'React DevTools', enabled: false, version: '5.0.0' },
									],
								}
								break
							case 'page_regions':
								response.data = {
									regions: [
										{ role: 'header', selector: 'header', rect: { y: 0, height: 64 }, summary: 'Logo, 5 links' },
										{ role: 'main', selector: 'main', rect: { y: 64, height: 2800 }, summary: 'Product listing' },
									],
								}
								break
							case 'screenshot_annotated':
								response.data = {
									image: 'data:image/png;base64,iVBORw0KGgo=',
									elements: {
										'1': { tag: 'button', text: 'Submit', rect: { x: 450, y: 320, w: 120, h: 40 } },
									},
									viewport: { width: 1280, height: 720, scrollY: 0, pageHeight: 3200 },
								}
								break
							default:
								response.data = { echo: msg.action }
						}

						fakeExtension?.send(JSON.stringify(response))
					}
				} catch (_e) { /* ignore parse errors */ }
			})

			setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000)
		})
	})

	// Give the server a moment to register the connection
	await new Promise(r => setTimeout(r, 200))

	// Step 5: Test all tools through MCP → WebSocket → fake extension
	console.log('\n── End-to-End Tool Tests (via fake extension) ──')

	const toolTests: { name: string; args: Record<string, unknown>; validate: (r: unknown) => void }[] = [
		{
			name: 'dom_watch_start',
			args: { scope: '#main', mutations: ['added', 'removed'] },
			validate: (r) => {
				const data = JSON.parse((r as { content: { text: string }[] }).content[0].text)
				if (!data.watching) throw new Error('Expected watching: true')
			},
		},
		{
			name: 'dom_watch_stop',
			args: {},
			validate: (r) => {
				const data = JSON.parse((r as { content: { text: string }[] }).content[0].text)
				if (data.watching !== false) throw new Error('Expected watching: false')
			},
		},
		{
			name: 'dom_changes_get',
			args: { clear: true },
			validate: (r) => {
				const data = JSON.parse((r as { content: { text: string }[] }).content[0].text)
				if (data.count !== 2) throw new Error(`Expected 2 changes, got ${data.count}`)
				if (data.changes[0].type !== 'added') throw new Error('Expected first change type: added')
			},
		},
		{
			name: 'page_ready_check',
			args: {},
			validate: (r) => {
				const data = JSON.parse((r as { content: { text: string }[] }).content[0].text)
				if (data.ready !== true) throw new Error('Expected ready: true')
				if (data.recommendation !== 'ready') throw new Error('Expected recommendation: ready')
			},
		},
		{
			name: 'viewport_info',
			args: {},
			validate: (r) => {
				const data = JSON.parse((r as { content: { text: string }[] }).content[0].text)
				if (data.viewport.width !== 1280) throw new Error('Expected viewport width 1280')
				if (data.interactive_elements.in_viewport !== 8) throw new Error('Expected 8 in-viewport elements')
			},
		},
		{
			name: 'extensions_list',
			args: {},
			validate: (r) => {
				const data = JSON.parse((r as { content: { text: string }[] }).content[0].text)
				if (data.extensions.length !== 2) throw new Error('Expected 2 extensions')
			},
		},
		{
			name: 'page_regions',
			args: {},
			validate: (r) => {
				const data = JSON.parse((r as { content: { text: string }[] }).content[0].text)
				if (data.regions.length !== 2) throw new Error('Expected 2 regions')
				if (data.regions[0].role !== 'header') throw new Error('Expected first region role: header')
			},
		},
		{
			name: 'screenshot_annotated',
			args: {},
			validate: (r) => {
				const data = JSON.parse((r as { content: { text: string }[] }).content[0].text)
				if (!data.image.startsWith('data:image')) throw new Error('Expected base64 image')
				if (!data.elements['1']) throw new Error('Expected element annotations')
			},
		},
	]

	for (const test of toolTests) {
		await runTest(`tools/call ${test.name}`, async () => {
			const result = await sendMcp('tools/call', { name: test.name, arguments: test.args })
			test.validate(result)
			return result
		})
	}

	// Step 6: Benchmark — latency for each tool
	console.log('\n── Latency Benchmarks (10 iterations each) ──')

	const benchmarks: { tool: string; avg: number; min: number; max: number; p95: number }[] = []

	for (const toolName of ['viewport_info', 'page_ready_check', 'dom_changes_get', 'extensions_list', 'page_regions']) {
		const times: number[] = []
		for (let i = 0; i < 10; i++) {
			const start = performance.now()
			await sendMcp('tools/call', { name: toolName, arguments: {} })
			times.push(performance.now() - start)
		}
		times.sort((a, b) => a - b)
		const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length)
		const min = Math.round(times[0]!)
		const max = Math.round(times[times.length - 1]!)
		const p95 = Math.round(times[Math.floor(times.length * 0.95)]!)
		benchmarks.push({ tool: toolName, avg, min, max, p95 })
		console.log(`  ${toolName}: avg=${avg}ms min=${min}ms max=${max}ms p95=${p95}ms`)
	}

	// Step 7: Token size estimation
	console.log('\n── Response Size Analysis ──')

	const sizeTests = [
		{ name: 'viewport_info', args: {} },
		{ name: 'page_ready_check', args: {} },
		{ name: 'dom_changes_get', args: {} },
		{ name: 'extensions_list', args: {} },
		{ name: 'page_regions', args: {} },
	]

	for (const test of sizeTests) {
		const result = await sendMcp('tools/call', { name: test.name, arguments: test.args }) as { content: { text: string }[] }
		const text = result.content?.[0]?.text ?? ''
		const bytes = new TextEncoder().encode(text).length
		// Rough token estimate: ~4 chars per token
		const estTokens = Math.round(text.length / 4)
		console.log(`  ${test.name}: ${bytes} bytes (~${estTokens} tokens)`)
	}

	// Cleanup
	fakeExtension?.close()
	server.kill()

	// Summary
	console.log('\n═══ Test Summary ═══')
	const passed = results.filter(r => r.pass).length
	const failed = results.filter(r => !r.pass).length
	console.log(`  Passed: ${passed}`)
	console.log(`  Failed: ${failed}`)
	console.log(`  Total:  ${results.length}`)

	if (failed > 0) {
		console.log('\n  Failures:')
		for (const r of results.filter(r => !r.pass)) {
			console.log(`    ✗ ${r.name}: ${r.error}`)
		}
	}

	console.log('\n═══ Benchmarks ═══')
	console.log('  Tool                  | Avg   | Min   | Max   | P95')
	console.log('  ─────────────────────-┼───────┼───────┼───────┼──────')
	for (const b of benchmarks) {
		console.log(`  ${b.tool.padEnd(22)} | ${String(b.avg).padStart(3)}ms | ${String(b.min).padStart(3)}ms | ${String(b.max).padStart(3)}ms | ${String(b.p95).padStart(3)}ms`)
	}

	console.log('')
	process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
	console.error('Fatal:', err)
	process.exit(1)
})
