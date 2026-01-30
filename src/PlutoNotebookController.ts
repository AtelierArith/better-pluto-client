/**
 * PlutoNotebookController - Handle cell execution with Pluto.jl kernel
 */

import * as vscode from 'vscode';
import { PlutoServer, CellState, LogEntry } from './PlutoServer';
import { getCellId, setCellId } from './PlutoNotebookSerializer';
import { generateCellId } from './PlutoNotebookParser';

const NOTEBOOK_TYPE = 'pluto-notebook';

/**
 * Manages Pluto kernel for a notebook
 */
class PlutoKernel {
    private server: PlutoServer;
    private _isRunning = false;
    private cellExecutions = new Map<string, vscode.NotebookCellExecution>();
    private cellOutputs = new Map<string, { body?: string; mime?: string; logs?: LogEntry[] }>();
    private pendingDirectUpdates = new Map<string, NodeJS.Timeout>();  // Debounced direct updates
    private knownCellIds = new Set<string>();  // Cell IDs that Pluto knows about

    constructor(
        private controller: vscode.NotebookController,
        private notebook: vscode.NotebookDocument,
        private onStateChange: () => void
    ) {
        this.server = new PlutoServer();
        this.setupServerEvents();
    }

    get isRunning(): boolean {
        return this._isRunning;
    }

    get notebookUri(): vscode.Uri {
        return this.notebook.uri;
    }

    /**
     * Start the Pluto kernel
     */
    async start(): Promise<void> {
        if (this._isRunning) return;

        console.log('[PlutoKernel] Starting kernel for', this.notebook.uri.fsPath);

        try {
            await this.server.start(this.notebook.uri.fsPath);
            this._isRunning = true;
            this.onStateChange();

            // Sync cells with Pluto
            await this.syncCellsWithPluto();

        } catch (err) {
            console.error('[PlutoKernel] Failed to start:', err);
            throw err;
        }
    }

    /**
     * Stop the Pluto kernel
     */
    async stop(): Promise<void> {
        console.log('[PlutoKernel] Stopping kernel');
        this.server.stop();
        this._isRunning = false;

        // Clear pending direct updates
        for (const timeout of this.pendingDirectUpdates.values()) {
            clearTimeout(timeout);
        }
        this.pendingDirectUpdates.clear();

        // End all running executions
        for (const [cellId, execution] of this.cellExecutions) {
            try {
                execution.end(false, Date.now());
            } catch {}
        }
        this.cellExecutions.clear();

        // Clear known cells - they'll be re-discovered when kernel restarts
        this.knownCellIds.clear();
        this.cellOutputs.clear();

        this.onStateChange();
    }

