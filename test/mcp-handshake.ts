#!/usr/bin/env bun
/**
 * @fileoverview Tests the MCP server's stdio transport by simulating a client handshake.
 * MCP SDK v1.27 uses newline-delimited JSON (not Content-Length framing).
 */
import { spawn } from 'child_process'
import { resolve } from 'path'

const SERVER_PATH = resolve(import.meta.dir, '../mcp-server/dist/index.js')

type JsonRpcResponse = {
	jsonrpc: string
	id?: number
	result?: Record<string, unknown>
	error?: { code: number; message: string }
}

async function main() {
	console.log('\n=== MCP Server Handshake Test ===\n')

	const proc = spawn('/opt/homebrew/bin/node', [SERVER_PATH], {
		stdio: ['pipe', 'pipe', 'pipe'],
	})

	let stderr = ''
	proc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

	const responses: JsonRpcResponse[] = []
	let buffer = ''

	proc.stdout!.on('data', (chunk: Buffer) => {
		buffer += chunk.toString()
		// Parse newline-delimited JSON
		const lines = buffer.split('\n')
		buffer = lines.pop() ?? ''
		for (const line of lines) {
			const trimmed = line.trim()
			if (!trimmed) continue
			try {
				responses.push(JSON.parse(trimmed))
			} catch {}
		}
	})

	// Wait for server to start
	await new Promise(r => setTimeout(r, 500))

	const send = (msg: Record<string, unknown>) => {
		proc.stdin!.write(JSON.stringify(msg) + '\n')
	}

	// Step 1: Initialize
	console.log('Sending initialize...')
	send({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: '2025-11-25',
			capabilities: {},
			clientInfo: { name: 'agent-lens-test', version: '1.0.0' },
		},
	})

	await new Promise(r => setTimeout(r, 500))

	// Step 2: Initialized notification
	send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
	await new Promise(r => setTimeout(r, 300))

	// Step 3: List tools
	console.log('Sending tools/list...')
	send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
	await new Promise(r => setTimeout(r, 500))

	// Step 4: Call connection_status tool
	console.log('Calling connection_status...')
	send({
		jsonrpc: '2.0',
		id: 3,
		method: 'tools/call',
		params: { name: 'connection_status', arguments: {} },
	})
	await new Promise(r => setTimeout(r, 500))

	// Analyze results
	let passed = 0
	let failed = 0

	// Test 1: Initialize response
	const initResp = responses.find(r => r.id === 1)
	if (initResp?.result) {
		const info = (initResp.result as Record<string, unknown>).serverInfo as Record<string, string>
		console.log(`\n  + Initialize: server=${info?.name} v${info?.version}`)
		passed++
	} else {
		console.log(`\n  x Initialize failed: ${JSON.stringify(initResp)}`)
		failed++
	}

	// Test 2: Tools list
	const toolsResp = responses.find(r => r.id === 2)
	if (toolsResp?.result) {
		const tools = (toolsResp.result as { tools: { name: string }[] }).tools
		console.log(`  + tools/list: ${tools.length} tools`)
		for (const t of tools) console.log(`      ${t.name}`)
		if (tools.length >= 11) { passed++ } else { failed++ }
		passed++
	} else {
		console.log(`  x tools/list failed: ${JSON.stringify(toolsResp)}`)
		failed += 2
	}

	// Test 3: connection_status
	const statusResp = responses.find(r => r.id === 3)
	if (statusResp?.result) {
		const content = (statusResp.result as { content: { text: string }[] }).content
		const status = JSON.parse(content?.[0]?.text ?? '{}')
		console.log(`  + connection_status: connected=${status.connected}`)
		passed++
	} else {
		console.log(`  x connection_status failed: ${JSON.stringify(statusResp)}`)
		failed++
	}

	console.log(`\n  stderr: ${stderr.trim().split('\n').map(l => `\n    ${l}`).join('')}`)
	console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`)

	proc.kill()
	process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
	console.error('Fatal:', err)
	process.exit(1)
})
