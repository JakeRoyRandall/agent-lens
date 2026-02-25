/**
 * @fileoverview Content script entry point for Agent Lens.
 * Routes messages from the service worker to the appropriate content modules.
 */
import type { ContentRequest, ContentResponse } from '../lib/messaging'
import { startWatch, stopWatch, getChanges } from './observer'
import { annotateElements, removeOverlay } from './annotator'
import { checkReadiness, waitForReady } from './readiness'
import { getViewportInfo } from './viewport'
import { getPageRegions } from './regions'

chrome.runtime.onMessage.addListener(
	(message: ContentRequest, _sender, sendResponse: (response: ContentResponse) => void) => {
		if (message.source !== 'agent-lens') return false

		handleAction(message.action, message.params)
			.then(data => sendResponse({ success: true, data }))
			.catch(err => sendResponse({
				success: false,
				error: err instanceof Error ? err.message : String(err),
			}))

		return true // keep channel open for async response
	}
)

async function handleAction(action: string, params: Record<string, unknown>): Promise<unknown> {
	switch (action) {
		// DOM Changes
		case 'dom_watch_start':
			startWatch(params as { scope?: string; mutations?: string[] })
			return { watching: true }

		case 'dom_watch_stop':
			stopWatch()
			return { watching: false }

		case 'dom_changes_get': {
			const clear = (params.clear as boolean) ?? true
			return getChanges(clear)
		}

		// Annotated Screenshots
		case 'screenshot_annotated': {
			const result = annotateElements(params as { scope?: string; elementTypes?: string[] })
			// Signal service worker to capture screenshot, then remove overlay
			// The service worker will send a follow-up 'screenshot_capture' message
			return result
		}

		case 'screenshot_cleanup':
			removeOverlay()
			return { cleaned: true }

		// Page Readiness
		case 'page_ready_check':
			return checkReadiness()

		case 'page_ready_wait':
			return await waitForReady(params as { timeout?: number })

		// Viewport
		case 'viewport_info':
			return getViewportInfo()

		// Page Regions
		case 'page_regions':
			return getPageRegions()

		default:
			throw new Error(`Unknown action: ${action}`)
	}
}
