/**
 * Utility functions for handling Pluto cell outputs
 * Extracted for testability
 */

import { LogEntry } from './PlutoServer';

/**
 * Check if a string is a Pluto objectid (12-20 character hex string)
 * Pluto uses objectids as placeholders for lazy-loaded data
 */
export function isPlutoObjectId(str: string | undefined | null): boolean {
    if (!str) {return false;}
    const trimmed = str.trim();
    // Objectids are typically 14-16 hex chars, but allow wider range for safety
    return /^[0-9a-f]{12,20}$/i.test(trimmed);
}

/**
 * Cached output data structure
 */
export interface CachedOutput {
    body?: string;
    mime?: string;
    logs?: LogEntry[];
    lastCode?: string;
}

/**
 * Output item structure for building VS Code outputs
 */
export interface OutputItem {
    type: 'stdout' | 'stderr' | 'text' | 'binary' | 'json';
    content: string | Uint8Array;
    mime?: string;
}

/**
 * Build output items from cached output data
 * This is the core logic extracted from PlutoKernel.buildOutputsFromCache
 * Returns an array of OutputItem objects that can be converted to VS Code outputs
 */
export function buildOutputItems(
    cachedOutput: CachedOutput,
    options?: {
        parseError?: (body: string, mime: string) => string;
        addErrorHints?: (body: string) => string;
        renderTreeAsHtml?: (body: string) => string;
    }
): OutputItem[] {
    const items: OutputItem[] = [];

    // Add logs (stdout) if present
    if (cachedOutput.logs && cachedOutput.logs.length > 0) {
        const stdoutLogs = cachedOutput.logs
            .map(logEntry => logEntry.msg)
            .join('');

        if (stdoutLogs) {
            items.push({
                type: 'stdout',
                content: stdoutLogs
            });
        }
    }

    // Add main output if present
    if (cachedOutput.body) {
        const mime = cachedOutput.mime || 'text/plain';

        if (mime === 'application/vnd.pluto.stacktrace+object') {
            const errorText = options?.parseError
                ? options.parseError(cachedOutput.body, mime)
                : cachedOutput.body;
            items.push({
                type: 'stderr',
                content: errorText
            });
        } else if (cachedOutput.body.includes('extra token after end of expression')) {
            const errorText = options?.addErrorHints
                ? options.addErrorHints(cachedOutput.body)
                : cachedOutput.body;
            items.push({
                type: 'stderr',
                content: errorText
            });
        } else if (cachedOutput.body.includes('syntax:')) {
            items.push({
                type: 'stderr',
                content: cachedOutput.body
            });
        } else if (mime === 'application/vnd.pluto.tree+object') {
            const isObjectIdOnly = isPlutoObjectId(cachedOutput.body);
            if (!isObjectIdOnly) {
                const treeHtml = options?.renderTreeAsHtml
                    ? options.renderTreeAsHtml(cachedOutput.body)
                    : cachedOutput.body;
                items.push({
                    type: 'text',
                    content: treeHtml,
                    mime: 'application/vnd.pluto.html+html'
                });
            }
            // If objectid only, don't add output - wait for real data
        } else if (mime === 'text/html') {
            items.push({
                type: 'text',
                content: cachedOutput.body,
                mime: 'application/vnd.pluto.html+html'
            });
        } else if (mime === 'image/svg+xml') {
            items.push({
                type: 'text',
                content: cachedOutput.body,
                mime: 'image/svg+xml'
            });
        } else if (mime === 'image/png' || mime === 'image/jpeg') {
            try {
                const buffer = Buffer.from(cachedOutput.body, 'base64');
                items.push({
                    type: 'binary',
                    content: new Uint8Array(buffer),
                    mime: mime
                });
            } catch {
                items.push({
                    type: 'text',
                    content: cachedOutput.body,
                    mime: 'text/plain'
                });
            }
        } else if (mime.endsWith('+json')) {
            try {
                // Validate JSON, but store as string for the item
                JSON.parse(cachedOutput.body);
                items.push({
                    type: 'json',
                    content: cachedOutput.body,
                    mime: mime
                });
            } catch {
                items.push({
                    type: 'text',
                    content: cachedOutput.body,
                    mime: 'text/plain'
                });
            }
        } else if (mime === 'text/plain') {
            // Check if it's actually HTML content that was mislabeled
            if (cachedOutput.body.trim().startsWith('<')) {
                items.push({
                    type: 'text',
                    content: cachedOutput.body,
                    mime: 'application/vnd.pluto.html+html'
                });
            } else {
                items.push({
                    type: 'text',
                    content: cachedOutput.body,
                    mime: 'text/plain'
                });
            }
        } else {
            items.push({
                type: 'text',
                content: cachedOutput.body,
                mime: mime
            });
        }
    }

    return items;
}
