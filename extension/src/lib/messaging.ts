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

/**
 * @description Send a message from service worker to content script in the given tab.
 * Injects the content script first if it hasn't been injected yet.
 */
export async function sendToContentScript(
	tabId: number,
	action: ActionType,
	params: Record<string, unknown> = {}
): Promise<ContentResponse> {
	await ensureContentScript(tabId)

	const message: ContentRequest = { source: 'agent-lens', action, params }

	return new Promise((resolve) => {
		chrome.tabs.sendMessage(tabId, message, (response: ContentResponse | undefined) => {
			if (chrome.runtime.lastError) {
				resolve({ success: false, error: chrome.runtime.lastError.message })
				return
			}
			resolve(response ?? { success: false, error: 'No response from content script' })
		})
	})
}

const injectedTabs = new Set<number>()

/**
 * @description Inject the content script into a tab if not already injected.
 */
async function ensureContentScript(tabId: number): Promise<void> {
	if (injectedTabs.has(tabId)) return

	try {
		await chrome.scripting.executeScript({
			target: { tabId },
			files: ['content.js'],
		})
		injectedTabs.add(tabId)
	} catch (_err) {
		// May already be injected or tab may not be injectable (chrome:// pages)
	}
}

/**
 * @description Remove a tab from the injected set (called on tab close/navigation).
 */
export function clearInjectedTab(tabId: number): void {
	injectedTabs.delete(tabId)
}
