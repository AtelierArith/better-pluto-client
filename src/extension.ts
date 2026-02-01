/**
 * Modern Pluto Client - VS Code Extension
 *
 * Provides native notebook support for Pluto.jl notebooks with full editor features:
 * - Syntax highlighting
 * - AI code completion (Copilot, Cursor)
 * - Julia LSP integration
 * - Reactive execution via Pluto.jl kernel
 */

import * as vscode from 'vscode';
import { PlutoNotebookSerializer, isCellFolded, toggleCellFolded } from './PlutoNotebookSerializer';
import { PlutoNotebookController } from './PlutoNotebookController';

const NOTEBOOK_TYPE = 'pluto-notebook';

let controller: PlutoNotebookController | undefined;

// Global output channel for Pluto extension
let outputChannel: vscode.OutputChannel;

/**
 * Get the Pluto output channel for logging
 */
export function getOutputChannel(): vscode.OutputChannel {
    return outputChannel;
}

/**
 * Log a message to the Pluto output channel
 */
export function log(message: string): void {
    const timestamp = new Date().toISOString().substring(11, 23);
    outputChannel?.appendLine(`[${timestamp}] ${message}`);
    console.log(`[BetterPluto] ${message}`);
}

export function activate(context: vscode.ExtensionContext) {
    // Create output channel first
    outputChannel = vscode.window.createOutputChannel('BetterPlutoClient');
    context.subscriptions.push(outputChannel);

    log('========================================');
    log('Pluto Notebook extension activating...');
    log('========================================');

    // Register notebook serializer
    log(`Registering notebook serializer for type: ${NOTEBOOK_TYPE}`);
    const serializer = new PlutoNotebookSerializer();
    context.subscriptions.push(
        vscode.workspace.registerNotebookSerializer(
            NOTEBOOK_TYPE,
            serializer,
            {
                transientOutputs: true  // Don't persist outputs to file
            }
        )
    );
    log('Notebook serializer registered');

    // Register notebook controller
    log('Registering notebook controller');
    controller = new PlutoNotebookController();
    context.subscriptions.push(controller);
    log('Notebook controller registered');

    // Setup renderer messaging for interactive widgets (Slider, etc.)
    setupRendererMessaging(context);

    // Apply folded state when notebook editor becomes active
    // Track which notebooks have been processed to avoid re-applying
    const processedNotebooks = new Set<string>();

    context.subscriptions.push(
        vscode.window.onDidChangeActiveNotebookEditor(async (editor) => {
            if (!editor) {
                return;
            }
            const notebook = editor.notebook;
            if (notebook.notebookType !== NOTEBOOK_TYPE) {
                return;
            }

            // Only apply once per notebook
            const notebookKey = notebook.uri.toString();
            if (processedNotebooks.has(notebookKey)) {
                return;
            }
            processedNotebooks.add(notebookKey);

            log('Notebook editor activated, applying folded states...');
            // Small delay to ensure the editor is fully ready
            await new Promise(resolve => setTimeout(resolve, 100));
            await applyFoldedStates(notebook);
        })
    );

    // Clean up when notebook is closed
    context.subscriptions.push(
        vscode.workspace.onDidCloseNotebookDocument((notebook) => {
            processedNotebooks.delete(notebook.uri.toString());
        })
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('pluto-notebook.openAsPlutoNotebook', async (uri?: vscode.Uri) => {
            // Get URI from active editor if not provided
            if (!uri) {
                uri = vscode.window.activeTextEditor?.document.uri;
            }

            if (!uri) {
                vscode.window.showErrorMessage('No file selected');
                return;
            }

            // Open as notebook
            await vscode.commands.executeCommand('vscode.openWith', uri, NOTEBOOK_TYPE);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('pluto-notebook.startKernel', async () => {
            const notebook = getActiveNotebook();
            if (notebook && controller) {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Starting Pluto kernel...',
                    cancellable: false
                }, async () => {
                    await controller!.startKernel(notebook);
                });
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('pluto-notebook.stopKernel', async () => {
            const notebook = getActiveNotebook();
            if (notebook && controller) {
                await controller.stopKernel(notebook);
                vscode.window.showInformationMessage('Pluto kernel stopped');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('pluto-notebook.restartKernel', async () => {
            const notebook = getActiveNotebook();
            if (notebook && controller) {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Restarting Pluto kernel...',
                    cancellable: false
                }, async () => {
                    await controller!.restartKernel(notebook);
                });
                vscode.window.showInformationMessage('Pluto kernel restarted');
            }
        })
    );

    // Command to save and execute modified cells
    context.subscriptions.push(
        vscode.commands.registerCommand('pluto-notebook.saveAndExecute', async () => {
            const notebook = getActiveNotebook();
            if (notebook && controller) {
                log('saveAndExecute: Saving notebook...');
                // Save the notebook document (this triggers serializer)
                await notebook.save();
                log('saveAndExecute: Notebook saved, executing modified cells...');
                // Then execute modified cells
                await controller.executeModifiedCells(notebook);
                log('saveAndExecute: Done');
            }
        })
    );

    // Command to wrap cell content in begin...end
    context.subscriptions.push(
        vscode.commands.registerCommand('pluto-notebook.wrapInBeginEnd', async () => {
            const notebookEditor = vscode.window.activeNotebookEditor;
            if (!notebookEditor) {
                vscode.window.showErrorMessage('No active notebook');
                return;
            }

            const selections = notebookEditor.selections;
            if (selections.length === 0) {
                vscode.window.showErrorMessage('No cell selected');
                return;
            }

            // Get the first selected cell
            const cellRange = selections[0];
            const cell = notebookEditor.notebook.cellAt(cellRange.start);

            if (cell.kind !== vscode.NotebookCellKind.Code) {
                vscode.window.showErrorMessage('Selected cell is not a code cell');
                return;
            }

            const originalCode = cell.document.getText();

            // Check if already wrapped in begin...end
            const trimmed = originalCode.trim();
            if (trimmed.startsWith('begin') && trimmed.endsWith('end')) {
                vscode.window.showInformationMessage('Cell is already wrapped in begin...end');
                return;
            }

            // Wrap in begin...end with proper indentation
            const lines = originalCode.split('\n');
            const indentedLines = lines.map(line => line ? '    ' + line : line);
            const wrappedCode = 'begin\n' + indentedLines.join('\n') + '\nend';

            // Replace cell content
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                cell.document.positionAt(0),
                cell.document.positionAt(cell.document.getText().length)
            );
            edit.replace(cell.document.uri, fullRange, wrappedCode);
            await vscode.workspace.applyEdit(edit);

            vscode.window.showInformationMessage('Cell wrapped in begin...end');
        })
    );

    // Command to toggle cell code visibility (fold/unfold)
    context.subscriptions.push(
        vscode.commands.registerCommand('pluto-notebook.toggleCellFolded', async (cellArg?: vscode.NotebookCell | { cell?: vscode.NotebookCell }) => {
            log(`toggleCellFolded called with arg: ${cellArg}`);

            // If called from cell title bar, the argument is the cell directly or {cell: ...}
            let targetCell: vscode.NotebookCell | undefined;
            if (cellArg) {
                if ('document' in cellArg && 'index' in cellArg) {
                    // It's a NotebookCell directly
                    targetCell = cellArg as vscode.NotebookCell;
                } else if ('cell' in cellArg && cellArg.cell) {
                    // It's {cell: NotebookCell}
                    targetCell = cellArg.cell;
                }
            }

            if (targetCell) {
                // Update our custom metadata for file saving
                const newFolded = await toggleCellFolded(targetCell);
                log(`Cell ${targetCell.index} folded: ${newFolded}`);

                // Use VS Code's built-in collapse command for visual effect
                // First, select the cell
                const notebookEditor = vscode.window.activeNotebookEditor;
                if (notebookEditor) {
                    // Select the cell
                    notebookEditor.selection = new vscode.NotebookRange(targetCell.index, targetCell.index + 1);

                    // Use VS Code's built-in command to toggle collapse
                    if (newFolded) {
                        await vscode.commands.executeCommand('notebook.cell.collapseCellInput');
                    } else {
                        await vscode.commands.executeCommand('notebook.cell.expandCellInput');
                    }
                }
                return;
            }

            // Otherwise, use selection
            const notebookEditor = vscode.window.activeNotebookEditor;
            if (!notebookEditor) {
                vscode.window.showErrorMessage('No active notebook');
                return;
            }

            const selections = notebookEditor.selections;
            if (selections.length === 0) {
                vscode.window.showErrorMessage('No cell selected');
                return;
            }

            // Toggle folded state for all selected cells
            for (const cellRange of selections) {
                for (let i = cellRange.start; i < cellRange.end; i++) {
                    const cell = notebookEditor.notebook.cellAt(i);
                    const newFolded = await toggleCellFolded(cell);
                    log(`Cell ${i} folded: ${newFolded}`);
                }
            }
        })
    );

    log('Extension activation complete');
    outputChannel.show(true); // Show output channel (preserveFocus=true)
}

/**
 * Get the active Pluto notebook document
 */
function getActiveNotebook(): vscode.NotebookDocument | undefined {
    // Check active notebook editor
    const notebookEditor = vscode.window.activeNotebookEditor;
    if (notebookEditor && notebookEditor.notebook.notebookType === NOTEBOOK_TYPE) {
        return notebookEditor.notebook;
    }
    return undefined;
}

/**
 * Setup messaging between the HTML renderer and extension
 * for interactive widgets like Slider
 */
function setupRendererMessaging(context: vscode.ExtensionContext) {
    const messaging = vscode.notebooks.createRendererMessaging('pluto-html-renderer');

    const disposable = messaging.onDidReceiveMessage(e => {
        const message = e.message as { type: string; name?: string; value?: unknown; objectid?: string };
        log(`Received renderer message: ${JSON.stringify(message)}`);

        if (message.type === 'setBond' && message.name !== undefined) {
            // Find the notebook that contains this editor
            const notebook = e.editor.notebook;
            if (notebook && controller) {
                controller.setBond(notebook, message.name, message.value);
            } else {
                log('No notebook or controller found');
            }
        } else if (message.type === 'showMore' && message.objectid) {
            // Handle "show more" request from tree view
            const notebook = e.editor.notebook;
            if (notebook && controller) {
                controller.getPublishedObject(notebook, message.objectid);
            } else {
                log('No notebook or controller found for showMore');
            }
        }
    });

    context.subscriptions.push(disposable);
    log('Renderer messaging setup complete');
}

/**
 * Apply folded states to notebook cells after opening
 * VS Code doesn't automatically apply inputCollapsed from NotebookData metadata,
 * so we need to use the VS Code command to collapse cells.
 */
async function applyFoldedStates(notebook: vscode.NotebookDocument): Promise<void> {
    const notebookEditor = vscode.window.activeNotebookEditor;
    if (!notebookEditor || notebookEditor.notebook !== notebook) {
        log('No active notebook editor for this notebook');
        return;
    }

    // Find cells that should be folded
    const cellsToFold: number[] = [];
    for (const cell of notebook.getCells()) {
        const customMetadata = cell.metadata?.custom as { folded?: boolean } | undefined;
        const shouldBeFolded = customMetadata?.folded ?? false;

        if (shouldBeFolded) {
            cellsToFold.push(cell.index);
        }
    }

    log(`Cells to fold: ${cellsToFold.length} cells [${cellsToFold.slice(0, 10).join(', ')}]`);

    if (cellsToFold.length === 0) {
        return;
    }

    // Select all cells that need to be folded and collapse them at once
    // VS Code's collapse command works on selected cells
    const selections = cellsToFold.map(idx => new vscode.NotebookRange(idx, idx + 1));
    notebookEditor.selections = selections;

    // Execute collapse command
    await vscode.commands.executeCommand('notebook.cell.collapseCellInput');

    // Clear selection (select first cell)
    notebookEditor.selections = [new vscode.NotebookRange(0, 1)];

    log('Folded states applied using collapse command');
}

export function deactivate() {
    log('Pluto Notebook extension deactivated');
}