    /**
     * Restart the kernel
     */
    async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }

    /**
     * Interrupt all running cells
     */
    async interrupt(): Promise<void> {
        console.log('[PlutoKernel] Interrupting execution');

        // Send interrupt to Pluto server
        if (this._isRunning) {
            await this.server.interruptAll();
        }

        // End all running executions
        for (const [cellId, execution] of this.cellExecutions) {
            console.log(`[PlutoKernel] Ending execution for ${cellId} due to interrupt`);
            try {
                execution.replaceOutput([
                    new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.stderr('Execution interrupted')
                    ])
                ]);
                execution.end(false, Date.now());
            } catch {}
        }
        this.cellExecutions.clear();
    }

    /**
     * Set a bond value (for interactive widgets like Slider)
     */
    async setBond(name: string, value: unknown): Promise<void> {
        if (!this._isRunning) {
            console.log('[PlutoKernel] Cannot set bond, kernel not running');
            return;
        }
        console.log(`[PlutoKernel] Setting bond ${name} to`, value);
        await this.server.setBond(name, value);
    }

    /**
     * Execute cells
     */
    async executeCells(cells: vscode.NotebookCell[]): Promise<void> {
        if (!this._isRunning) {
            // Auto-start kernel
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Starting Pluto kernel...',
                cancellable: false
            }, async () => {
                await this.start();
            });
        }

        for (const cell of cells) {
            await this.executeCell(cell);
        }
    }

    /**
     * Execute a single cell
     */
    private async executeCell(cell: vscode.NotebookCell): Promise<void> {
        // Ensure cell has an ID
        let cellId = getCellId(cell);
        if (!cellId) {
            cellId = generateCellId();
            await setCellId(cell, cellId);
        }

        // Get cell code
        const code = cell.document.getText();
        console.log(`[PlutoKernel] executeCell called for ${cellId}, code: "${code.slice(0, 50)}..."`);

        // End any existing execution for this cell (prevent duplicates)
        const existingExecution = this.cellExecutions.get(cellId);
        if (existingExecution) {
            console.log(`[PlutoKernel] Ending previous execution for ${cellId}`);
            try {
                existingExecution.end(false, Date.now());
            } catch {}
            this.cellExecutions.delete(cellId);
        }

        // Create execution
        const execution = this.controller.createNotebookCellExecution(cell);
        this.cellExecutions.set(cellId, execution);

        execution.start(Date.now());
        execution.clearOutput();

        // Note: Timeout disabled - Pluto executions can take a long time for compilation

        // Update cell code in Pluto and run
        try {
            console.log(`[PlutoKernel] Sending updateCell for ${cellId}`);
            await this.server.updateCell(cellId, code);
            console.log(`[PlutoKernel] Sending runCell for ${cellId}`);
            await this.server.runCell(cellId);
            console.log(`[PlutoKernel] runCell completed for ${cellId}`);
        } catch (err) {
            console.error('[PlutoKernel] Failed to run cell:', err);
            execution.replaceOutput([
                new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.error(err as Error)
                ])
            ]);
            execution.end(false, Date.now());
            this.cellExecutions.delete(cellId);
        }
    }

    /**
     * Handle notebook changes (cell added/removed)
     */
    async handleNotebookChange(e: vscode.NotebookDocumentChangeEvent): Promise<void> {
        if (!this._isRunning) return;

        // Handle removed cells
        for (const change of e.contentChanges) {
            for (const cell of change.removedCells) {
                const cellId = getCellId(cell);
                if (cellId) {
                    const index = change.range.start;
                    console.log(`[PlutoKernel] Removing cell ${cellId} at index ${index}`);
                    await this.server.deleteCell(cellId, index);
                    this.knownCellIds.delete(cellId);
                    this.cellOutputs.delete(cellId);
                }
            }

            // Handle added cells
            for (let i = 0; i < change.addedCells.length; i++) {
                const cell = change.addedCells[i];
                let cellId = getCellId(cell);

                if (!cellId) {
                    cellId = generateCellId();
                    await setCellId(cell, cellId);
                }

                const index = change.range.start + i;
                console.log(`[PlutoKernel] Adding cell ${cellId} at index ${index}`);
                await this.server.addCell(cellId, index, cell.document.getText());
                this.knownCellIds.add(cellId);
            }
        }
    }

    /**
     * Sync all cells with Pluto server
     */
    private async syncCellsWithPluto(): Promise<void> {
        for (let i = 0; i < this.notebook.cellCount; i++) {
            const cell = this.notebook.cellAt(i);
            let cellId = getCellId(cell);

            if (!cellId) {
                cellId = generateCellId();
                await setCellId(cell, cellId);
            }
        }
    }

    /**
     * Setup server event handlers
     */
    private setupServerEvents(): void {
        this.server.on('cellState', (cellId: string, state: Partial<CellState>) => {
            this.handleCellState(cellId, state);
        });

        this.server.on('error', (err: Error) => {
            console.error('[PlutoKernel] Server error:', err);
            vscode.window.showErrorMessage(`Pluto error: ${err.message}`);
        });

        this.server.on('closed', () => {
            console.log('[PlutoKernel] Server closed');
            this._isRunning = false;
            this.onStateChange();
        });
    }

    /**
     * Handle cell state update from Pluto
     */
    private handleCellState(cellId: string, state: Partial<CellState>): void {
        console.log(`[PlutoKernel] Cell state update for ${cellId}:`, JSON.stringify(state).slice(0, 200));

        // Track that Pluto knows about this cell
        this.knownCellIds.add(cellId);

        const execution = this.cellExecutions.get(cellId);

        // Track output state
        const existingOutput = this.cellOutputs.get(cellId) || {};

        if (state.output) {
            // For tree+object, don't overwrite existing data with just an objectid
            const isObjectIdOnly = state.output.mime === 'application/vnd.pluto.tree+object' &&
                                   /^[0-9a-f]{16}$/i.test(state.output.body);
            if (isObjectIdOnly && existingOutput.body && existingOutput.mime === 'application/vnd.pluto.tree+object') {
                console.log(`[PlutoKernel] Cell ${cellId} skipping objectid-only update, keeping existing tree data`);
            } else {
                existingOutput.body = state.output.body;
                existingOutput.mime = state.output.mime;
                console.log(`[PlutoKernel] Cell ${cellId} output: ${existingOutput.body?.slice(0, 100)}`);
            }
        }

        if (state.logs) {
            existingOutput.logs = state.logs;
            console.log(`[PlutoKernel] Cell ${cellId} logs:`, state.logs);
        }

        this.cellOutputs.set(cellId, existingOutput);

        // Build outputs
        const outputs: vscode.NotebookCellOutput[] = [];

        // Add logs (stdout) if present
        if (existingOutput.logs && existingOutput.logs.length > 0) {
            const stdoutLogs = existingOutput.logs
                .filter(log => log.level === 'LogLevel(-555)' || !log.level || log.level === '')
                .map(log => log.msg)
                .join('');

            if (stdoutLogs) {
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.stdout(stdoutLogs)
                ]));
            }
        }

        // Add main output if present
        if (existingOutput.body) {
            const mime = existingOutput.mime || 'text/plain';

            if (state.errored || mime === 'application/vnd.pluto.stacktrace+object') {
                // Handle Pluto error stacktrace
                const errorText = this.parseErrorOutput(existingOutput.body, mime);
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.stderr(errorText)
                ]));
                // Show wrap suggestion for "extra token" errors
                if (existingOutput.body.includes('extra token after end of expression')) {
                    this.showWrapSuggestion(cellId);
                }
            } else if (existingOutput.body.includes('extra token after end of expression')) {
                // Handle "multiple expressions" syntax error
                const errorText = this.addErrorHints(existingOutput.body);
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.stderr(errorText)
                ]));
                // Show notification with wrap button
                this.showWrapSuggestion(cellId);
            } else if (existingOutput.body.includes('syntax:')) {
                // Handle other syntax errors
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.stderr(existingOutput.body)
                ]));
            } else if (mime === 'application/vnd.pluto.tree+object') {
                // Pluto's tree object format - render as collapsible HTML
                const treeHtml = this.renderPlutoTreeAsHtml(existingOutput.body);
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(treeHtml, 'text/html')
                ]));
            } else if (mime === 'text/html') {
                // Render HTML - use custom MIME type for Pluto HTML with bonds
                // This triggers our custom renderer which handles interactive elements
                const plutoMime = existingOutput.body.includes('<bond')
                    ? 'application/vnd.pluto.html+html'
                    : 'text/html';
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(existingOutput.body, plutoMime)
                ]));
            } else if (mime === 'image/svg+xml') {
                // SVG is text-based, render as SVG (like julia-vscode)
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(existingOutput.body, 'image/svg+xml')
                ]));
            } else if (mime === 'image/png' || mime === 'image/jpeg') {
                // Binary images: decode base64 to Buffer (like julia-vscode)
                try {
                    const buffer = Buffer.from(existingOutput.body, 'base64');
                    outputs.push(new vscode.NotebookCellOutput([
                        new vscode.NotebookCellOutputItem(buffer, mime)
                    ]));
                } catch {
                    outputs.push(new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text(existingOutput.body, 'text/plain')
                    ]));
                }
            } else if (mime.endsWith('+json')) {
                // JSON-based formats (Vega, Plotly, etc.)
                try {
                    const jsonData = JSON.parse(existingOutput.body);
                    outputs.push(new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.json(jsonData, mime)
                    ]));
                } catch {
                    outputs.push(new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text(existingOutput.body, mime)
                    ]));
                }
            } else {
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(existingOutput.body, mime)
                ]));
            }
        }

        // Update execution output if we have an execution
        if (execution) {
            console.log(`[PlutoKernel] Updating execution for ${cellId} with ${outputs.length} outputs`);
            if (outputs.length > 0) {
                execution.replaceOutput(outputs);
            }

            // End execution if cell is done
            // Check multiple conditions: running=false, or we have runtime (cell completed)
            const shouldEnd = (state.running === false && state.queued !== true) ||
                              (state.runtime !== undefined && outputs.length > 0);

            if (shouldEnd) {
                console.log(`[PlutoKernel] Ending execution for ${cellId} (running=${state.running}, runtime=${state.runtime})`);
                const success = !state.errored;
                execution.end(success, Date.now());
                this.cellExecutions.delete(cellId);
                // Don't delete outputs - keep them for display
            }
        } else {
            // No active execution - this might be initial state from Pluto or reactive update
            // Schedule a debounced direct update to collect all state changes
            console.log(`[PlutoKernel] No execution for ${cellId}, scheduling direct update`);
            this.scheduleDirectUpdate(cellId);
        }
    }

    /**
     * Schedule a debounced direct update for a cell
     * This waits for all state updates to arrive before creating a temp execution
     */
    private scheduleDirectUpdate(cellId: string): void {
        // Clear existing timeout if any
        const existingTimeout = this.pendingDirectUpdates.get(cellId);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
        }

        // Schedule update after 100ms of no new updates
        const timeout = setTimeout(() => {
            this.pendingDirectUpdates.delete(cellId);
            this.executeDirectUpdate(cellId);
        }, 100);

        this.pendingDirectUpdates.set(cellId, timeout);
    }

    /**
     * Execute the actual direct update for a cell
     */
    private async executeDirectUpdate(cellId: string): Promise<void> {
        const existingOutput = this.cellOutputs.get(cellId);
        if (!existingOutput) return;

        // Build outputs from accumulated state
        const outputs: vscode.NotebookCellOutput[] = [];

        // Add logs (stdout) if present
        if (existingOutput.logs && existingOutput.logs.length > 0) {
            const stdoutLogs = existingOutput.logs
                .filter(log => log.level === 'LogLevel(-555)' || !log.level || log.level === '')
                .map(log => log.msg)
                .join('');

            if (stdoutLogs) {
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.stdout(stdoutLogs)
                ]));
            }
        }

        // Add main output if present
        if (existingOutput.body) {
            const mime = existingOutput.mime || 'text/plain';

            if (mime === 'application/vnd.pluto.stacktrace+object') {
                // Handle Pluto error stacktrace
                const errorText = this.parseErrorOutput(existingOutput.body, mime);
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.stderr(errorText)
                ]));
                // Show wrap suggestion for "extra token" errors
                if (existingOutput.body.includes('extra token after end of expression')) {
                    this.showWrapSuggestion(cellId);
                }
            } else if (existingOutput.body.includes('extra token after end of expression')) {
                // Handle "multiple expressions" syntax error
                const errorText = this.addErrorHints(existingOutput.body);
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.stderr(errorText)
                ]));
                // Show notification with wrap button
                this.showWrapSuggestion(cellId);
            } else if (existingOutput.body.includes('syntax:')) {
                // Handle other syntax errors
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.stderr(existingOutput.body)
                ]));
            } else if (mime === 'application/vnd.pluto.tree+object') {
                // Pluto's tree object format - render as collapsible HTML
                const treeHtml = this.renderPlutoTreeAsHtml(existingOutput.body);
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(treeHtml, 'text/html')
                ]));
            } else if (mime === 'text/html') {
                // Render HTML - use custom MIME type for Pluto HTML with bonds
                // This triggers our custom renderer which handles interactive elements
                const plutoMime = existingOutput.body.includes('<bond')
                    ? 'application/vnd.pluto.html+html'
                    : 'text/html';
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(existingOutput.body, plutoMime)
                ]));
            } else if (mime === 'image/svg+xml') {
                // SVG is text-based, render as SVG
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(existingOutput.body, 'image/svg+xml')
                ]));
            } else if (mime === 'image/png' || mime === 'image/jpeg') {
                // Binary images: decode base64 to Buffer
                try {
                    const buffer = Buffer.from(existingOutput.body, 'base64');
                    outputs.push(new vscode.NotebookCellOutput([
                        new vscode.NotebookCellOutputItem(buffer, mime)
                    ]));
                } catch {
                    outputs.push(new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text(existingOutput.body, 'text/plain')
                    ]));
                }
            } else if (mime.endsWith('+json')) {
                // JSON-based formats (Vega, Plotly, etc.)
                try {
                    const jsonData = JSON.parse(existingOutput.body);
                    outputs.push(new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.json(jsonData, mime)
                    ]));
                } catch {
                    outputs.push(new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text(existingOutput.body, mime)
                    ]));
                }
            } else {
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(existingOutput.body, mime)
                ]));
            }
        }

        if (outputs.length === 0) return;

        // Find the cell by ID
        for (let i = 0; i < this.notebook.cellCount; i++) {
            const cell = this.notebook.cellAt(i);
            const id = getCellId(cell);

            if (id === cellId) {
                console.log(`[PlutoKernel] Direct update for ${cellId} at index ${i} with ${outputs.length} outputs`);

                try {
                    // Create a temporary execution to update the output
                    const execution = this.controller.createNotebookCellExecution(cell);
                    execution.start(Date.now());
                    await execution.replaceOutput(outputs);
                    execution.end(true, Date.now());

                    console.log(`[PlutoKernel] Updated cell ${cellId} successfully`);
                } catch (err) {
                    console.error(`[PlutoKernel] Failed to update cell ${cellId}:`, err);
                }
                break;
            }
        }
    }

    /**
     * Parse Pluto's error output format
     */
    private parseErrorOutput(body: string, mime: string): string {
        let errorText = body;

        if (mime === 'application/vnd.pluto.stacktrace+object') {
            try {
                const errorObj = JSON.parse(body);
                // Pluto sends stacktrace as an object with msg field
                if (errorObj.msg) {
                    errorText = errorObj.msg;
                } else if (Array.isArray(errorObj) && errorObj.length > 0) {
                    // Try to extract error message from the structure
                    const firstFrame = errorObj[0];
                    if (firstFrame.msg) {
                        errorText = firstFrame.msg;
                    } else {
                        // Fallback to stringified JSON
                        errorText = JSON.stringify(errorObj, null, 2);
                    }
                } else {
                    // Fallback to stringified JSON
                    errorText = JSON.stringify(errorObj, null, 2);
                }
            } catch {
                // If parsing fails, return as-is
            }
        }

        return this.addErrorHints(errorText);
    }

    /**
     * Parse Pluto's tree object format into a readable string
     * This handles application/vnd.pluto.tree+object mimetype
     */
    private parsePlutoTreeObject(body: string): string {
        // Check if body is just an objectid (hex string) - Pluto sometimes sends this
        if (/^[0-9a-f]{16}$/i.test(body)) {
            console.log('[PlutoKernel] Tree object is just objectid, returning placeholder');
            return '(computing...)';
        }

        try {
            const treeObj = JSON.parse(body);
            console.log('[PlutoKernel] Tree object structure:', JSON.stringify(treeObj, null, 2).substring(0, 3000));
            const result = this.extractPlutoTree(treeObj);
            console.log('[PlutoKernel] Tree object result:', result);
            return result;
        } catch (e) {
            console.log('[PlutoKernel] Tree object parse error:', e);
            // If parsing fails, return as-is (might be plain text)
            return body;
        }
    }

    /**
     * Render Pluto's tree object as collapsible HTML
     * This creates an interactive tree view identical to Pluto.jl
     */
    private renderPlutoTreeAsHtml(body: string): string {
        // Check if body is just an objectid (hex string)
        if (/^[0-9a-f]{16}$/i.test(body)) {
            return '<span style="color: #888; font-style: italic;">(computing...)</span>';
        }

        try {
            const treeObj = JSON.parse(body);
            const treeHtml = this.renderPlutoTree(treeObj, true);

            // Wrap with Pluto-identical styles
            return `
<style>
/* Pluto.jl TreeView CSS - identical to treeview.css */
:root {
    --pluto-tree-color: #1a1a1a;
    --pluto-output-color: #1a1a1a;
    --julia-mono-font-stack: "JuliaMono", "Fira Code", "Roboto Mono", monospace;
}
@media (prefers-color-scheme: dark) {
    :root {
        --pluto-tree-color: #e0e0e0;
        --pluto-output-color: #e0e0e0;
    }
}

pluto-tree, pluto-tree-pair {
    font-family: var(--julia-mono-font-stack);
    font-size: 0.75rem;
}
pluto-tree {
    color: var(--pluto-tree-color);
    white-space: pre;
    cursor: pointer;
}
pluto-tree, pluto-tree-items {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
}
pluto-tree.collapsed, pluto-tree.collapsed pluto-tree, pluto-tree.collapsed pluto-tree-items {
    flex-direction: row;
    align-items: baseline;
}
pluto-tree-items {
    cursor: auto;
}
pluto-tree-prefix {
    display: inline-flex;
    flex-direction: row;
    align-items: baseline;
}

/* Caret icons */
pluto-tree > pluto-tree-prefix::before {
    display: inline-block;
    position: relative;
    content: "▼";
    font-size: 0.6em;
    margin-right: 0.5em;
    opacity: 0.5;
    cursor: pointer;
    transition: transform 0.1s;
}
pluto-tree.collapsed > pluto-tree-prefix::before {
    content: "▶";
}
pluto-tree.collapsed pluto-tree > pluto-tree-prefix::before {
    display: none;
}

pluto-tree p-r > p-v {
    display: inline-flex;
    color: var(--pluto-output-color);
}

/* Hide indices when collapsed */
pluto-tree.collapsed pluto-tree-items.Array > p-r > p-k,
pluto-tree.collapsed pluto-tree-items.Set > p-r > p-k,
pluto-tree.collapsed pluto-tree-items.Tuple > p-r > p-k,
pluto-tree.collapsed pluto-tree-items.struct > p-r > p-k {
    display: none;
}

/* Short/Long prefix toggle */
pluto-tree > pluto-tree-prefix > .long { display: block; }
pluto-tree > pluto-tree-prefix > .short { display: none; }
pluto-tree.collapsed > pluto-tree-prefix > .long { display: none; }
pluto-tree.collapsed > pluto-tree-prefix > .short { display: block; }

/* Indentation */
pluto-tree p-r { margin-left: 1.5em; }
pluto-tree.collapsed p-r { margin-left: 0.5em; }
pluto-tree.collapsed p-r:first-child { margin-left: 0; }

/* Index styling */
pluto-tree pluto-tree-items.Array > p-r > p-k,
pluto-tree pluto-tree-items.Set > p-r > p-k,
pluto-tree pluto-tree-items.Tuple > p-r > p-k {
    margin-right: 0.5em;
    opacity: 0.5;
    user-select: none;
}

/* Brackets - Array */
pluto-tree.Array > pluto-tree-prefix::after { content: "["; }
pluto-tree pluto-tree-items.Array::after { content: "]"; }

/* Brackets - Set */
pluto-tree.Set > pluto-tree-prefix::after { content: "(["; }
pluto-tree pluto-tree-items.Set::after { content: "])"; }

/* Brackets - Tuple, Dict, NamedTuple, struct */
pluto-tree.Tuple > pluto-tree-prefix::after,
pluto-tree.Dict > pluto-tree-prefix::after,
pluto-tree.NamedTuple > pluto-tree-prefix::after,
pluto-tree.struct > pluto-tree-prefix::after { content: "("; }
pluto-tree pluto-tree-items.Tuple::after,
pluto-tree pluto-tree-items.Dict::after,
pluto-tree pluto-tree-items.NamedTuple::after,
pluto-tree pluto-tree-items.struct::after { content: ")"; }

/* Separators */
pluto-tree pluto-tree-items.Array > p-r > p-k::after,
pluto-tree pluto-tree-items.Set > p-r > p-k::after,
pluto-tree pluto-tree-items.Tuple > p-r > p-k::after { content: ":"; }
pluto-tree-pair > p-r > p-k::after,
pluto-tree pluto-tree-items.Dict > p-r > p-k::after { content: " => "; }
pluto-tree pluto-tree-items.NamedTuple > p-r > p-k::after,
pluto-tree pluto-tree-items.struct > p-r > p-k::after { content: " = "; }

/* Commas when collapsed */
pluto-tree.collapsed p-r::after { content: ", "; }
pluto-tree.collapsed p-r:last-child::after { content: ""; }

/* More button */
pluto-tree-more {
    display: inline-block;
    padding: 0.3em 0;
    cursor: pointer;
    opacity: 0.6;
}
pluto-tree-more::before {
    content: "⋮";
    margin-right: 0.3em;
}
pluto-tree.collapsed pluto-tree-more::before {
    content: "⋯";
}
</style>
<script>
document.addEventListener('click', function(e) {
    const tree = e.target.closest('pluto-tree');
    const prefix = e.target.closest('pluto-tree-prefix');
    if (tree && (prefix || e.target === tree)) {
        const parent = tree.parentElement?.closest('pluto-tree');
        if (parent && parent.classList.contains('collapsed')) return;
        tree.classList.toggle('collapsed');
    }
});
</script>
${treeHtml}`;
        } catch (e) {
            console.log('[PlutoKernel] Tree HTML render error:', e);
            return `<pre>${this.escapeHtml(body)}</pre>`;
        }
    }

    /**
     * Render a Pluto tree node - identical to Pluto.jl TreeView component
     */
    private renderPlutoTree(obj: unknown, isRoot: boolean = false): string {
        if (obj === null || obj === undefined) {
            return '<span>nothing</span>';
        }
        if (typeof obj === 'string') {
            return `<span>${this.escapeHtml(obj)}</span>`;
        }
        if (typeof obj === 'number' || typeof obj === 'boolean') {
            return `<span>${obj}</span>`;
        }

        if (typeof obj !== 'object') {
            return `<span>${this.escapeHtml(String(obj))}</span>`;
        }

        const record = obj as Record<string, unknown>;

        // Mimepair output helper
        const mimepairOutput = (pair: unknown): string => {
            if (!Array.isArray(pair) || pair.length !== 2) {
                return this.renderPlutoTree(pair, false);
            }
            const [body, mime] = pair;
            if (mime === 'application/vnd.pluto.tree+object' && body && typeof body === 'object') {
                return this.renderPlutoTree(body, false);
            }
            if (typeof body === 'string') {
                return `<span>${this.escapeHtml(body)}</span>`;
            }
            return this.renderPlutoTree(body, false);
        };

        const plutoType = record.type as string | undefined;
        const prefix = record.prefix as string | undefined;
        const prefixShort = record.prefix_short as string | undefined;
        const collapsedClass = isRoot ? '' : ' collapsed';

        // Handle Pair type
        if (plutoType === 'Pair' && 'key_value' in record) {
            const kv = record.key_value as unknown[];
            if (Array.isArray(kv) && kv.length === 2) {
                return `<pluto-tree-pair><p-r><p-k>${mimepairOutput(kv[0])}</p-k><p-v>${mimepairOutput(kv[1])}</p-v></p-r></pluto-tree-pair>`;
            }
        }

        // Handle circular reference
        if (plutoType === 'circular') {
            return '<span style="opacity: 0.5;">circular reference</span>';
        }

        // Handle collections
        if ('elements' in record && Array.isArray(record.elements)) {
            const elements = record.elements as unknown[];
            const typeClass = plutoType || 'Array';

            const prefixHtml = `<pluto-tree-prefix><span class="long">${this.escapeHtml(prefix || '')}</span><span class="short">${this.escapeHtml(prefixShort || prefix || '')}</span></pluto-tree-prefix>`;

            let itemsHtml = '';

            switch (plutoType) {
                case 'Array':
                case 'Set':
                case 'Tuple':
                    itemsHtml = elements.map(r => {
                        if (r === 'more') {
                            return '<pluto-tree-more>show more</pluto-tree-more>';
                        }
                        const el = r as unknown[];
                        if (!Array.isArray(el) || el.length !== 2) return '';
                        const indexDisplay = plutoType === 'Set' ? '' : `<p-k>${el[0]}</p-k>`;
                        return `<p-r>${indexDisplay}<p-v>${mimepairOutput(el[1] as unknown[])}</p-v></p-r>`;
                    }).join('');
                    break;

                case 'Dict':
                    itemsHtml = elements.map(r => {
                        if (r === 'more') {
                            return '<pluto-tree-more>show more</pluto-tree-more>';
                        }
                        const el = r as unknown[];
                        if (!Array.isArray(el) || el.length !== 2) return '';
                        return `<p-r><p-k>${mimepairOutput(el[0] as unknown[])}</p-k><p-v>${mimepairOutput(el[1] as unknown[])}</p-v></p-r>`;
                    }).join('');
                    break;

                case 'NamedTuple':
                case 'struct':
                    itemsHtml = elements.map(r => {
                        if (r === 'more') {
                            return '<pluto-tree-more>show more</pluto-tree-more>';
                        }
                        const el = r as unknown[];
                        if (!Array.isArray(el) || el.length !== 2) return '';
                        return `<p-r><p-k>${this.escapeHtml(String(el[0]))}</p-k><p-v>${mimepairOutput(el[1] as unknown[])}</p-v></p-r>`;
                    }).join('');
                    break;

                default:
                    // Default handling for unknown types
                    itemsHtml = elements.map(r => {
                        if (r === 'more') {
                            return '<pluto-tree-more>show more</pluto-tree-more>';
                        }
                        const el = r as unknown[];
                        if (!Array.isArray(el) || el.length !== 2) return '';
                        return `<p-r><p-k>${el[0]}</p-k><p-v>${mimepairOutput(el[1] as unknown[])}</p-v></p-r>`;
                    }).join('');
            }

            return `<pluto-tree class="${typeClass}${collapsedClass}">${prefixHtml}<pluto-tree-items class="${typeClass}">${itemsHtml}</pluto-tree-items></pluto-tree>`;
        }

        // Fallback
        if (prefix) {
            return `<span>${this.escapeHtml(prefix)}</span>`;
        }
        if (plutoType) {
            return `<span>&lt;${this.escapeHtml(plutoType)}&gt;</span>`;
        }

        return `<span>${this.escapeHtml(JSON.stringify(obj).substring(0, 100))}</span>`;
    }

    /**
     * Escape HTML special characters
     */
    private escapeHtml(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Extract displayable text from Pluto tree object
     */
    private extractPlutoTree(obj: unknown): string {
        if (obj === null || obj === undefined) return 'nothing';
        if (typeof obj === 'string') return obj;
        if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);

        if (typeof obj !== 'object') return String(obj);

        const record = obj as Record<string, unknown>;

        // Check if it's a mime/body object (leaf value)
        if ('mime' in record && 'body' in record) {
            const body = record.body;
            if (typeof body === 'string') return body;
            return this.extractPlutoTree(body);
        }

        // Get Pluto type
        const plutoType = record.type as string | undefined;

        // Handle circular reference
        if (plutoType === 'circular') {
            return '(circular reference)';
        }

        // Handle Pair
        if (plutoType === 'Pair' && 'key_value' in record) {
            const kv = record.key_value as unknown[];
            if (Array.isArray(kv) && kv.length === 2) {
                return `${this.extractPlutoTree(kv[0])} => ${this.extractPlutoTree(kv[1])}`;
            }
        }

        // Get prefix for type display
        const prefix = (record.prefix_short || record.prefix || '') as string;

        // Handle collections with elements
        if ('elements' in record && Array.isArray(record.elements)) {
            const elements = record.elements as unknown[];
            const filtered = elements.filter(el => el !== 'more');

            if (filtered.length === 0) {
                // Empty collection - show type
                return prefix || `${plutoType || 'Collection'}()`;
            }

            // Extract first few elements
            const items: string[] = [];
            for (let i = 0; i < Math.min(5, filtered.length); i++) {
                const elem = filtered[i];
                items.push(this.extractPlutoElement(elem));
            }

            const hasMore = elements.includes('more') || filtered.length > 5;
            if (hasMore) {
                items.push('...');
            }

            // Format based on type
            const itemsStr = items.join(', ');
            if (plutoType === 'Tuple') return `(${itemsStr})`;
            if (plutoType === 'NamedTuple') return `(${itemsStr})`;
            if (plutoType === 'Dict') return prefix ? `${prefix}(${itemsStr})` : `Dict(${itemsStr})`;
            if (plutoType === 'Set') return prefix ? `${prefix}([${itemsStr}])` : `Set([${itemsStr}])`;
            if (plutoType === 'Array') return prefix ? `${prefix}[${itemsStr}]` : `[${itemsStr}]`;
            if (plutoType === 'struct') return prefix ? `${prefix}(${itemsStr})` : `(${itemsStr})`;

            return prefix ? `${prefix}[${itemsStr}]` : `[${itemsStr}]`;
        }

        // Fallback to prefix/type display
        if (prefix) return prefix;
        if (plutoType) return `<${plutoType}>`;
        if ('objectid' in record) return `<object>`;

        return JSON.stringify(obj).substring(0, 100);
    }

    /**
     * Extract a single element from Pluto tree elements array
     * Pluto format: [index, [body, mime]] for Array/Set/Tuple
     *               [key, value] for Dict (both are mimepairs)
     *               [fieldname, [body, mime]] for struct/NamedTuple
     */
    private extractPlutoElement(elem: unknown): string {
        if (elem === null || elem === undefined) return 'nothing';
        if (typeof elem === 'string') return elem;
        if (typeof elem === 'number' || typeof elem === 'boolean') return String(elem);

        // Handle array element
        if (Array.isArray(elem)) {
            if (elem.length === 2) {
                const [key, value] = elem;

                // Check if value is a mimepair: [body, mime]
                if (Array.isArray(value) && value.length === 2) {
                    const [body, mime] = value;
                    // For arrays with numeric index, just show the value
                    if (typeof key === 'number') {
                        return this.extractMimepairValue(body, mime as string);
                    }
                    // For named fields (struct, NamedTuple), show name = value
                    if (typeof key === 'string') {
                        const valueStr = this.extractMimepairValue(body, mime as string);
                        return `${key} = ${valueStr}`;
                    }
                    // For Dict, key is also a mimepair
                    if (Array.isArray(key) && key.length === 2) {
                        const keyStr = this.extractMimepairValue(key[0], key[1] as string);
                        const valueStr = this.extractMimepairValue(body, mime as string);
                        return `${keyStr} => ${valueStr}`;
                    }
                }

                // Fallback: treat as [key, value] pair
                const valueStr = this.extractPlutoTree(value);
                if (typeof key === 'number') {
                    return valueStr;
                }
                const keyStr = this.extractPlutoTree(key);
                return `${keyStr} = ${valueStr}`;
            }
            // Other arrays
            return elem.map(e => this.extractPlutoTree(e)).join(', ');
        }

        // It's an object - delegate to extractPlutoTree
        return this.extractPlutoTree(elem);
    }

    /**
     * Extract value from Pluto mimepair [body, mime]
     */
    private extractMimepairValue(body: unknown, mime: string): string {
        // If body is a string, return it directly
        if (typeof body === 'string') {
            return body;
        }
        // If body is a tree object, recurse
        if (body && typeof body === 'object') {
            return this.extractPlutoTree(body);
        }
        return String(body);
    }

    /**
     * Add helpful hints for common errors
     */
    private addErrorHints(errorText: string): string {
        // Add helpful hint for "extra token" error (multiple expressions in one cell)
        if (errorText.includes('extra token after end of expression')) {
            errorText += '\n\n💡 Pluto requires each cell to contain a single expression.';
            errorText += '\n   Wrap your code in begin...end to fix this.';
        }

        return errorText;
    }

    /**
     * Show a notification suggesting to wrap cell in begin...end
     */
    private showWrapSuggestion(cellId: string): void {
        // Find the cell index
        let cellIndex = -1;
        for (let i = 0; i < this.notebook.cellCount; i++) {
            const cell = this.notebook.cellAt(i);
            if (getCellId(cell) === cellId) {
                cellIndex = i;
                break;
            }
        }

        if (cellIndex === -1) return;

        // Show notification with button
        vscode.window.showWarningMessage(
            'Pluto requires each cell to contain a single expression. Wrap your code in begin...end?',
            'Wrap in begin...end',
            'Dismiss'
        ).then(async (selection) => {
            if (selection === 'Wrap in begin...end') {
                // Select the cell and run the wrap command
                const notebookEditor = vscode.window.activeNotebookEditor;
                if (notebookEditor && notebookEditor.notebook.uri.toString() === this.notebook.uri.toString()) {
                    // Select the cell
                    const range = new vscode.NotebookRange(cellIndex, cellIndex + 1);
                    notebookEditor.selections = [range];
                    // Run the wrap command
                    await vscode.commands.executeCommand('pluto-notebook.wrapInBeginEnd');
                }
            }
        });
    }

    dispose(): void {
        this.stop();
    }
}

