/**
 * @fileoverview Shared types for Agent Lens extension ↔ MCP server communication.
 * Defines the WebSocket message protocol and all data structures.
 */

// ── WebSocket Protocol ──────────────────────────────────────────────

export type RequestMessage = {
	id: string
	type: 'request'
	action: ActionType
	params: Record<string, unknown>
}

export type ResponseMessage = {
	id: string
	type: 'response'
	success: boolean
	data?: unknown
	error?: string
}

export type ActionType =
	| 'ping'
	| 'dom_watch_start'
	| 'dom_watch_stop'
	| 'dom_changes_get'
	| 'screenshot_annotated'
	| 'page_ready_check'
	| 'page_ready_wait'
	| 'viewport_info'
	| 'extensions_list'
	| 'extension_toggle'
	| 'extension_info'
	| 'page_regions'

// ── DOM Changes ─────────────────────────────────────────────────────

export type MutationType = 'added' | 'removed' | 'attribute' | 'text'

export type DomMutation = {
	type: MutationType
	selector: string
	text?: string
	parent?: string
	attribute?: string
	oldValue?: string | null
	newValue?: string | null
}

export type DomChangesResult = {
	changes: DomMutation[]
	count: number
	duration_ms: number
}

export type DomWatchParams = {
	scope?: string
	mutations?: MutationType[]
}

// ── Annotated Screenshots ───────────────────────────────────────────

export type ElementAnnotation = {
	tag: string
	text?: string
	type?: string
	placeholder?: string
	href?: string
	role?: string
	rect: { x: number; y: number; w: number; h: number }
}

export type AnnotatedScreenshotResult = {
	image: string
	elements: Record<string, ElementAnnotation>
	viewport: { width: number; height: number; scrollY: number; pageHeight: number }
}

export type ScreenshotParams = {
	scope?: string
	elementTypes?: string[]
	includeOffscreen?: boolean
}

// ── Page Readiness ──────────────────────────────────────────────────

export type ReadinessSignals = {
	pending_network_requests: number
	active_animations: number
	recent_dom_mutations: boolean
	loading_skeletons_visible: boolean
	document_ready_state: DocumentReadyState
}

export type ReadinessResult = {
	ready: boolean
	signals: ReadinessSignals
	recommendation: 'ready' | 'wait'
}

export type ReadinessWaitParams = {
	timeout?: number
}

// ── Viewport ────────────────────────────────────────────────────────

export type ViewportResult = {
	scroll: { x: number; y: number; maxX: number; maxY: number }
	viewport: { width: number; height: number }
	visible_percentage: string
	interactive_elements: {
		in_viewport: number
		above_viewport: number
		below_viewport: number
	}
}

// ── Extension Management ────────────────────────────────────────────

export type ExtensionEntry = {
	id: string
	name: string
	enabled: boolean
	version: string
	description?: string
}

export type ExtensionDetailedInfo = ExtensionEntry & {
	permissions: string[]
	hostPermissions: string[]
	optionsUrl?: string
	homepageUrl?: string
	installType: string
	type: string
}

export type ExtensionToggleParams = {
	id?: string
	name?: string
	enabled: boolean
}

// ── Page Regions ────────────────────────────────────────────────────

export type PageRegion = {
	role: string
	selector: string
	rect: { y: number; height: number }
	summary: string
}

export type PageRegionsResult = {
	regions: PageRegion[]
}
