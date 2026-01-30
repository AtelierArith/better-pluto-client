/**
 * PlutoNotebookSerializer - Serialize/deserialize Pluto.jl notebooks for VS Code Notebook API
 */

import * as vscode from 'vscode';
import * as parser from './PlutoNotebookParser';

const JULIA_LANGUAGE_ID = 'julia';

/**
 * Custom metadata stored in notebook/cell metadata
 */
interface PlutoNotebookMetadata {
    version: string;
    preamble: string;
}

interface PlutoCellMetadata {
    id: string;
}

/**
 * NotebookSerializer implementation for Pluto.jl notebooks
 */
export class PlutoNotebookSerializer implements vscode.NotebookSerializer {

    /**
     * Deserialize a Pluto.jl notebook file into VS Code NotebookData
     */
    deserializeNotebook(
        content: Uint8Array,
        _token: vscode.CancellationToken
    ): vscode.NotebookData {
        const text = new TextDecoder().decode(content);

        console.log('[PlutoSerializer] Deserializing notebook, content length:', text.length);

        // Handle empty file
        if (!text.trim()) {
            console.log('[PlutoSerializer] Empty file, creating empty notebook');
            return this.createEmptyNotebook();
        }

        try {
            const notebook = parser.parse(text);
            console.log('[PlutoSerializer] Parsed notebook:', {
                version: notebook.version,
                cellCount: notebook.cells.size,
                cellOrder: notebook.cellOrder
            });
            const notebookData = this.convertToNotebookData(notebook);
            console.log('[PlutoSerializer] Created NotebookData with', notebookData.cells.length, 'cells');

            // Debug: Log each cell
            for (let i = 0; i < notebookData.cells.length; i++) {
                const cell = notebookData.cells[i];
                console.log(`[PlutoSerializer] Cell ${i}:`, {
                    kind: cell.kind,
                    language: cell.languageId,
                    valueLength: cell.value.length,
                    valuePreview: cell.value.substring(0, 50)
                });
            }

            return notebookData;
        } catch (err) {
            console.error('[PlutoSerializer] Failed to parse notebook:', err);
            // Return a single cell with the raw content
            return this.createFallbackNotebook(text);
        }
    }

    /**
     * Serialize VS Code NotebookData back to Pluto.jl notebook format
     */
    serializeNotebook(
        data: vscode.NotebookData,
        _token: vscode.CancellationToken
    ): Uint8Array {
        console.log('[PlutoSerializer] Serializing notebook with', data.cells.length, 'cells');
        const notebook = this.convertFromNotebookData(data);
        const content = parser.serialize(notebook);
        return new TextEncoder().encode(content);
    }

    /**
     * Convert parsed Pluto notebook to VS Code NotebookData
     */
    private convertToNotebookData(notebook: parser.PlutoNotebook): vscode.NotebookData {
        const cells: vscode.NotebookCellData[] = [];

        // Create cells in order
        for (const cellId of notebook.cellOrder) {
            const cell = notebook.cells.get(cellId);
            if (!cell) continue;

            const cellData = new vscode.NotebookCellData(
                vscode.NotebookCellKind.Code,
                cell.code,
                JULIA_LANGUAGE_ID
            );

            // Store cell ID in metadata
            cellData.metadata = {
                custom: {
                    id: cellId
                } as PlutoCellMetadata
            };

            cells.push(cellData);
        }

        // If no cells, create one empty cell
        if (cells.length === 0) {
            const emptyCell = new vscode.NotebookCellData(
                vscode.NotebookCellKind.Code,
                '',
                JULIA_LANGUAGE_ID
            );
            emptyCell.metadata = {
                custom: {
                    id: parser.generateCellId()
                } as PlutoCellMetadata
            };
            cells.push(emptyCell);
        }

        const notebookData = new vscode.NotebookData(cells);

        // Store notebook metadata
        notebookData.metadata = {
            custom: {
                version: notebook.version,
                preamble: notebook.preamble
            } as PlutoNotebookMetadata
        };

        return notebookData;
    }

    /**
     * Convert VS Code NotebookData back to Pluto notebook format
     */
    private convertFromNotebookData(data: vscode.NotebookData): parser.PlutoNotebook {
        const metadata = (data.metadata?.custom || {}) as PlutoNotebookMetadata;

        const cells = new Map<string, parser.PlutoCell>();
        const cellOrder: string[] = [];

        for (const cellData of data.cells) {
            const cellMetadata = (cellData.metadata?.custom || {}) as PlutoCellMetadata;

            // Get or generate cell ID
            let cellId = cellMetadata.id;
            if (!cellId) {
                cellId = parser.generateCellId();
            }

            cells.set(cellId, {
                id: cellId,
                code: cellData.value
            });

            cellOrder.push(cellId);
        }

        return {
            version: metadata.version || '0.20.0',
            cells,
            cellOrder,
            preamble: metadata.preamble || ''
        };
    }

    /**
     * Create empty notebook for new files
     */
    private createEmptyNotebook(): vscode.NotebookData {
        const cellId = parser.generateCellId();
        const cell = new vscode.NotebookCellData(
            vscode.NotebookCellKind.Code,
            '',
            JULIA_LANGUAGE_ID
        );
        cell.metadata = {
            custom: { id: cellId } as PlutoCellMetadata
        };

        const notebookData = new vscode.NotebookData([cell]);
        notebookData.metadata = {
            custom: {
                version: '0.20.0',
                preamble: ''
            } as PlutoNotebookMetadata
        };

        return notebookData;
    }

    /**
     * Create fallback notebook when parsing fails
     */
    private createFallbackNotebook(content: string): vscode.NotebookData {
        const cellId = parser.generateCellId();
        const cell = new vscode.NotebookCellData(
            vscode.NotebookCellKind.Code,
            content,
            JULIA_LANGUAGE_ID
        );
        cell.metadata = {
            custom: { id: cellId } as PlutoCellMetadata
        };

        const notebookData = new vscode.NotebookData([cell]);
        notebookData.metadata = {
            custom: {
                version: '0.20.0',
                preamble: ''
            } as PlutoNotebookMetadata
        };

        return notebookData;
    }
}

/**
 * Get cell ID from cell metadata
 */
export function getCellId(cell: vscode.NotebookCell): string {
    const metadata = cell.metadata?.custom as PlutoCellMetadata | undefined;
    return metadata?.id || '';
}

/**
 * Set cell ID in cell metadata
 */
export async function setCellId(cell: vscode.NotebookCell, cellId: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const newMetadata = {
        ...cell.metadata,
        custom: {
            ...(cell.metadata?.custom || {}),
            id: cellId
        }
    };

    edit.set(cell.notebook.uri, [
        vscode.NotebookEdit.updateCellMetadata(cell.index, newMetadata)
    ]);

    await vscode.workspace.applyEdit(edit);
}
