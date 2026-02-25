/**
 * @fileoverview DOM MutationObserver that tracks changes and buffers them as structured data.
 * Supports scoped observation, mutation type filtering, and capped buffer management.
 */
import type { DomMutation, DomChangesResult, DomWatchParams, MutationType } from '../lib/types'

const MAX_BUFFER = 1000
const MAX_TEXT = 200

let observer: MutationObserver | null = null
let buffer: DomMutation[] = []
let watchStartTime = 0
let allowedTypes: Set<MutationType> | null = null

/**
 * @description Generate a concise, unique CSS selector for an element.
 * Prefers #id, then tag.class, then tag:nth-child(n) under parent.
 */
const generateSelector = (el: Element): string => {
	if (el.id) return `#${el.id}`

	const tag = el.tagName.toLowerCase()
	const classes = Array.from(el.classList).slice(0, 2).join('.')
	if (classes) {
		const sel = `${tag}.${classes}`
		if (document.querySelectorAll(sel).length === 1) return sel
	}

	const parent = el.parentElement
	if (!parent) return tag

	const siblings = Array.from(parent.children)
	const idx = siblings.indexOf(el) + 1
	const parentSel = parent.id ? `#${parent.id}` : parent.tagName.toLowerCase()
	return `${parentSel} > ${tag}:nth-child(${idx})`
}

const truncate = (s: string | null | undefined, max = MAX_TEXT): string | undefined => {
	if (!s) return undefined
	const trimmed = s.trim()
	if (!trimmed) return undefined
	return trimmed.length > max ? trimmed.slice(0, max) + '...' : trimmed
}

const pushMutation = (entry: DomMutation) => {
	if (buffer.length >= MAX_BUFFER) buffer.shift()
	buffer.push(entry)
}

const handleMutations = (mutations: MutationRecord[]) => {
	for (const m of mutations) {
		if (m.type === 'childList') {
			for (const node of m.addedNodes) {
				if (!(node instanceof Element)) continue
				if (allowedTypes && !allowedTypes.has('added')) continue
				pushMutation({
					type: 'added',
					selector: generateSelector(node),
					text: truncate(node.textContent),
					parent: m.target instanceof Element ? generateSelector(m.target) : undefined,
				})
			}
			for (const node of m.removedNodes) {
				if (!(node instanceof Element)) continue
				if (allowedTypes && !allowedTypes.has('removed')) continue
				pushMutation({
					type: 'removed',
					selector: generateSelector(node),
					text: truncate(node.textContent),
					parent: m.target instanceof Element ? generateSelector(m.target) : undefined,
				})
			}
		}

		if (m.type === 'attributes' && m.target instanceof Element) {
			if (allowedTypes && !allowedTypes.has('attribute')) continue
			pushMutation({
				type: 'attribute',
				selector: generateSelector(m.target),
				attribute: m.attributeName ?? undefined,
				oldValue: m.oldValue ?? null,
				newValue: m.target.getAttribute(m.attributeName ?? '') ?? null,
			})
		}

		if (m.type === 'characterData') {
			if (allowedTypes && !allowedTypes.has('text')) continue
			const parent = m.target.parentElement
			pushMutation({
				type: 'text',
				selector: parent ? generateSelector(parent) : 'text()',
				oldValue: truncate(m.oldValue),
				newValue: truncate(m.target.textContent),
			})
		}
	}
}

/**
 * @description Create and start a MutationObserver on document.body or a scoped element.
 * Configures observation for childList, attributes, and characterData changes.
 */
export const startWatch = (params: DomWatchParams = {}): void => {
	stopWatch()

	const target = params.scope
		? document.querySelector(params.scope) ?? document.body
		: document.body

	allowedTypes = params.mutations?.length ? new Set(params.mutations) : null
	watchStartTime = Date.now()
	buffer = []

	observer = new MutationObserver(handleMutations)
	observer.observe(target, {
		childList: true,
		attributes: true,
		characterData: true,
		subtree: true,
		attributeOldValue: true,
		characterDataOldValue: true,
	})
}

/**
 * @description Disconnect the observer and clear all internal state.
 */
export const stopWatch = (): void => {
	observer?.disconnect()
	observer = null
	buffer = []
	allowedTypes = null
	watchStartTime = 0
}

/**
 * @description Return all buffered mutations with count and duration since watch started.
 * If clear is true (default), resets the buffer and timer.
 */
export const getChanges = (clear = true): DomChangesResult => {
	const result: DomChangesResult = {
		changes: [...buffer],
		count: buffer.length,
		duration_ms: watchStartTime ? Date.now() - watchStartTime : 0,
	}

	if (clear) {
		buffer = []
		watchStartTime = Date.now()
	}

	return result
}
