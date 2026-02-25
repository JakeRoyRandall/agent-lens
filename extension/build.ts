/**
 * @fileoverview Build script for Agent Lens Chrome extension.
 * Bundles service worker, content script, and popup into dist/.
 */
import { build, context } from 'esbuild'
import { cpSync, mkdirSync } from 'fs'

const isWatch = process.argv.includes('--watch')

const commonOptions = {
	bundle: true,
	format: 'esm' as const,
	target: 'chrome120',
	sourcemap: true,
	minify: !isWatch,
}

const entryPoints = [
	{ in: 'src/service-worker.ts', out: 'service-worker' },
	{ in: 'src/content/index.ts', out: 'content' },
	{ in: 'src/popup/popup.ts', out: 'popup/popup' },
]

async function run() {
	mkdirSync('dist/popup', { recursive: true })
	mkdirSync('dist/icons', { recursive: true })

	// Copy static files
	cpSync('manifest.json', 'dist/manifest.json')
	cpSync('src/popup/popup.html', 'dist/popup/popup.html')
	cpSync('icons', 'dist/icons', { recursive: true })

	const buildOptions = {
		...commonOptions,
		entryPoints: entryPoints.map(e => ({ in: e.in, out: e.out })),
		outdir: 'dist',
	}

	if (isWatch) {
		const ctx = await context(buildOptions)
		await ctx.watch()
		console.log('[agent-lens] watching for changes...')
	} else {
		await build(buildOptions)
		console.log('[agent-lens] extension built → dist/')
	}
}

run().catch(err => {
	console.error(err)
	process.exit(1)
})