/**
 * NotebookController for Pluto notebooks
 */
export class PlutoNotebookController implements vscode.Disposable {
    private controller: vscode.NotebookController;
    private kernels = new Map<string, PlutoKernel>();
    private disposables: vscode.Disposable[] = [];

    /**
     * Set a bond value for a notebook (for interactive widgets like Slider)
     */
    async setBond(notebook: vscode.NotebookDocument, name: string, value: unknown): Promise<void> {
        const key = notebook.uri.toString();
        const kernel = this.kernels.get(key);
        if (kernel && kernel.isRunning) {
            await kernel.setBond(name, value);
        } else {
            console.log('[PlutoController] Cannot set bond, kernel not running');
        }
    }

    constructor() {
        this.controller = vscode.notebooks.createNotebookController(
            'pluto-kernel',
            NOTEBOOK_TYPE,
            'Pluto.jl'
        );

        this.controller.supportedLanguages = ['julia'];
        this.controller.supportsExecutionOrder = true;
        this.controller.description = 'Reactive Julia notebook kernel powered by Pluto.jl';

        this.controller.executeHandler = this.executeHandler.bind(this);
        this.controller.interruptHandler = this.interruptHandler.bind(this);

        // Listen for notebook changes
        this.disposables.push(
            vscode.workspace.onDidChangeNotebookDocument(e => {
                this.handleNotebookChange(e);
            })
        );

        // Listen for notebook close
        this.disposables.push(
            vscode.workspace.onDidCloseNotebookDocument(notebook => {
                this.disposeKernel(notebook.uri.toString());
            })
        );
    }

