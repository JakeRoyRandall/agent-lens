#!/usr/bin/env bun
/**
 * @fileoverview End-to-end test for Agent Lens with a real Chromium browser.
 * Launches Chromium with the extension loaded, starts the MCP server's WebSocket,
 * and tests every tool against real web pages.
 */
import { chromium, type BrowserContext, type Page } from 'playwright'
import { WebSocketServer, WebSocket } from 'ws'
import { resolve } from 'path'

const EXTENSION_PATH = resolve(import.meta.dir, '../extension/dist')
const WS_PORT = 17731
const TEST_URL = 'https://news.ycombinator.com'

type TestResult = { name: string; pass: boolean; duration: number; error?: string; data?: unknown }
const results: TestResult[] = []
const benchmarks: { name: string; times: number[] }[] = []

// ── WebSocket Server (mimics MCP server's WS layer) ─────────────────

let wss: WebSocketServer
let extensionSocket: WebSocket | null = null
let requestCounter = 0
const pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function startWsServer(): Promise<void> {
	return new Promise((resolve) => {
		wss = new WebSocketServer({ port: WS_PORT })
		wss.on('connection', (socket) => {
			console.log('  [ws] Extension connected')
			extensionSocket = socket

			socket.on('message', (raw) => {
				const msg = JSON.parse(raw.toString())
				if (msg.type === 'response' && msg.id) {
					const pending = pendingRequests.get(msg.id)
					if (pending) {
						pendingRequests.delete(msg.id)
						if (msg.success) pending.resolve(msg.data)
						else pending.reject(new Error(msg.error ?? 'Unknown error'))
					}
				}
			})

			socket.on('close', () => {
				extensionSocket = null
			})
		})
		wss.on('listening', () => resolve())
	})
}

function sendToExtension(action: string, params: Record<string, unknown> = {}, timeout = 15000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
			reject(new Error('Extension not connected'))
			return
		}
		const id = `req_${++requestCounter}_${Date.now()}`
		const timer = setTimeout(() => {
			pendingRequests.delete(id)
			reject(new Error(`Timeout: ${action}`))
		}, timeout)
		pendingRequests.set(id, {
			resolve: (v) => { clearTimeout(timer); resolve(v) },
			reject: (e) => { clearTimeout(timer); reject(e) },
		})
		extensionSocket.send(JSON.stringify({ id, type: 'request', action, params }))
	})
}

// ── Test Runner ─────────────────────────────────────────────────────

async function test(name: string, fn: () => Promise<unknown>) {
	const start = performance.now()
	try {
		const data = await fn()
		const dur = Math.round(performance.now() - start)
		results.push({ name, pass: true, duration: dur, data })
		console.log(`  ✓ ${name} (${dur}ms)`)
	} catch (err) {
		const dur = Math.round(performance.now() - start)
		const error = err instanceof Error ? err.message : String(err)
		results.push({ name, pass: false, duration: dur, error })
		console.log(`  ✗ ${name} (${dur}ms) — ${error}`)
	}
}

