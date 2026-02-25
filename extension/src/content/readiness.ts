/**
 * @fileoverview Page readiness detection via composite signal analysis.
 * Checks network activity, animations, DOM mutations, skeleton loaders,
 * and document state to determine if a page is stable for interaction.
 */
import type { ReadinessResult, ReadinessSignals, ReadinessWaitParams } from '../lib/types'

const MUTATION_WINDOW_MS = 300
const SKELETON_SELECTORS = [
	'[class*="skeleton"]',
	'[class*="shimmer"]',
	'[class*="placeholder"]',
	'[class*="loading"]',
	'[aria-busy="true"]',
].join(', ')
const SKELETON_ANIMATION_PATTERNS = /pulse|shimmer|skeleton/i

// Module-level mutation tracking — lightweight observer that flips a flag on DOM changes
let lastMutationTime = 0
let mutationObserver: MutationObserver | null = null

const ensureMutationTracking = () => {
	if (mutationObserver) return
	mutationObserver = new MutationObserver(() => {
		lastMutationTime = Date.now()
	})
	mutationObserver.observe(document.body, {
		childList: true,
		attributes: true,
		characterData: true,
		subtree: true,
	})
}

/**
 * @description Count in-flight network requests using PerformanceObserver resource entries.
 * Entries with responseEnd === 0 are still pending.
 */
const countPendingRequests = (): number => {
	if (document.readyState !== 'complete') return 1
	const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
	return entries.filter(e => e.responseEnd === 0).length
}

/**
 * @description Count running CSS/Web animations longer than 100ms.
 */
const countActiveAnimations = (): number => {
	if (typeof document.getAnimations !== 'function') return 0
	return document.getAnimations().filter(a => {
		if (a.playState !== 'running') return false
		const timing = a.effect?.getComputedTiming()
		if (!timing) return false
		const duration = typeof timing.duration === 'number' ? timing.duration : 0
		return duration > 100
	}).length
}

/**
 * @description Check if any DOM mutations occurred within the tracking window.
 */
const hasRecentMutations = (): boolean => {
	ensureMutationTracking()
	return Date.now() - lastMutationTime < MUTATION_WINDOW_MS
}

/**
 * @description Detect visible skeleton/loading placeholder elements by class, aria-busy,
 * or CSS animation name patterns.
 */
const hasVisibleSkeletons = (): boolean => {
	const candidates = Array.from(document.querySelectorAll(SKELETON_SELECTORS))
	for (let i = 0; i < candidates.length; i++) {
		const el = candidates[i]
		if (!(el instanceof HTMLElement)) continue
		if (el.offsetParent === null) continue
		if (getComputedStyle(el).display === 'none') continue
		return true
	}

	// Check for elements with skeleton-like animation names
	const animated = document.getAnimations?.() ?? []
	for (let i = 0; i < animated.length; i++) {
		const anim = animated[i]!
		if (anim.playState !== 'running') continue
		const name = (anim as CSSAnimation).animationName ?? ''
		if (!SKELETON_ANIMATION_PATTERNS.test(name)) continue
		const target = (anim.effect as KeyframeEffect)?.target
		if (!(target instanceof HTMLElement)) continue
		if (target.offsetParent === null) continue
		return true
	}

	return false
}

/**
 * @description Check all readiness signals synchronously and return a composite result.
 * A page is considered ready when all signals are clear.
 */
export const checkReadiness = (): ReadinessResult => {
	const signals: ReadinessSignals = {
		pending_network_requests: countPendingRequests(),
		active_animations: countActiveAnimations(),
		recent_dom_mutations: hasRecentMutations(),
		loading_skeletons_visible: hasVisibleSkeletons(),
		document_ready_state: document.readyState,
	}

	const ready =
		signals.pending_network_requests === 0 &&
		signals.active_animations === 0 &&
		!signals.recent_dom_mutations &&
		!signals.loading_skeletons_visible &&
		signals.document_ready_state === 'complete'

	return { ready, signals, recommendation: ready ? 'ready' : 'wait' }
}

/**
 * @description Poll checkReadiness every 200ms until the page is fully ready
 * or the timeout (default 10000ms) elapses.
 */
export const waitForReady = (params: ReadinessWaitParams = {}): Promise<ReadinessResult> => {
	const timeout = params.timeout ?? 10000
	const interval = 200

	return new Promise(resolve => {
		const start = Date.now()

		const poll = () => {
			const result = checkReadiness()
			if (result.ready || Date.now() - start >= timeout) {
				resolve(result)
				return
			}
			setTimeout(poll, interval)
		}

		poll()
	})
}