    /**
     * Execute handler called by VS Code when user runs cells
     */
    private async executeHandler(
        cells: vscode.NotebookCell[],
        notebook: vscode.NotebookDocument,
        _controller: vscode.NotebookController
    ): Promise<void> {
        const kernel = await this.getOrCreateKernel(notebook);
        await kernel.executeCells(cells);
    }

    /**
     * Interrupt handler called by VS Code when user stops execution
     */
    private async interruptHandler(notebook: vscode.NotebookDocument): Promise<void> {
        console.log('[PlutoController] Interrupt requested for', notebook.uri.fsPath);
        const key = notebook.uri.toString();
        const kernel = this.kernels.get(key);
        if (kernel) {
            await kernel.interrupt();
        }
    }

    /**
     * Get or create kernel for a notebook
     */
    private async getOrCreateKernel(notebook: vscode.NotebookDocument): Promise<PlutoKernel> {
        const key = notebook.uri.toString();

        if (!this.kernels.has(key)) {
            const kernel = new PlutoKernel(
                this.controller,
                notebook,
                () => this.updateContextState()
            );
            this.kernels.set(key, kernel);
        }

        return this.kernels.get(key)!;
    }

    /**
     * Start kernel for a notebook
     */
    async startKernel(notebook: vscode.NotebookDocument): Promise<void> {
        const kernel = await this.getOrCreateKernel(notebook);
        await kernel.start();
    }

