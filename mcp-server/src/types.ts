/**
 * @fileoverview Zod schemas for Agent Lens MCP tool parameters.
 */
import { z } from 'zod'

export const DomWatchStartSchema = {
	scope: z.string().optional().describe('CSS selector to limit observation scope (default: entire document)'),
	mutations: z.array(z.enum(['added', 'removed', 'attribute', 'text'])).optional().describe('Mutation types to watch for (default: all)'),
}

export const DomWatchStopSchema = {}

export const DomChangesGetSchema = {
	clear: z.boolean().optional().describe('Clear the buffer after reading (default: true)'),
}

export const ScreenshotAnnotatedSchema = {
	scope: z.string().optional().describe('CSS selector to limit annotation scope'),
	elementTypes: z.array(z.string()).optional().describe('Element types to annotate: button, link, input, select, textarea (default: all interactive)'),
	includeImage: z.boolean().optional().describe('Include the annotated screenshot image in the response (default: true). Set to false to only return the element legend, saving ~90K tokens.'),
}

export const PageReadyCheckSchema = {}

export const PageReadyWaitSchema = {
	timeout: z.number().optional().describe('Maximum wait time in milliseconds (default: 10000)'),
}

export const ViewportInfoSchema = {}

export const ExtensionsListSchema = {}

export const ExtensionToggleSchema = {
	id: z.string().optional().describe('Extension ID to toggle'),
	name: z.string().optional().describe('Extension name to search for (partial match, case-insensitive)'),
	enabled: z.boolean().describe('Whether to enable (true) or disable (false) the extension'),
}

export const ExtensionInfoSchema = {
	id: z.string().describe('Extension ID to get info for'),
}

export const PageRegionsSchema = {}
