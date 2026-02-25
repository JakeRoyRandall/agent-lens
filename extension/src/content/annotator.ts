/**
 * @fileoverview Annotated screenshot content script for Agent Lens.
 * Finds interactive elements on the page, creates numbered badge overlays,
 * and returns element metadata for the MCP server to pair with a screenshot.
 */
import type { ElementAnnotation, AnnotatedScreenshotResult, ScreenshotParams } from '../lib/types'

const OVERLAY_ID = 'agent-lens-annotation-overlay'
const DEFAULT_SELECTOR = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [tabindex]'
const MAX_TEXT_LENGTH = 100
const BADGE_SIZE = 20

/**
 * @description Check whether an element is visually hidden via CSS or layout.
 */
const isHidden = (el: HTMLElement): boolean => {
	if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return true
	const style = getComputedStyle(el)
	return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0'
}

/**
 * @description Check whether a bounding rect is within the current viewport.
 */
const isInViewport = (rect: DOMRect): boolean =>
	rect.bottom > 0 &&
	rect.top < window.innerHeight &&
	rect.right > 0 &&
	rect.left < window.innerWidth

/**
 * @description Truncate a string to a maximum length, appending ellipsis if needed.
 */
const truncate = (s: string | null | undefined): string | undefined => {
	if (!s) return undefined
	const trimmed = s.trim().replace(/\s+/g, ' ')
	if (!trimmed) return undefined
	return trimmed.length > MAX_TEXT_LENGTH ? trimmed.slice(0, MAX_TEXT_LENGTH) + '...' : trimmed
}

/**
 * @description Build the CSS selector string from params, falling back to default interactive elements.
 */
const buildSelector = (params: ScreenshotParams): string => {
	if (params.elementTypes?.length) {
		return params.elementTypes.join(', ')
	}
	return DEFAULT_SELECTOR
}

/**
 * @description Build an ElementAnnotation from a DOM element and its bounding rect.
 */
const buildAnnotation = (el: HTMLElement, rect: DOMRect): ElementAnnotation => {
	const annotation: ElementAnnotation = {
		tag: el.tagName.toLowerCase(),
		rect: {
			x: Math.round(rect.x),
			y: Math.round(rect.y),
			w: Math.round(rect.width),
			h: Math.round(rect.height),
		},
	}

	const text = truncate(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'))
	if (text) annotation.text = text

	if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
		if ('type' in el) annotation.type = (el as HTMLInputElement).type
		if ('placeholder' in el) {
			const ph = (el as HTMLInputElement).placeholder
			if (ph) annotation.placeholder = ph
		}
	}

	if (el instanceof HTMLAnchorElement && el.href) {
		annotation.href = el.href
	}

	const role = el.getAttribute('role')
	if (role) annotation.role = role

	return annotation
}

/**
 * @description Create a numbered badge element positioned at the given coordinates.
 */
const createBadge = (num: number, x: number, y: number): HTMLDivElement => {
	const badge = document.createElement('div')
	badge.style.cssText = [
		`position:fixed`,
		`left:${x}px`,
		`top:${y}px`,
		`width:${BADGE_SIZE}px`,
		`height:${BADGE_SIZE}px`,
		`border-radius:50%`,
		`background:#ef4444`,
		`color:#fff`,
		`font-size:11px`,
		`font-weight:bold`,
		`font-family:system-ui,sans-serif`,
		`display:flex`,
		`align-items:center`,
		`justify-content:center`,
		`line-height:1`,
		`pointer-events:none`,
		`box-shadow:0 1px 3px rgba(0,0,0,0.3)`,
		`z-index:2147483647`,
	].join(';')
	badge.textContent = String(num)
	return badge
}

/**
 * @description Find all interactive elements, draw numbered badge overlays,
 * and return annotated metadata. The service worker captures the actual screenshot
 * via chrome.tabs.captureVisibleTab() while the overlay is visible.
 *
 * Returns image as '__CAPTURE_NEEDED__' to signal the service worker to capture.
 * Call removeOverlay() after the screenshot is taken.
 */
export const annotateElements = (params: ScreenshotParams = {}): AnnotatedScreenshotResult => {
	// Clean up any previous overlay
	removeOverlay()

	const selector = buildSelector(params)
	const root = params.scope
		? document.querySelector(params.scope) ?? document.body
		: document.body

	const candidates = Array.from(root.querySelectorAll(selector)) as HTMLElement[]

	const elements: Record<string, ElementAnnotation> = {}
	const overlay = document.createElement('div')
	overlay.id = OVERLAY_ID
	overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647'

	let index = 1

	for (const el of candidates) {
		if (isHidden(el)) continue

		const rect = el.getBoundingClientRect()
		if (rect.width === 0 && rect.height === 0) continue
		if (!params.includeOffscreen && !isInViewport(rect)) continue

		const annotation = buildAnnotation(el, rect)
		elements[String(index)] = annotation

		// Position badge at top-left corner of element
		const badgeX = Math.max(0, rect.left)
		const badgeY = Math.max(0, rect.top - BADGE_SIZE / 2)
		overlay.appendChild(createBadge(index, badgeX, badgeY))

		index++
	}

	// Append overlay to DOM so it appears in the screenshot
	document.documentElement.appendChild(overlay)

	return {
		image: '__CAPTURE_NEEDED__',
		elements,
		viewport: {
			width: window.innerWidth,
			height: window.innerHeight,
			scrollY: window.scrollY,
			pageHeight: document.documentElement.scrollHeight,
		},
	}
}

/**
 * @description Remove the annotation badge overlay from the DOM.
 * Should be called after the service worker has captured the screenshot.
 */
export const removeOverlay = (): void => {
	document.getElementById(OVERLAY_ID)?.remove()
}