    /**
     * Stop kernel for a notebook
     */
    async stopKernel(notebook: vscode.NotebookDocument): Promise<void> {
        const key = notebook.uri.toString();
        const kernel = this.kernels.get(key);
        if (kernel) {
            await kernel.stop();
        }
    }

    /**
     * Restart kernel for a notebook
     */
    async restartKernel(notebook: vscode.NotebookDocument): Promise<void> {
        const key = notebook.uri.toString();
        const kernel = this.kernels.get(key);
        if (kernel) {
            await kernel.restart();
        }
    }

    /**
     * Check if kernel is running for a notebook
     */
    isKernelRunning(notebook: vscode.NotebookDocument): boolean {
        const key = notebook.uri.toString();
        const kernel = this.kernels.get(key);
        return kernel?.isRunning ?? false;
    }

    /**
     * Handle notebook document changes
     */
    private async handleNotebookChange(e: vscode.NotebookDocumentChangeEvent): Promise<void> {
        const key = e.notebook.uri.toString();
        const kernel = this.kernels.get(key);
        if (kernel && kernel.isRunning) {
            await kernel.handleNotebookChange(e);
        }
    }

    /**
     * Dispose kernel for a notebook
     */
    private disposeKernel(key: string): void {
        const kernel = this.kernels.get(key);
        if (kernel) {
            kernel.dispose();
            this.kernels.delete(key);
        }
    }

    /**
     * Update VS Code context for menu visibility
     */
    private updateContextState(): void {
        // Check if any kernel is running
        let anyRunning = false;
        for (const kernel of this.kernels.values()) {
            if (kernel.isRunning) {
                anyRunning = true;
                break;
            }
        }
        vscode.commands.executeCommand('setContext', 'pluto.kernelRunning', anyRunning);
    }

    dispose(): void {
        for (const kernel of this.kernels.values()) {
            kernel.dispose();
        }
        this.kernels.clear();
        this.controller.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
