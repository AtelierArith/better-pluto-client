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
    private cellTimeouts = new Map<string, NodeJS.Timeout>();  // Execution timeouts by cell ID
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

        // Clear all execution timeouts
        for (const timeoutId of this.cellTimeouts.values()) {
            clearTimeout(timeoutId);
        }
        this.cellTimeouts.clear();

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

        // Clear all execution timeouts
        for (const timeoutId of this.cellTimeouts.values()) {
            clearTimeout(timeoutId);
        }
        this.cellTimeouts.clear();

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
            // Clear existing timeout
            const existingTimeout = this.cellTimeouts.get(cellId);
            if (existingTimeout) {
                clearTimeout(existingTimeout);
                this.cellTimeouts.delete(cellId);
            }
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

        // Set up a timeout to prevent hanging executions (30 seconds)
        const timeoutId = setTimeout(() => {
            const exec = this.cellExecutions.get(cellId);
            if (exec) {
                console.log(`[PlutoKernel] Execution timeout for ${cellId}`);
                exec.replaceOutput([
                    new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.stderr('Execution timed out. Check Pluto server status.')
                    ])
                ]);
                exec.end(false, Date.now());
                this.cellExecutions.delete(cellId);
                this.cellTimeouts.delete(cellId);
            }
        }, 30000);

        // Store timeout to clear it later
        this.cellTimeouts.set(cellId, timeoutId);

        // Update cell code in Pluto and run
        try {
            // Check if Pluto knows about this cell
            if (!this.knownCellIds.has(cellId)) {
                console.log(`[PlutoKernel] Cell ${cellId} is new to Pluto, adding at index ${cell.index}`);
                await this.server.addCell(cellId, cell.index, code);
                this.knownCellIds.add(cellId);
            }

            console.log(`[PlutoKernel] Sending updateCell for ${cellId}`);
            await this.server.updateCell(cellId, code);
            console.log(`[PlutoKernel] Sending runCell for ${cellId}`);
            await this.server.runCell(cellId);
            console.log(`[PlutoKernel] runCell completed for ${cellId}`);
        } catch (err) {
            console.error('[PlutoKernel] Failed to run cell:', err);
            clearTimeout(timeoutId);
            this.cellTimeouts.delete(cellId);
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
            existingOutput.body = state.output.body;
            existingOutput.mime = state.output.mime;
            console.log(`[PlutoKernel] Cell ${cellId} output: ${existingOutput.body?.slice(0, 100)}`);
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

            if (state.errored) {
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.error(new Error(existingOutput.body))
                ]));
            } else if (mime === 'text/html') {
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(existingOutput.body, 'text/html')
                ]));
            } else if (mime.startsWith('image/')) {
                // Handle image output - body is base64 encoded
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
                // Clear timeout
                const timeoutId = this.cellTimeouts.get(cellId);
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    this.cellTimeouts.delete(cellId);
                }
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

            if (mime === 'text/html') {
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(existingOutput.body, 'text/html')
                ]));
            } else if (mime.startsWith('image/')) {
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