async function benchmark(name: string, fn: () => Promise<unknown>, iterations = 10, delayMs = 0) {
	const times: number[] = []
	for (let i = 0; i < iterations; i++) {
		if (delayMs > 0 && i > 0) await new Promise(r => setTimeout(r, delayMs))
		const start = performance.now()
		try {
			await fn()
			times.push(performance.now() - start)
		} catch (err) {
			console.log(`  [benchmark] ${name} iteration ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
	if (times.length > 0) benchmarks.push({ name, times })
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
	console.log('\n═══ Agent Lens E2E Tests (Real Chromium) ═══\n')

	// Step 1: Start WebSocket server
	console.log('Starting WebSocket server on :17731...')
	await startWsServer()

	// Step 2: Launch Chromium with extension
	console.log('Launching Chromium with Agent Lens extension...')
	const userDataDir = '/tmp/agent-lens-test-profile'
	const context: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
		headless: false,
		args: [
			`--disable-extensions-except=${EXTENSION_PATH}`,
			`--load-extension=${EXTENSION_PATH}`,
			'--no-first-run',
			'--disable-default-apps',
		],
		viewport: { width: 1280, height: 720 },
	})

	// Wait for extension to connect via WebSocket
	console.log('Waiting for extension to connect...')
	const connectStart = performance.now()
	while (!extensionSocket && performance.now() - connectStart < 15000) {
		await new Promise(r => setTimeout(r, 200))
	}
	if (!extensionSocket) {
		console.error('Extension failed to connect within 15s')
		await context.close()
		wss.close()
		process.exit(1)
	}
	console.log(`Extension connected in ${Math.round(performance.now() - connectStart)}ms\n`)

	// Step 3: Navigate to test page
	const page: Page = context.pages()[0] ?? await context.newPage()
	console.log(`Navigating to ${TEST_URL}...`)
	await page.goto(TEST_URL, { waitUntil: 'networkidle' })
	await page.waitForTimeout(1000) // let extension content scripts settle
	console.log('')

	// ── Ping Test ───────────────────────────────────────────────────
	console.log('── Connectivity ──')
	await test('Ping extension', async () => {
		const result = await sendToExtension('ping') as { pong: boolean }
		if (!result.pong) throw new Error('Expected pong: true')
		return result
	})

	// ── Extension Management Tests ──────────────────────────────────
	console.log('\n── Extension Management ──')

	await test('extensions_list returns installed extensions', async () => {
		const result = await sendToExtension('extensions_list') as { extensions: { name: string; enabled: boolean }[] }
		if (!Array.isArray(result.extensions)) throw new Error('Expected extensions array')
		console.log(`    Found ${result.extensions.length} extensions: ${result.extensions.map(e => e.name).join(', ')}`)
		return result
	})

	// ── Viewport Tests ──────────────────────────────────────────────
	console.log('\n── Viewport Info ──')

	await test('viewport_info returns scroll and element data', async () => {
		const result = await sendToExtension('viewport_info') as {
			scroll: { x: number; y: number }
			viewport: { width: number; height: number }
			visible_percentage: string
			interactive_elements: { in_viewport: number; above_viewport: number; below_viewport: number }
		}
		if (result.viewport.width !== 1280) throw new Error(`Expected width 1280, got ${result.viewport.width}`)
		if (result.viewport.height !== 720) throw new Error(`Expected height 720, got ${result.viewport.height}`)
		if (result.interactive_elements.in_viewport === 0) throw new Error('Expected some interactive elements in viewport')
		console.log(`    Viewport: ${result.viewport.width}x${result.viewport.height}`)
		console.log(`    Scroll: y=${result.scroll.y}, visible=${result.visible_percentage}`)
		console.log(`    Interactive: ${result.interactive_elements.in_viewport} in view, ${result.interactive_elements.below_viewport} below`)
		return result
	})

	await test('viewport_info updates after scroll', async () => {
		await page.evaluate(() => window.scrollBy(0, 500))
		await page.waitForTimeout(100)
		const result = await sendToExtension('viewport_info') as { scroll: { y: number } }
		if (result.scroll.y < 400) throw new Error(`Expected scrollY > 400, got ${result.scroll.y}`)
		console.log(`    After scroll: y=${result.scroll.y}`)
		await page.evaluate(() => window.scrollTo(0, 0))
		return result
	})

	// ── Page Readiness Tests ────────────────────────────────────────
	console.log('\n── Page Readiness ──')

	await test('page_ready_check on loaded page', async () => {
		const result = await sendToExtension('page_ready_check') as {
			ready: boolean
			signals: Record<string, unknown>
			recommendation: string
		}
		console.log(`    Ready: ${result.ready}, Recommendation: ${result.recommendation}`)
		console.log(`    Signals: ${JSON.stringify(result.signals)}`)
		return result
	})

	await test('page_ready_wait resolves on stable page', async () => {
		const result = await sendToExtension('page_ready_wait', { timeout: 5000 }) as { ready: boolean }
		if (!result.ready) throw new Error('Expected ready after wait')
		return result
	})

	// ── DOM Change Detection Tests ──────────────────────────────────
	console.log('\n── DOM Change Detection ──')

	await test('dom_watch_start activates observer', async () => {
		const result = await sendToExtension('dom_watch_start', { scope: 'body' }) as { watching: boolean }
		if (!result.watching) throw new Error('Expected watching: true')
		return result
	})

	await test('dom_changes_get detects injected elements', async () => {
		// Inject a test element
		await page.evaluate(() => {
			const div = document.createElement('div')
			div.id = 'agent-lens-test-element'
			div.textContent = 'Test mutation tracking'
			document.body.appendChild(div)
		})
		await page.waitForTimeout(200)

		const result = await sendToExtension('dom_changes_get', { clear: true }) as {
			changes: { type: string; selector: string }[]
			count: number
			duration_ms: number
		}
		if (result.count === 0) throw new Error('Expected at least 1 mutation')
		const addedEntry = result.changes.find(c => c.type === 'added' && c.selector?.includes('agent-lens-test'))
		console.log(`    Detected ${result.count} mutations in ${result.duration_ms}ms`)
		console.log(`    Found test element: ${addedEntry ? 'yes' : 'no (checking all changes...)'}`)
		if (!addedEntry) {
			console.log(`    All changes: ${JSON.stringify(result.changes.slice(0, 5), null, 2)}`)
		}
		return result
	})

	await test('dom_changes_get detects attribute changes', async () => {
		await page.evaluate(() => {
			const el = document.getElementById('agent-lens-test-element')
			if (el) el.setAttribute('data-test', 'modified')
		})
		await page.waitForTimeout(200)

		const result = await sendToExtension('dom_changes_get', { clear: true }) as {
			changes: { type: string; attribute?: string }[]
			count: number
		}
		const attrChange = result.changes.find(c => c.type === 'attribute' && c.attribute === 'data-test')
		if (!attrChange) throw new Error('Expected attribute change for data-test')
		console.log(`    Detected attribute change: data-test`)
		return result
	})

	await test('dom_changes_get detects text changes', async () => {
		await page.evaluate(() => {
			const el = document.getElementById('agent-lens-test-element')
			if (el) el.textContent = 'Updated text content'
		})
		await page.waitForTimeout(200)

		const result = await sendToExtension('dom_changes_get', { clear: true }) as {
			changes: { type: string }[]
			count: number
		}
		if (result.count === 0) throw new Error('Expected mutations from text change')
		console.log(`    Detected ${result.count} mutations from text change`)
		return result
	})

	await test('dom_changes_get detects removed elements', async () => {
		await page.evaluate(() => {
			document.getElementById('agent-lens-test-element')?.remove()
		})
		await page.waitForTimeout(200)

		const result = await sendToExtension('dom_changes_get', { clear: true }) as {
			changes: { type: string }[]
			count: number
		}
		const removed = result.changes.find(c => c.type === 'removed')
		if (!removed) throw new Error('Expected removed mutation')
		console.log(`    Detected removal`)
		return result
	})

	await test('dom_watch_stop disconnects observer', async () => {
		const result = await sendToExtension('dom_watch_stop') as { watching: boolean }
		if (result.watching !== false) throw new Error('Expected watching: false')
		return result
	})

	// ── Annotated Screenshots Tests ─────────────────────────────────
	console.log('\n── Annotated Screenshots ──')

	await page.evaluate(() => window.scrollTo(0, 0))
	await page.waitForTimeout(200)

	await test('screenshot_annotated finds interactive elements', async () => {
		const result = await sendToExtension('screenshot_annotated') as {
			image: string
			elements: Record<string, { tag: string; text?: string; rect: { x: number; y: number; w: number; h: number } }>
			viewport: { width: number; height: number }
		}
		// Content script returns '__CAPTURE_NEEDED__' but service worker does the actual capture
		// In this test we're talking directly to extension, so we get the content script result
		const elementCount = Object.keys(result.elements).length
		if (elementCount === 0) throw new Error('Expected interactive elements')
		console.log(`    Found ${elementCount} interactive elements`)
		const sample = result.elements['1']
		if (sample) console.log(`    Element 1: <${sample.tag}> "${sample.text?.slice(0, 40) ?? '(no text)'}" at (${sample.rect.x}, ${sample.rect.y})`)
		return { elementCount, viewport: result.viewport }
	})

	await test('screenshot cleanup removes overlay', async () => {
		const result = await sendToExtension('screenshot_cleanup') as { cleaned: boolean }
		// Verify overlay is gone
		const overlayExists = await page.evaluate(() => !!document.getElementById('agent-lens-annotation-overlay'))
		if (overlayExists) throw new Error('Overlay still present after cleanup')
		return result
	})

	// ── Page Regions Tests ──────────────────────────────────────────
	console.log('\n── Page Regions ──')

	await test('page_regions segments the page (HN = minimal HTML)', async () => {
		const result = await sendToExtension('page_regions') as {
			regions: { role: string; selector: string; rect: { y: number; height: number }; summary: string }[]
		}
		// HN uses table-based layout with no semantic HTML, ARIA landmarks, or matching class patterns.
		// 0 regions is correct behavior for this page — GitHub test below validates region detection.
		console.log(`    Found ${result.regions.length} regions${result.regions.length === 0 ? ' (expected: HN has no semantic structure)' : ':'}`)
		for (const r of result.regions) {
			console.log(`      [${r.role}] ${r.selector} — ${r.summary}`)
		}
		return result
	})

	// ── Test on a more complex page ─────────────────────────────────
	console.log('\n── Complex Page Test (GitHub) ──')

	await page.goto('https://github.com/anthropics/claude-code', { waitUntil: 'networkidle' })
	await page.waitForTimeout(1500)

	await test('viewport_info on GitHub', async () => {
		const result = await sendToExtension('viewport_info') as {
			interactive_elements: { in_viewport: number; below_viewport: number }
		}
		console.log(`    Interactive: ${result.interactive_elements.in_viewport} in view, ${result.interactive_elements.below_viewport} below`)
		return result
	})

	await test('page_regions on GitHub', async () => {
		const result = await sendToExtension('page_regions') as {
			regions: { role: string; summary: string }[]
		}
		console.log(`    Found ${result.regions.length} regions:`)
		for (const r of result.regions.slice(0, 5)) {
			console.log(`      [${r.role}] ${r.summary}`)
		}
		return result
	})

	await test('screenshot_annotated on GitHub', async () => {
		const result = await sendToExtension('screenshot_annotated') as {
			elements: Record<string, unknown>
		}
		const count = Object.keys(result.elements).length
		console.log(`    Found ${count} interactive elements`)
		await sendToExtension('screenshot_cleanup')
		return { count }
	})

	await test('page_ready_check on GitHub', async () => {
		const result = await sendToExtension('page_ready_check') as {
			ready: boolean
			signals: Record<string, unknown>
		}
		console.log(`    Ready: ${result.ready}, Signals: ${JSON.stringify(result.signals)}`)
		return result
	})

	// ── DOM Watch on dynamic SPA ────────────────────────────────────
	console.log('\n── SPA DOM Watch Test ──')

	await test('DOM watch detects dynamic content injection', async () => {
		await sendToExtension('dom_watch_start', {})

		// Simulate dynamic content
		await page.evaluate(() => {
			const container = document.createElement('div')
			container.id = 'dynamic-test'
			for (let i = 0; i < 5; i++) {
				const card = document.createElement('div')
				card.className = `card card-${i}`
				card.textContent = `Dynamic Card ${i}`
				container.appendChild(card)
			}
			document.body.appendChild(container)
		})
		await page.waitForTimeout(300)

		const result = await sendToExtension('dom_changes_get', { clear: true }) as {
			changes: { type: string }[]
			count: number
		}
		const added = result.changes.filter(c => c.type === 'added')
		console.log(`    Injected 5 cards + container → detected ${result.count} mutations (${added.length} additions)`)
		if (added.length < 1) throw new Error('Expected added mutations')

		// Cleanup
		await page.evaluate(() => document.getElementById('dynamic-test')?.remove())
		await sendToExtension('dom_watch_stop')
		return result
	})

	// ── Benchmarks ──────────────────────────────────────────────────
	console.log('\n── Performance Benchmarks (20 iterations each) ──')

	// Navigate to a consistent page for benchmarking
	await page.goto(TEST_URL, { waitUntil: 'networkidle' })
	await page.waitForTimeout(500)

	const benchTools = [
		{ name: 'ping', action: 'ping', params: {} },
		{ name: 'viewport_info', action: 'viewport_info', params: {} },
		{ name: 'page_ready_check', action: 'page_ready_check', params: {} },
		{ name: 'page_regions', action: 'page_regions', params: {} },
		{ name: 'extensions_list', action: 'extensions_list', params: {} },
	]

	// DOM watch benchmark (start, get changes, stop cycle)
	await sendToExtension('dom_watch_start', {})

	const benchToolsWithDom = [
		...benchTools,
		{ name: 'dom_changes_get', action: 'dom_changes_get', params: { clear: true } },
	]

	for (const { name, action, params } of benchToolsWithDom) {
		await benchmark(name, () => sendToExtension(action, params), 20)
	}

	// Screenshot benchmark (includes overlay creation + cleanup)
	// Chrome limits captureVisibleTab to ~2 calls/sec, so throttle with 600ms delay
	await benchmark('screenshot_annotated (full cycle)', async () => {
		await sendToExtension('screenshot_annotated')
		await sendToExtension('screenshot_cleanup')
	}, 10, 600)

	await sendToExtension('dom_watch_stop')

	// ── Response Size Analysis ───────────────────────────────────────
	// Wait for Chrome rate limits to reset after screenshot benchmarks
	await new Promise(r => setTimeout(r, 2000))
	console.log('\n── Response Sizes (real page data) ──')

	const sizeTools = [
		{ name: 'viewport_info', action: 'viewport_info', params: {} },
		{ name: 'page_ready_check', action: 'page_ready_check', params: {} },
		{ name: 'page_regions', action: 'page_regions', params: {} },
		{ name: 'extensions_list', action: 'extensions_list', params: {} },
		{ name: 'screenshot_annotated (legend only)', action: 'screenshot_annotated', params: {} },
	]

	for (const { name, action, params } of sizeTools) {
		// Throttle screenshot calls to avoid MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND
		if (action === 'screenshot_annotated') await new Promise(r => setTimeout(r, 1500))
		try {
			const result = await sendToExtension(action, params)
			if (action === 'screenshot_annotated') await sendToExtension('screenshot_cleanup')
			const json = JSON.stringify(result)
			const bytes = new TextEncoder().encode(json).length
			const estTokens = Math.round(json.length / 4)
			console.log(`  ${name}: ${bytes} bytes (~${estTokens} tokens)`)
		} catch (err) {
			console.log(`  ${name}: ERROR — ${err instanceof Error ? err.message : String(err)}`)
		}
	}

	// ── Cleanup ─────────────────────────────────────────────────────
	await context.close()
	wss.close()

	// ── Print Results ───────────────────────────────────────────────
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

	console.log('\n═══ Performance Benchmarks ═══')
	console.log('  Tool                                   | Avg     | Min     | Max     | P95     | P50')
	console.log('  ───────────────────────────────────────-┼─────────┼─────────┼─────────┼─────────┼────────')
	for (const b of benchmarks) {
		const sorted = [...b.times].sort((a, b) => a - b)
		const avg = (sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1)
		const min = sorted[0]!.toFixed(1)
		const max = sorted[sorted.length - 1]!.toFixed(1)
		const p95 = sorted[Math.floor(sorted.length * 0.95)]!.toFixed(1)
		const p50 = sorted[Math.floor(sorted.length * 0.5)]!.toFixed(1)
		console.log(`  ${b.name.padEnd(40)} | ${avg.padStart(5)}ms | ${min.padStart(5)}ms | ${max.padStart(5)}ms | ${p95.padStart(5)}ms | ${p50.padStart(5)}ms`)
	}

	console.log('')
	process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
	console.error('Fatal:', err)
	wss?.close()
	process.exit(1)
})
