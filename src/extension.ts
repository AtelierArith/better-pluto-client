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

export function deactivate() {
    console.log('Pluto Notebook extension deactivated');
}
