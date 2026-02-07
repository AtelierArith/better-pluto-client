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
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="currentColor">
            <path d="M448 96H64c-17.67 0-32 14.33-32 32v256c0 17.67 14.33 32 32 32h384c17.67 0 32-14.33 32-32V128c0-17.67-14.33-32-32-32zm8 288c0 4.41-3.59 8-8 8H64c-4.41 0-8-3.59-8-8V128c0-4.41 3.59-8 8-8h384c4.41 0 8 3.59 8 8v256z"/>
            <path d="M168 168l-88 88 88 88 22.63-22.63L125.25 256l65.38-65.37L168 168zM344 168l-22.63 22.63L386.75 256l-65.38 65.37L344 344l88-88-88-88z"/>
        </svg>
        stdout
    </div>
    <pre class="pluto-stdout">${escapedStdout}</pre>
</div>`;
}
