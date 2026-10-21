/**
 * Utility functions for handling Pluto cell outputs
 * Extracted for testability
 */

import type { ProtocolLogEntry as LogEntry } from './pluto-protocol';

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

const STDOUT_LOG_LEVEL = 'LogLevel(-555)';

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
        renderTreeAsHtml?: (body: string, cellId?: string) => string;
        cellId?: string;
    }
): OutputItem[] {
    const items: OutputItem[] = [];

    // Add logs (stdout) if present
    if (cachedOutput.logs && cachedOutput.logs.length > 0) {
        const stdoutLogs = cachedOutput.logs
            .filter((logEntry) => logEntry.level === STDOUT_LOG_LEVEL)
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

        if (mime === 'application/vnd.pluto.table+object') {
            if (!isPlutoObjectId(cachedOutput.body)) {
                const tableHtml = renderPlutoTableAsHtml(cachedOutput.body, options?.cellId);
                items.push({
                    type: 'text',
                    content: tableHtml ?? cachedOutput.body,
                    mime: tableHtml === null ? 'text/plain' : 'application/vnd.pluto.html+html'
                });
            }
        } else if (mime === 'application/vnd.pluto.stacktrace+object') {
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
                    ? options.renderTreeAsHtml(cachedOutput.body, options?.cellId)
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
        } else if (['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/bmp'].includes(mime)) {
            try {
                const buffer = Buffer.from(cachedOutput.body, 'base64');
                if (mime === 'image/bmp') {
                    // VS Code's built-in notebook renderer does not declare BMP.
                    // Re-encode bytes so no untrusted text enters the HTML attribute.
                    items.push({
                        type: 'text',
                        content: `<img src="data:image/bmp;base64,${buffer.toString('base64')}" alt="Pluto bitmap output">`,
                        mime: 'application/vnd.pluto.html+html'
                    });
                } else {
                    items.push({
                        type: 'binary',
                        content: new Uint8Array(buffer),
                        mime: mime === 'image/jpg' ? 'image/jpeg' : mime
                    });
                }
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
            items.push({
                type: 'text',
                content: cachedOutput.body,
                mime: 'text/plain'
            });
        } else if (mime.startsWith('application/vnd.pluto.') && mime.endsWith('+object')) {
            // VS Code has no renderer for Pluto's other structured MIME types.
            // Preserve their data as readable text rather than a missing-renderer error.
            items.push({
                type: 'text',
                content: cachedOutput.body,
                mime: 'text/plain'
            });
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

/**
 * Escape HTML special characters
 */
export function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Render the schema/rows format emitted by Pluto's TableView (e.g. DataFrames).
 * Nested MIME values intentionally use escaped text, not executable HTML.
 * Return null for malformed payloads so callers can display the original text.
 */
export function renderPlutoTableAsHtml(body: string, cellId?: string): string | null {
    try {
        const table: unknown = JSON.parse(body);
        if (!table || typeof table !== 'object' || Array.isArray(table)) { return null; }
        const value = table as Record<string, unknown>;
        const schema = value.schema;
        if (schema !== null && schema !== undefined &&
            (typeof schema !== 'object' || Array.isArray(schema))) { return null; }
        const fields = (schema ?? {}) as Record<string, unknown>;
        const names = fields.names ?? [];
        const types = fields.types ?? [];
        const rows = value.rows ?? [];
        if (!Array.isArray(names) || !Array.isArray(types) || !Array.isArray(rows)) { return null; }
        const text = (item: unknown): string => escapeHtml(
            typeof item === 'string' ? item : JSON.stringify(item) ?? ''
        );
        const more = (dimension: 1 | 2): string => {
            if (cellId && typeof value.objectid === 'string' && value.objectid) {
                return `<pluto-tree-more data-cellid="${escapeHtml(cellId)}" data-objectid="${escapeHtml(value.objectid)}" data-dim="${dimension}">show more</pluto-tree-more>`;
            }
            return '<span>(more data not shown)</span>';
        };
        const colspan = names.length + 1;
        const head = names.length === 0
            ? '<tr><th>No columns</th></tr>'
            : `<tr><th></th>${names.map(name => `<th>${name === 'more' ? more(2) : text(name)}</th>`).join('')}</tr>` +
              `<tr><th></th>${names.map((name, index) => `<th>${name === 'more' ? '' : text(types[index])}</th>`).join('')}</tr>`;
        const renderedRows: string[] = [];
        for (const row of rows) {
            if (row === 'more') {
                renderedRows.push(`<tr><td colspan="${colspan}">${more(1)}</td></tr>`);
                continue;
            }
            if (!Array.isArray(row) || row.length !== 2 || !Array.isArray(row[1])) { return null; }
            const cells: string[] = [];
            for (const pair of row[1]) {
                if (pair === 'more') {
                    cells.push('<td></td>');
                } else if (Array.isArray(pair) && pair.length === 2 && typeof pair[1] === 'string') {
                    cells.push(`<td>${text(pair[0])}</td>`);
                } else {
                    return null;
                }
            }
            renderedRows.push(`<tr><th>${text(row[0])}</th>${cells.join('')}</tr>`);
        }
        const contents = renderedRows.length > 0
            ? renderedRows.join('')
            : `<tr><td colspan="${colspan}">No rows</td></tr>`;
        return `<table class="pluto-table"><thead>${head}</thead><tbody>${contents}</tbody></table>`;
    } catch {
        return null;
    }
}

/**
 * Render stdout as Pluto-style terminal HTML
 * Based on Pluto.jl's Logs.js and editor.css styling
 */
export function renderStdoutAsHtml(stdout: string): string {
    const escapedStdout = escapeHtml(stdout);

    return `
<style>
/* Pluto.jl Stdout Terminal Styling */
.pluto-stdout-container {
    display: block;
    margin: 4px 0;
}

.pluto-stdout {
    /* CRT terminal style - based on Pluto.jl editor.css */
    --inner: hsl(36deg 20% 37%);
    --outer: hsl(31deg 12% 28%);
    background: radial-gradient(var(--inner), var(--inner) 20%, var(--outer));
    color: #c0ffab;
    border: 4px solid #b7b7b7;
    text-shadow: 1px 1px 2px #0000005e;
    border-radius: 6px;
    padding: 8px 12px;
    font-family: "JuliaMono", "Fira Code", "Roboto Mono", monospace;
    font-size: 0.85em;
    position: relative;
    overflow: hidden;
    min-width: 12em;
    max-width: 100%;
    white-space: pre-wrap;
    word-break: break-word;
}

/* CRT scanline effect overlay */
.pluto-stdout::before {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    opacity: 0.15;
    background: linear-gradient(349deg, #000000, transparent);
    pointer-events: none;
}

.pluto-stdout::after {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    --crt-spacing: 5px;
    background: linear-gradient(180deg, hsl(37deg 20% 27%), transparent, #1a1a1a);
    background-size: 100% var(--crt-spacing);
    opacity: 0.08;
    pointer-events: none;
}

/* Terminal icon label */
.pluto-stdout-label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.75em;
    color: #888;
    margin-bottom: 4px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.pluto-stdout-label svg {
    width: 14px;
    height: 14px;
    opacity: 0.7;
}

/* Light theme adjustments */
@media (prefers-color-scheme: light) {
    .pluto-stdout {
        --inner: hsl(36deg 15% 45%);
        --outer: hsl(31deg 10% 38%);
        border-color: #999;
    }
}
</style>
<div class="pluto-stdout-container">
    <div class="pluto-stdout-label">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="14" height="14" fill="currentColor">
            <path d="M448 96H64c-17.67 0-32 14.33-32 32v256c0 17.67 14.33 32 32 32h384c17.67 0 32-14.33 32-32V128c0-17.67-14.33-32-32-32zm8 288c0 4.41-3.59 8-8 8H64c-4.41 0-8-3.59-8-8V128c0-4.41 3.59-8 8-8h384c4.41 0 8 3.59 8 8v256z"/>
            <path d="M168 168l-88 88 88 88 22.63-22.63L125.25 256l65.38-65.37L168 168zM344 168l-22.63 22.63L386.75 256l-65.38 65.37L344 344l88-88-88-88z"/>
        </svg>
        stdout
    </div>
    <pre class="pluto-stdout">${escapedStdout}</pre>
</div>`;
}
