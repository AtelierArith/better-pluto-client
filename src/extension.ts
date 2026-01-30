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
import { PlutoNotebookSerializer } from './PlutoNotebookSerializer';
import { PlutoNotebookController } from './PlutoNotebookController';

const NOTEBOOK_TYPE = 'pluto-notebook';

let controller: PlutoNotebookController | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('[PlutoExtension] ========================================');
    console.log('[PlutoExtension] Pluto Notebook extension activating...');
    console.log('[PlutoExtension] ========================================');

    // Register notebook serializer
    console.log('[PlutoExtension] Registering notebook serializer for type:', NOTEBOOK_TYPE);
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
    console.log('[PlutoExtension] Notebook serializer registered');

    // Register notebook controller
    console.log('[PlutoExtension] Registering notebook controller');
    controller = new PlutoNotebookController();
    context.subscriptions.push(controller);
    console.log('[PlutoExtension] Notebook controller registered');

    // Setup renderer messaging for interactive widgets (Slider, etc.)
    setupRendererMessaging(context);

    console.log('[PlutoExtension] Extension activation complete');

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
        console.log('[PlutoExtension] Received renderer message:', message);

        if (message.type === 'setBond' && message.name !== undefined) {
            // Find the notebook that contains this editor
            const notebook = e.editor.notebook;
            if (notebook && controller) {
                controller.setBond(notebook, message.name, message.value);
            } else {
                console.log('[PlutoExtension] No notebook or controller found');
            }
        } else if (message.type === 'showMore' && message.objectid) {
            // Handle "show more" request from tree view
            const notebook = e.editor.notebook;
            if (notebook && controller) {
                controller.getPublishedObject(notebook, message.objectid);
            } else {
                console.log('[PlutoExtension] No notebook or controller found for showMore');
            }
        }
    });

    context.subscriptions.push(disposable);
    console.log('[PlutoExtension] Renderer messaging setup complete');
}

export function deactivate() {
    console.log('Pluto Notebook extension deactivated');
}
