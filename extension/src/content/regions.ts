/**
 * @fileoverview Segments the visible page into semantic regions (landmarks, HTML5 elements,
 * class-based fallbacks) and generates a concise summary of each region's contents.
 */
import type { PageRegion, PageRegionsResult } from '../lib/types'

const LANDMARK_SELECTOR = [
	'[role="banner"]',
	'[role="navigation"]',
	'[role="main"]',
	'[role="complementary"]',
	'[role="contentinfo"]',
	'[role="search"]',
	'[role="form"]',
	'[role="region"][aria-label]',
].join(',')

const SEMANTIC_SELECTOR = 'header,nav,main,aside,footer,section[aria-label],article'

const CLASS_SELECTOR = [
	'[class*="header"]',
	'[class*="nav"]',
	'[class*="sidebar"]',
	'[class*="footer"]',
	'[class*="content"]',
	'[class*="main"]',
].join(',')

const ROLE_MAP: Record<string, string> = {
	banner: 'header',
	navigation: 'navigation',
	main: 'main',
	complementary: 'sidebar',
	contentinfo: 'footer',
	search: 'search',
	form: 'form',
	region: 'section',
}

const TAG_ROLE_MAP: Record<string, string> = {
	header: 'header',
	nav: 'navigation',
	main: 'main',
	aside: 'sidebar',
	footer: 'footer',
	article: 'article',
	section: 'section',
	form: 'form',
}

const CLASS_ROLE_MAP: [RegExp, string][] = [
	[/header/i, 'header'],
	[/nav/i, 'navigation'],
	[/sidebar/i, 'sidebar'],
	[/footer/i, 'footer'],
	[/main|content/i, 'main'],
]

/**
 * @description Generate a concise CSS selector for an element.
 */
const selectorFor = (el: Element): string => {
	if (el.id) return `#${el.id}`
	const tag = el.tagName.toLowerCase()
	const role = el.getAttribute('role')
	if (role) return `${tag}[role="${role}"]`
	const label = el.getAttribute('aria-label')
	if (label) return `${tag}[aria-label="${label}"]`
	const classes = Array.from(el.classList).slice(0, 2).join('.')
	if (classes) {
		const sel = `${tag}.${classes}`
		if (document.querySelectorAll(sel).length === 1) return sel
	}
	const parent = el.parentElement
	if (!parent) return tag
	const idx = Array.from(parent.children).indexOf(el) + 1
	return `${parent.id ? `#${parent.id}` : parent.tagName.toLowerCase()} > ${tag}:nth-child(${idx})`
}

/**
 * @description Determine the semantic role for an element based on ARIA role, tag name, or class.
 */
const resolveRole = (el: Element): string => {
	const ariaRole = el.getAttribute('role')
	if (ariaRole && ROLE_MAP[ariaRole]) return ROLE_MAP[ariaRole]
	if (ariaRole === 'region') return el.getAttribute('aria-label') ?? 'section'

	const tag = el.tagName.toLowerCase()
	if (TAG_ROLE_MAP[tag]) {
		if (tag === 'section') return el.getAttribute('aria-label') ?? 'section'
		return TAG_ROLE_MAP[tag]
	}

	const cls = el.className ?? ''
	for (const [pattern, role] of CLASS_ROLE_MAP) {
		if (pattern.test(cls)) return role
	}
	return tag
}

const isVisible = (el: Element): boolean => {
	const html = el as HTMLElement
	if (html.offsetParent === null) {
		// offsetParent is null for fixed/sticky, body, html, and hidden elements
		const tag = html.tagName
		if (tag !== 'BODY' && tag !== 'HTML') {
			const style = getComputedStyle(html)
			if (style.display === 'none') return false
			if (style.position !== 'fixed' && style.position !== 'sticky') return false
		}
	}
	const rect = el.getBoundingClientRect()
	return rect.height >= 10
}

/**
 * @description Check if element a contains element b.
 */
const isChildOf = (a: Element, b: Element): boolean => b !== a && b.contains(a)

/**
 * @description Build a concise summary string describing a region's contents.
 */
const summarize = (el: Element): string => {
	const parts: string[] = []

	const headings = el.querySelectorAll('h1,h2,h3,h4,h5,h6')
	if (headings.length > 0) {
		const text = (headings[0].textContent ?? '').trim()
		if (text) parts.push(text.length > 60 ? text.slice(0, 57) + '...' : text)
	}

	const links = el.querySelectorAll('a')
	if (links.length > 2) parts.push(`${links.length} links`)

	const buttons = el.querySelectorAll('button,[role="button"]')
	if (buttons.length > 0) parts.push(`${buttons.length} button${buttons.length > 1 ? 's' : ''}`)

	const inputs = el.querySelectorAll('input,textarea,select')
	if (inputs.length > 0) parts.push(`${inputs.length} input${inputs.length > 1 ? 's' : ''}`)

	const images = el.querySelectorAll('img,picture,svg[role="img"]')
	if (images.length > 2) parts.push(`${images.length} images`)

	const listItems = el.querySelectorAll('li')
	if (listItems.length > 3) parts.push(`${listItems.length} list items`)

	const forms = el.querySelectorAll('form')
	if (forms.length > 0) parts.push(`${forms.length} form${forms.length > 1 ? 's' : ''}`)

	const summary = parts.join(', ')
	return summary.length > 120 ? summary.slice(0, 117) + '...' : summary
}

/**
 * @description Segments the page into semantic regions and returns a summary of each.
 * Uses ARIA landmarks, HTML5 semantic elements, and class-based fallbacks in priority order.
 */
export const getPageRegions = (): PageRegionsResult => {
	const seen = new Set<Element>()
	const collected: Element[] = []

	// Priority 1: ARIA landmarks
	for (const el of document.querySelectorAll(LANDMARK_SELECTOR)) {
		if (!isVisible(el)) continue
		seen.add(el)
		collected.push(el)
	}

	// Priority 2: HTML5 semantic elements (skip if same node already captured)
	for (const el of document.querySelectorAll(SEMANTIC_SELECTOR)) {
		if (seen.has(el) || !isVisible(el)) continue
		seen.add(el)
		collected.push(el)
	}

	// Priority 3: Class-based fallbacks only if fewer than 3 found so far
	if (collected.length < 3) {
		for (const el of document.querySelectorAll(CLASS_SELECTOR)) {
			if (seen.has(el) || !isVisible(el)) continue
			seen.add(el)
			collected.push(el)
		}
	}

	// Deduplicate: remove elements that are children of other collected elements
	const outermost = collected.filter(
		(el) => !collected.some((other) => isChildOf(el, other))
	)

	const regions: PageRegion[] = outermost.map((el) => {
		const rect = el.getBoundingClientRect()
		return {
			role: resolveRole(el),
			selector: selectorFor(el),
			rect: {
				y: Math.round(rect.top + window.scrollY),
				height: Math.round(rect.height),
			},
			summary: summarize(el),
		}
	})

	// Sort by vertical position
	regions.sort((a, b) => a.rect.y - b.rect.y)

	return { regions }
}
