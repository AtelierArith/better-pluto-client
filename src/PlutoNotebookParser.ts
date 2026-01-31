/**
 * PlutoNotebookParser - Parse and serialize Pluto.jl notebook files
 */

export interface PlutoCell {
    id: string;
    code: string;
    kind: 'code' | 'markdown';
    folded: boolean;
}

export interface PlutoNotebook {
    version: string;
    cells: Map<string, PlutoCell>;
    cellOrder: string[];
    foldedCells: Set<string>;  // Track which cells are folded
    preamble: string;
}

const CELL_MARKER = /^# ╔═╡ ([0-9a-f-]+)$/;
const CELL_ORDER_START = /^# ╔═╡ Cell order:$/;
// Cell order uses ╠═ for visible cells or ╟─ for hidden (folded) cells
const CELL_ORDER_ITEM = /^# ([╠╟])[═─]([0-9a-f-]+)$/;
const VERSION_PATTERN = /^# v(\d+\.\d+\.\d+)$/;

// Pluto.jl internal cell IDs for package management (should be filtered out)
const PLUTO_INTERNAL_CELL_IDS = new Set([
    '00000000-0000-0000-0000-000000000001',  // PLUTO_PROJECT_TOML_CONTENTS
    '00000000-0000-0000-0000-000000000002',  // PLUTO_MANIFEST_TOML_CONTENTS
]);

/**
 * Check if a cell ID is a Pluto.jl internal cell (package management)
 */
export function isPlutoInternalCell(cellId: string): boolean {
    return PLUTO_INTERNAL_CELL_IDS.has(cellId);
}

/**
 * Parse a Pluto.jl notebook file
 */
export function parse(content: string): PlutoNotebook {
    const lines = content.split('\n');

    let version = '0.20.0';
    const cells = new Map<string, PlutoCell>();
    const cellOrder: string[] = [];
    const foldedCells = new Set<string>();
    const preambleLines: string[] = [];

    let currentCellId: string | null = null;
    let currentCellLines: string[] = [];
    let inCellOrder = false;
    let inPreamble = true;

    for (const line of lines) {
        // Skip header
        if (line.startsWith('### A Pluto.jl notebook ###')) {
            continue;
        }

        // Version
        const versionMatch = line.match(VERSION_PATTERN);
        if (versionMatch) {
            version = versionMatch[1];
            continue;
        }

        // Cell order section
        if (CELL_ORDER_START.test(line)) {
            // Save current cell if any (skip internal cells)
            if (currentCellId && !isPlutoInternalCell(currentCellId)) {
                const cellCode = currentCellLines.join('\n').trim();
                const cellKind = detectCellKind(cellCode);
                // Keep md"""...""" syntax as-is (don't extract content)
                cells.set(currentCellId, {
                    id: currentCellId,
                    code: cellCode,
                    kind: cellKind,
                    folded: false  // Will be updated later from cell order
                });
            }
            inCellOrder = true;
            continue;
        }

        if (inCellOrder) {
            const orderMatch = line.match(CELL_ORDER_ITEM);
            if (orderMatch) {
                const delimiter = orderMatch[1];  // ╠ or ╟
                const cellId = orderMatch[2];
                // Skip Pluto.jl internal cells (package management)
                if (isPlutoInternalCell(cellId)) {
                    continue;
                }
                cellOrder.push(cellId);
                // ╟─ means folded (hidden code)
                if (delimiter === '╟') {
                    foldedCells.add(cellId);
                }
            }
            continue;
        }

        // Cell marker
        const cellMatch = line.match(CELL_MARKER);
        if (cellMatch) {
            // Save previous cell (skip internal cells)
            if (currentCellId && !isPlutoInternalCell(currentCellId)) {
                const cellCode = currentCellLines.join('\n').trim();
                const cellKind = detectCellKind(cellCode);
                // Keep md"""...""" syntax as-is (don't extract content)
                cells.set(currentCellId, {
                    id: currentCellId,
                    code: cellCode,
                    kind: cellKind,
                    folded: false  // Will be updated later from cell order
                });
            } else if (inPreamble) {
                inPreamble = false;
            }

            currentCellId = cellMatch[1];
            currentCellLines = [];
            continue;
        }

        // Content
        if (currentCellId) {
            currentCellLines.push(line);
        } else if (inPreamble) {
            preambleLines.push(line);
        }
    }

    // Save last cell if not in cell order (skip internal cells)
    if (currentCellId && !inCellOrder && !isPlutoInternalCell(currentCellId)) {
        const cellCode = currentCellLines.join('\n').trim();
        const cellKind = detectCellKind(cellCode);
        // Keep md"""...""" syntax as-is (don't extract content)
        cells.set(currentCellId, {
            id: currentCellId,
            code: cellCode,
            kind: cellKind,
            folded: false  // Will be updated later from cell order
        });
    }

    // Update cells with folded state
    for (const [id, cell] of cells) {
        cell.folded = foldedCells.has(id);
    }

    return {
        version,
        cells,
        cellOrder,
        foldedCells,
        preamble: preambleLines.join('\n').trim()
    };
}

/**
 * Serialize a PlutoNotebook back to file content
 */
export function serialize(notebook: PlutoNotebook): string {
    const lines: string[] = [];

    // Header
    lines.push('### A Pluto.jl notebook ###');
    lines.push(`# v${notebook.version}`);
    lines.push('');

    // Preamble
    if (notebook.preamble) {
        lines.push(notebook.preamble);
        lines.push('');
    }

    // Cells
    for (const [id, cell] of notebook.cells) {
        lines.push(`# ╔═╡ ${id}`);
        // Code is stored as-is (md"""...""" cells already have the wrapper)
        // Remove leading newline if it was added for folding display
        let code = cell.code;
        if (cell.folded && code.startsWith('\n')) {
            code = code.substring(1);
        }
        lines.push(code);
        lines.push('');
    }

    // Cell order
    lines.push('# ╔═╡ Cell order:');
    for (const id of notebook.cellOrder) {
        const cell = notebook.cells.get(id);
        // Use ╟─ for folded cells, ╠═ for visible cells
        const delimiter = cell?.folded ? '# ╟─' : '# ╠═';
        lines.push(`${delimiter}${id}`);
    }

    return lines.join('\n');
}

/**
 * Detect if a cell is a Markdown cell (starts with md""")
 */
export function detectCellKind(code: string): 'code' | 'markdown' {
    const trimmed = code.trim();
    // Check if code starts with md""" (possibly with whitespace)
    return trimmed.startsWith('md"""') ? 'markdown' : 'code';
}

/**
 * Extract Markdown content from md"""...""" wrapper
 * Handles both single-line and multi-line cases
 */
function extractMarkdownContent(code: string): string {
    const trimmed = code.trim();
    if (!trimmed.startsWith('md"""')) {
        return code;
    }

    // Find the opening md"""
    const startIdx = trimmed.indexOf('md"""');
    if (startIdx === -1) {
        return code;
    }

    // Find the closing """
    // Start searching after md"""
    let searchStart = startIdx + 5;
    let endIdx = trimmed.indexOf('"""', searchStart);

    // If not found, try to find it at the end
    if (endIdx === -1) {
        if (trimmed.endsWith('"""')) {
            endIdx = trimmed.length - 3;
        } else {
            // No closing found, return as-is
            return code;
        }
    }

    // Extract content between md""" and """
    const content = trimmed.substring(startIdx + 5, endIdx);

    return content;
}

/**
 * Generate a new cell UUID
 */
export function generateCellId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
