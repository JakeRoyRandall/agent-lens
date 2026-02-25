/**
 * @fileoverview Messaging helpers for content script ↔ service worker communication.
 * Uses chrome.runtime message passing with typed request/response pairs.
 */
import type { ActionType } from './types'

export type ContentRequest = {
	source: 'agent-lens'
	action: ActionType
	params: Record<string, unknown>
}

export type ContentResponse = {
	success: boolean
	data?: unknown
	error?: string
}

const MESSAGE_TIMEOUT = 30_000

/**
 * @description Send a message from service worker to content script in the given tab.
 * Injects the content script first if it hasn't been injected yet.
 * Times out after 30s to prevent hanging if the content script never responds.
 */
export async function sendToContentScript(
	tabId: number,
	action: ActionType,
	params: Record<string, unknown> = {}
): Promise<ContentResponse> {
	await ensureContentScript(tabId)

	const message: ContentRequest = { source: 'agent-lens', action, params }

	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			resolve({ success: false, error: `Content script timed out after ${MESSAGE_TIMEOUT}ms for action: ${action}` })
		}, MESSAGE_TIMEOUT)

		chrome.tabs.sendMessage(tabId, message, (response: ContentResponse | undefined) => {
			clearTimeout(timer)
			if (chrome.runtime.lastError) {
				const errMsg = chrome.runtime.lastError.message ?? 'Unknown error'
				// Tab was closed or navigated away during the operation
				if (errMsg.includes('Receiving end does not exist') || errMsg.includes('tab was closed')) {
					clearInjectedTab(tabId)
					resolve({ success: false, error: `Tab is no longer available (closed or navigated away). Original error: ${errMsg}` })
					return
				}
				resolve({ success: false, error: errMsg })
				return
			}
			resolve(response ?? { success: false, error: 'No response from content script' })
		})
	})
}

const injectedTabs = new Set<number>()

/**
 * @description Inject the content script into a tab if not already injected.
 * After injection, verifies the script is responsive with a ping. Retries once on failure.
 */
async function ensureContentScript(tabId: number): Promise<void> {
	if (injectedTabs.has(tabId)) {
		// Verify existing injection is still responsive
		const alive = await pingContentScript(tabId)
		if (alive) return
		injectedTabs.delete(tabId)
	}

	await injectAndVerify(tabId)
}

async function injectAndVerify(tabId: number): Promise<void> {
	try {
		await chrome.scripting.executeScript({
			target: { tabId },
			files: ['content.js'],
		})
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		throw new Error(`Failed to inject content script into tab ${tabId}: ${message}`)
	}

	const alive = await pingContentScript(tabId)
	if (!alive) {
		throw new Error(`Content script injected into tab ${tabId} but is not responding`)
	}

	injectedTabs.add(tabId)
}

/**
 * @description Quick ping to check if the content script in a tab is responsive.
 */
function pingContentScript(tabId: number): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), 2000)
		chrome.tabs.sendMessage(tabId, { source: 'agent-lens', action: 'ping', params: {} }, (response) => {
			clearTimeout(timer)
			if (chrome.runtime.lastError || !response) {
				resolve(false)
				return
			}
			resolve(true)
		})
	})
}

/**
 * @description Remove a tab from the injected set (called on tab close/navigation).
 */
export function clearInjectedTab(tabId: number): void {
	injectedTabs.delete(tabId)
}
