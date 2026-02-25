/**
 * @fileoverview Viewport position and interactive element distribution tracking.
 * Reports scroll position, visible page percentage, and element counts
 * above/in/below the current viewport.
 */
import type { ViewportResult } from '../lib/types'

const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role="button"], [tabindex]'

/**
 * @description Capture current viewport geometry, scroll position, visible page percentage,
 * and distribution of interactive elements relative to the viewport.
 */
export const getViewportInfo = (): ViewportResult => {
	const { scrollX, scrollY, innerWidth, innerHeight } = window
	const { scrollWidth, scrollHeight } = document.documentElement

	const maxX = Math.max(0, scrollWidth - innerWidth)
	const maxY = Math.max(0, scrollHeight - innerHeight)

	const topPercent = scrollHeight > 0 ? Math.round(scrollY / scrollHeight * 100) : 0
	const bottomPercent = scrollHeight > 0 ? Math.round((scrollY + innerHeight) / scrollHeight * 100) : 100

	let inViewport = 0
	let aboveViewport = 0
	let belowViewport = 0

	const elements = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))
	for (let i = 0; i < elements.length; i++) {
		const rect = elements[i]!.getBoundingClientRect()
		if (rect.bottom < 0) {
			aboveViewport++
		} else if (rect.top > innerHeight) {
			belowViewport++
		} else {
			inViewport++
		}
	}

	return {
		scroll: { x: scrollX, y: scrollY, maxX, maxY },
		viewport: { width: innerWidth, height: innerHeight },
		visible_percentage: `${topPercent}-${bottomPercent}%`,
		interactive_elements: {
			in_viewport: inViewport,
			above_viewport: aboveViewport,
			below_viewport: belowViewport,
		},
	}
}
