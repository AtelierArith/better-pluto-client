/**
 * PlutoNotebookParser - Parse and serialize Pluto.jl notebook files
 */

export interface PlutoCell {
    id: string;
    code: string;
}

export interface PlutoNotebook {
    version: string;
    cells: Map<string, PlutoCell>;
    cellOrder: string[];
    preamble: string;
}

const CELL_MARKER = /^# ╔═╡ ([0-9a-f-]+)$/;
const CELL_ORDER_START = /^# ╔═╡ Cell order:$/;
// Cell order uses ╠═ for visible cells or ╟═ for hidden cells
const CELL_ORDER_ITEM = /^# [╠╟]═([0-9a-f-]+)$/;
const VERSION_PATTERN = /^# v(\d+\.\d+\.\d+)$/;

/**
 * Parse a Pluto.jl notebook file
 */
export function parse(content: string): PlutoNotebook {
    const lines = content.split('\n');

    let version = '0.20.0';
    const cells = new Map<string, PlutoCell>();
    const cellOrder: string[] = [];
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
            // Save current cell if any
            if (currentCellId) {
                cells.set(currentCellId, {
                    id: currentCellId,
                    code: currentCellLines.join('\n').trim()
                });
            }
            inCellOrder = true;
            continue;
        }

        if (inCellOrder) {
            const orderMatch = line.match(CELL_ORDER_ITEM);
            if (orderMatch) {
                cellOrder.push(orderMatch[1]);
            }
            continue;
        }

        // Cell marker
        const cellMatch = line.match(CELL_MARKER);
        if (cellMatch) {
            // Save previous cell
            if (currentCellId) {
                cells.set(currentCellId, {
                    id: currentCellId,
                    code: currentCellLines.join('\n').trim()
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

    // Save last cell if not in cell order
    if (currentCellId && !inCellOrder) {
        cells.set(currentCellId, {
            id: currentCellId,
            code: currentCellLines.join('\n').trim()
        });
    }

    return {
        version,
        cells,
        cellOrder,
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
        lines.push(cell.code);
        lines.push('');
    }

    // Cell order
    lines.push('# ╔═╡ Cell order:');
    for (const id of notebook.cellOrder) {
        lines.push(`# ╠═${id}`);
    }

    return lines.join('\n');
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
