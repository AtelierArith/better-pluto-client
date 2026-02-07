/**
 * PlutoNotebookController - Handle cell execution with Pluto.jl kernel
 */

import * as vscode from 'vscode';
import { PlutoServer, CellState, LogEntry } from './PlutoServer';
import { getCellId, setCellId } from './PlutoNotebookSerializer';
import { generateCellId, parse as parsePlutoNotebook } from './PlutoNotebookParser';
import { isPlutoObjectId, escapeHtml } from './output-utils';
import { accumulateExecutionState, shouldEndExecution } from './cell-state-machine';
import { type NotebookOutputAdapter, VscodeNotebookOutputAdapter } from './notebook-output-adapter';
import * as fs from 'fs';
import { log } from './extension';

const NOTEBOOK_TYPE = 'pluto-notebook';

/**
 * Manages Pluto kernel for a notebook
 */
class PlutoKernel {
    private server: PlutoServer;
    private _isRunning = false;
    private cellExecutions = new Map<string, vscode.NotebookCellExecution>();
    private cellOutputs = new Map<string, { body?: string; mime?: string; logs?: LogEntry[]; lastCode?: string }>();
    private pendingDirectUpdates = new Map<string, NodeJS.Timeout>();  // Debounced direct updates
    private lastStateUpdateAt = new Map<string, number>();  // Track last state update per cell
    private pendingStateSync = new Map<string, NodeJS.Timeout>();  // Missing update fallback
    private cellExecStates = new Map<string, { running?: boolean; queued?: boolean; errored?: boolean; runtime?: number }>();  // Accumulated execution state for completion detection
    private knownCellIds = new Set<string>();  // Cell IDs that Pluto knows about
    private outputAdapter: NotebookOutputAdapter;

    constructor(
        private controller: vscode.NotebookController,
        private notebook: vscode.NotebookDocument,
        private onStateChange: () => void
    ) {
        this.server = new PlutoServer();
        this.outputAdapter = new VscodeNotebookOutputAdapter({
            parseError: (body, mime) => this.parseErrorOutput(body, mime),
            addErrorHints: (body) => this.addErrorHints(body),
            renderTreeAsHtml: (body, cellId) => this.renderPlutoTreeAsHtml(body, cellId),
        });
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
        if (this._isRunning) {return;}

        log(`[BetterPlutoKernel] Starting kernel for ${this.notebook.uri.fsPath}`);

        try {
            await this.server.start(this.notebook.uri.fsPath);
            this._isRunning = true;
            this.onStateChange();

            // Sync cells with Pluto
            await this.syncCellsWithPluto();

            // Run all cells after sync to ensure they are executed
            await this.runAllCellsOnStart();

        } catch (err) {
            console.error('[BetterPlutoKernel] Failed to start:', err);
            throw err;
        }
    }

    /**
     * Run all cells after kernel starts (to ensure initial execution).
     * Creates VS Code execution objects for each cell so that results
     * from Pluto are rendered through the normal handleCellState path
     * instead of the unreliable debounced direct-update fallback.
     */
    private async runAllCellsOnStart(): Promise<void> {
        const cellIds: string[] = [];
        for (let i = 0; i < this.notebook.cellCount; i++) {
            const cell = this.notebook.cellAt(i);
            const cellId = getCellId(cell);
            if (cellId) {
                cellIds.push(cellId);

                // End any existing execution
                const existingExecution = this.cellExecutions.get(cellId);
                if (existingExecution) {
                    try { existingExecution.end(false, Date.now()); } catch {}
                }

                try {
                    // Create execution object so results are properly rendered.
                    // May throw if controller is not associated with this notebook (e.g. in E2E before kernel selection).
                    const execution = this.controller.createNotebookCellExecution(cell);
                    this.cellExecutions.set(cellId, execution);
                    this.cellExecStates.set(cellId, {});
                    // DON'T delete cellOutputs here - Pluto may have already sent initial state
                    // with output data that we want to preserve and display.
                    // The handleCellState will use this cached output when rendering.

                    execution.start(Date.now());
                    // Don't clear output - if there's cached output from initial state, keep it
                    // execution.clearOutput();
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (msg.includes('not associated') || msg.includes('NOT associated')) {
                        log(`[BetterPlutoKernel] Controller not associated with notebook, skipping execution objects for runAllCellsOnStart (outputs will use direct updates)`);
                    } else {
                        throw err;
                    }
                }
            }
        }

        // If Pluto already sent initial state with outputs before we created executions,
        // render those cached outputs now
        for (const cellId of cellIds) {
            const cachedOutput = this.cellOutputs.get(cellId);
            if (cachedOutput && cachedOutput.body) {
                log(`[BetterPlutoKernel] Rendering cached output for ${cellId} (received before execution was created)`);
                const execution = this.cellExecutions.get(cellId);
                if (execution) {
                    const outputs = this.buildOutputsFromCache(cellId, cachedOutput);
                    if (outputs.length > 0) {
                        execution.replaceOutput(outputs);
                    }
                }
            }
        }

        if (cellIds.length > 0) {
            log(`[BetterPlutoKernel] Running all ${cellIds.length} cells on startup (with execution objects)`);
            // Run all cells at once using run_multiple_cells
            await this.server.runMultipleCells(cellIds);
        }
    }

    /**
     * Stop the Pluto kernel
     */
    async stop(): Promise<void> {
        log('[BetterPlutoKernel] Stopping kernel');
        this.server.stop();
        this._isRunning = false;

        // Clear pending direct updates
        for (const timeout of this.pendingDirectUpdates.values()) {
            clearTimeout(timeout);
        }
        this.pendingDirectUpdates.clear();
        for (const timeout of this.pendingStateSync.values()) {
            clearTimeout(timeout);
        }
        this.pendingStateSync.clear();
        for (const timeout of this.foldChangingTimers.values()) {
            clearTimeout(timeout);
        }
        this.foldChangingTimers.clear();
        this.foldChangingCellIds.clear();

        // End all running executions
        for (const [cellId, execution] of this.cellExecutions) {
            try {
                execution.end(false, Date.now());
            } catch {}
        }
        this.cellExecutions.clear();
        this.cellExecStates.clear();

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
        log('[BetterPlutoKernel] Interrupting execution');

        // Send interrupt to Pluto server
        if (this._isRunning) {
            await this.server.interruptAll();
        }

        // End all running executions
        for (const [cellId, execution] of this.cellExecutions) {
            console.log(`[BetterPlutoKernel] Ending execution for ${cellId} due to interrupt`);
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
        this.cellExecStates.clear();
    }

    /**
     * Set a bond value (for interactive widgets like Slider)
     */
    async setBond(name: string, value: unknown): Promise<void> {
        if (!this._isRunning) {
            log('[BetterPlutoKernel] Cannot set bond, kernel not running');
            return;
        }
        console.log(`[BetterPlutoKernel] Setting bond ${name} to`, value);
        await this.server.setBond(name, value);
    }

    /**
     * Request Pluto to expand tree/table output for a specific object.
     */
    async reshowCell(cellId: string, objectid: string, dim: number): Promise<void> {
        if (!this._isRunning) {
            log('[BetterPlutoKernel] Cannot reshow cell output, kernel not running');
            return;
        }
        console.log(`[BetterPlutoKernel] Reshowing cell output: cell=${cellId}, objectid=${objectid}, dim=${dim}`);
        await this.server.reshowCell(cellId, objectid, dim);
    }

    /**
     * Update cell order (for drag-and-drop reordering)
     */
    async updateCellOrder(newOrder: string[]): Promise<void> {
        if (!this._isRunning) {
            log('[BetterPlutoKernel] Cannot update cell order, kernel not running');
            return;
        }
        console.log(`[BetterPlutoKernel] Updating cell order: ${newOrder.length} cells`);
        await this.server.updateCellOrder(newOrder);
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
            // start() already ran all cells with proper execution objects via
            // runAllCellsOnStart(), so skip re-running to avoid overlapping runs
            log(`[BetterPlutoKernel] Kernel just started, skipping redundant execution (all cells already running)`);
            return;
        }

        if (cells.length === 1) {
            // Single cell: use existing method
            await this.executeCell(cells[0]);
        } else {
            // Multiple cells (Run All): batch execution
            await this.executeCellsBatch(cells);
        }
    }

    /**
     * Execute multiple cells in batch (more efficient for Run All)
     */
    private async executeCellsBatch(cells: vscode.NotebookCell[]): Promise<void> {
        const cellIds: string[] = [];
        const executions: Map<string, vscode.NotebookCellExecution> = new Map();

        console.log(`[BetterPlutoKernel] Batch: preparing ${cells.length} cells for execution`);
        // Prepare all cells: ensure IDs, create executions, update code
        for (const cell of cells) {
            console.log(`[BetterPlutoKernel] Batch: processing cell, content preview: ${cell.document.getText().slice(0, 50)}`);
            let cellId = getCellId(cell);
            if (!cellId) {
                cellId = generateCellId();
                await setCellId(cell, cellId);
            }

            // End any existing execution
            const existingExecution = this.cellExecutions.get(cellId);
            if (existingExecution) {
                try { existingExecution.end(false, Date.now()); } catch {}
                this.cellExecutions.delete(cellId);
            }

            // Create execution (for both code and markdown cells)
            const execution = this.controller.createNotebookCellExecution(cell);
            this.cellExecutions.set(cellId, execution);
            this.cellExecStates.set(cellId, {});
            executions.set(cellId, execution);

            // Reset cached outputs so stale values don't leak
            this.cellOutputs.delete(cellId);

            execution.start(Date.now());
            execution.clearOutput();

            cellIds.push(cellId);

            // Update cell code in Pluto (md"""...""" cells already have the wrapper)
            const code = cell.document.getText();
            console.log(`[BetterPlutoKernel] Batch: updating cell ${cellId}`);
            await this.server.updateCell(cellId, code);
        }

        // Run all cells at once
        console.log(`[BetterPlutoKernel] Batch: running ${cellIds.length} cells`);
        await this.server.runMultipleCells(cellIds);
        console.log(`[BetterPlutoKernel] Batch: run request sent`);
    }

    /**
     * Execute a single cell
     */
    private async executeCell(cell: vscode.NotebookCell): Promise<void> {
        // Ensure cell has an ID
        let cellId = getCellId(cell);
        let createdId = false;
        if (!cellId) {
            cellId = generateCellId();
            await setCellId(cell, cellId);
            createdId = true;
        }

        // Get cell code (md"""...""" cells already have the wrapper)
        const code = cell.document.getText();
        log(`[BetterPlutoKernel] executeCell called for ${cellId}, code: "${code.slice(0, 50)}..."`);
        log(`[BetterPlutoKernel] executeCell length=${code.length}, language=${cell.document.languageId}`);

        // End any existing execution for this cell (prevent duplicates)
        const existingExecution = this.cellExecutions.get(cellId);
        if (existingExecution) {
            console.log(`[BetterPlutoKernel] Ending previous execution for ${cellId}`);
            try {
                existingExecution.end(false, Date.now());
            } catch {}
            this.cellExecutions.delete(cellId);
        }

        // Only clear cached outputs if code has actually changed
        // Pluto may not re-send output for unchanged code (optimization)
        // If lastCode is not set (cell was executed by Pluto before we tracked it), 
        // preserve existing output and just update lastCode
        const cachedOutput = this.cellOutputs.get(cellId);
        const hasLastCode = cachedOutput && cachedOutput.lastCode !== undefined;
        const codeChanged = hasLastCode && cachedOutput.lastCode !== code;
        if (codeChanged) {
            this.cellOutputs.delete(cellId);
        } else if (cachedOutput && !hasLastCode) {
            // Update lastCode for existing output that was set before tracking
            cachedOutput.lastCode = code;
        }

        // Create execution
        const execution = this.controller.createNotebookCellExecution(cell);
        this.cellExecutions.set(cellId, execution);
        this.cellExecStates.set(cellId, {});

        execution.start(Date.now());
        // Only clear output if code actually changed - preserve existing output for re-runs
        if (codeChanged) {
            execution.clearOutput();
            // Initialize cellOutputs with lastCode for tracking
            this.cellOutputs.set(cellId, { lastCode: code });
        } else if (!cachedOutput) {
            // New cell without cached output - initialize with lastCode
            this.cellOutputs.set(cellId, { lastCode: code });
        }

        // Note: Timeout disabled - Pluto executions can take a long time for compilation

        // Update cell code in Pluto and run
        // plutoId will be the actual ID Pluto knows about (may differ from VS Code cellId)
        let plutoId = this.server.getPlutoCellId(cellId);
        
        try {
            if (createdId) {
                // Make sure the new cell is included in cell_order before updates
                await this.syncCellOrder();
            }
            // Use server.isKnownCell to check if Pluto knows about this cell
            if (!this.server.isKnownCell(cellId)) {
                log(`[BetterPlutoKernel] Cell ${cellId} not known to Pluto, saving notebook to trigger auto-reload`);
                
                // Save the notebook file - this will write the new cell to the file
                // Pluto's auto_reload_from_file will detect the change and add the cell
                const notebook = cell.notebook;
                await notebook.save();
                log(`[BetterPlutoKernel] Notebook saved, waiting for Pluto to detect new cell`);
                
                // Wait for Pluto to recognize the cell (via auto-reload)
                plutoId = await this.server.waitForCellToAppear(cellId, code);
                log(`[BetterPlutoKernel] Cell recognized by Pluto with ID: ${plutoId}`);
                
                // Transfer tracking to use Pluto's ID if different
                if (plutoId !== cellId) {
                    this.cellExecutions.set(plutoId, execution);
                    this.cellExecutions.delete(cellId);
                    this.cellExecStates.set(plutoId, this.cellExecStates.get(cellId) || {});
                    this.cellExecStates.delete(cellId);
                    this.cellOutputs.set(plutoId, this.cellOutputs.get(cellId) || { lastCode: code });
                    this.cellOutputs.delete(cellId);
                }
            } else {
                log(`[BetterPlutoKernel] Sending updateCell for ${plutoId}`);
                await this.server.updateCell(plutoId, code);
            }
            log(`[BetterPlutoKernel] Sending runCell for ${plutoId}`);
            await this.server.runCell(plutoId);
            log(`[BetterPlutoKernel] runCell completed for ${plutoId}`);
            this.scheduleStateSync(plutoId);
        } catch (err) {
            console.error('[BetterPlutoKernel] Failed to run cell:', err);
            execution.replaceOutput([
                new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.error(err as Error)
                ])
            ]);
            execution.end(false, Date.now());
            this.cellExecutions.delete(cellId);
        }
    }

    // Track cells that have been modified since last save
    private modifiedCellIds = new Set<string>();

    // Track cells that are being folded/unfolded (changes should be ignored)
    private foldChangingCellIds = new Set<string>();
    private foldChangingTimers = new Map<string, NodeJS.Timeout>();

    /**
     * Mark a cell as undergoing fold/unfold change.
     * Changes to this cell will be ignored in modifiedCellIds.
     */
    markCellAsFoldChanging(cellId: string): void {
        this.foldChangingCellIds.add(cellId);

        const existingTimer = this.foldChangingTimers.get(cellId);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // Auto-clear after a short delay to handle any edge cases.
        // 500ms was occasionally too short on slower environments.
        const timeout = setTimeout(() => {
            this.foldChangingCellIds.delete(cellId);
            this.foldChangingTimers.delete(cellId);
        }, 2000);
        this.foldChangingTimers.set(cellId, timeout);
    }

    /**
     * Handle notebook changes (cell added/removed/reordered/modified)
     */
    async handleNotebookChange(e: vscode.NotebookDocumentChangeEvent): Promise<void> {
        if (!this._isRunning) {return;}

        const removedCellIds: string[] = [];
        const addedCells: { cellId: string; code: string; index: number }[] = [];

        // Collect removed and added cells
        for (const change of e.contentChanges) {
            for (const cell of change.removedCells) {
                const cellId = getCellId(cell);
                if (cellId) {
                    removedCellIds.push(cellId);
                    this.knownCellIds.delete(cellId);
                    this.cellOutputs.delete(cellId);
                    this.modifiedCellIds.delete(cellId);
                }
            }

            for (let i = 0; i < change.addedCells.length; i++) {
                const cell = change.addedCells[i];
                let cellId = getCellId(cell);

                if (!cellId) {
                    cellId = generateCellId();
                    await setCellId(cell, cellId);
                }

                // Store cell info for later processing (before metadata might be lost)
                addedCells.push({
                    cellId,
                    code: cell.document.getText(),
                    index: change.range.start + i
                });
                this.knownCellIds.add(cellId);
            }
        }

        // Track cell content changes (for Cmd+S execution)
        // Skip cells that are being folded/unfolded (their \n changes should not trigger re-execution)
        for (const cellChange of e.cellChanges) {
            if (cellChange.document) {
                const cellId = getCellId(cellChange.cell);
                if (cellId && !this.foldChangingCellIds.has(cellId)) {
                    this.modifiedCellIds.add(cellId);
                }
            }
        }

        const addedCellIds = addedCells.map(c => c.cellId);

        // Detect if this is a move operation (same cells removed and added)
        const isMove = removedCellIds.length > 0 &&
                       addedCellIds.length > 0 &&
                       removedCellIds.length === addedCellIds.length &&
                       removedCellIds.every(id => addedCellIds.includes(id));

        if (isMove) {
            // For move operations, just update the cell order
            log('[BetterPlutoKernel] Cell move detected, updating order');
            await this.syncCellOrder();
        } else {
            // Handle actual removals - delete cells from Pluto
            for (const cellId of removedCellIds) {
                if (!addedCellIds.includes(cellId)) {
                    log(`[BetterPlutoKernel] Removing cell ${cellId}`);
                    await this.server.deleteCellOnly(cellId);
                }
            }

            // DON'T add new cells to Pluto here!
            // New cells will be added to Pluto when they are first executed (in executeCell).
            // This avoids race conditions when Shift+Enter triggers both cell execution
            // and new cell creation simultaneously.
            // We just track them locally for now.
            for (const { cellId } of addedCells) {
                if (!removedCellIds.includes(cellId)) {
                    log(`[BetterPlutoKernel] New cell ${cellId} tracked locally (will be added to Pluto on first execution)`);
                }
            }

            // Only sync cell order if we had removals (not additions)
            // Additions will sync when the cell is executed
            if (removedCellIds.length > 0) {
                await this.syncCellOrder();
            }
        }
    }

    /**
     * Handle notebook save - execute modified cells
     */
    async handleNotebookSave(): Promise<void> {
        console.log(`[BetterPlutoKernel] handleNotebookSave called, isRunning=${this._isRunning}, modifiedCells=${this.modifiedCellIds.size}`);
        if (!this._isRunning) {return;}

        if (this.modifiedCellIds.size === 0) {
            log('[BetterPlutoKernel] No modified cells to execute on save');
            return;
        }

        console.log(`[BetterPlutoKernel] Executing ${this.modifiedCellIds.size} modified cells on save`);

        // Find the cells to execute
        const cellsToExecute: vscode.NotebookCell[] = [];
        for (let i = 0; i < this.notebook.cellCount; i++) {
            const cell = this.notebook.cellAt(i);
            const cellId = getCellId(cell);
            if (cellId && this.modifiedCellIds.has(cellId)) {
                cellsToExecute.push(cell);
            }
        }

        // Clear modified cells before execution
        this.modifiedCellIds.clear();

        // Execute the cells
        if (cellsToExecute.length > 0) {
            await this.executeCells(cellsToExecute);
        }
    }

    /**
     * Sync current cell order with Pluto server.
     * Only includes cells that are already known to Pluto (have cell_inputs registered).
     * New cells should be added via addCellOnly which updates cell_order atomically.
     */
    private async syncCellOrder(): Promise<void> {
        // Get current cell order from notebook, but only include cells known to Pluto
        const currentOrder: string[] = [];
        const skippedCells: string[] = [];
        for (let i = 0; i < this.notebook.cellCount; i++) {
            const cell = this.notebook.cellAt(i);
            const cellId = getCellId(cell);
            if (cellId) {
                if (this.server.isKnownCell(cellId)) {
                    // Only include cells that Pluto already knows about
                    currentOrder.push(cellId);
                } else {
                    // Track cells not yet registered with Pluto
                    skippedCells.push(cellId);
                }
            }
        }
        if (skippedCells.length > 0) {
            log(`[BetterPlutoKernel] syncCellOrder: skipping unknown cells: [${skippedCells.join(', ')}]`);
        }
        log(`[BetterPlutoKernel] syncCellOrder: known cells=[${currentOrder.join(', ')}], notebook has ${this.notebook.cellCount} cells`);

        const serverOrder = this.server.getCellOrder();

        // Only update if order actually changed
        const sameOrder = currentOrder.length === serverOrder.length &&
                          currentOrder.every((id, idx) => serverOrder[idx] === id);

        if (!sameOrder) {
            log('[BetterPlutoKernel] Syncing cell order with Pluto');
            log(`[BetterPlutoKernel] Current order: ${JSON.stringify(currentOrder)}`);
            await this.server.updateCellOrder(currentOrder);
        }
    }

    /**
     * Sync all cells with Pluto server
     * Adds new cells and updates code only for cells whose code differs
     * from the file on disk (which Pluto loaded). This avoids unnecessary
     * update_notebook messages that trigger redundant save+run cycles.
     */
    private async syncCellsWithPluto(): Promise<void> {
        // Wait a bit for Pluto's initial state to be received via reset_shared_state
        await new Promise(resolve => setTimeout(resolve, 500));

        // Read the file to compare VS Code's cell code against what Pluto loaded
        let fileCells: Map<string, { code: string }> | null = null;
        try {
            const fileContent = fs.readFileSync(this.notebook.uri.fsPath, 'utf-8');
            const parsed = parsePlutoNotebook(fileContent);
            fileCells = parsed.cells;
        } catch (err) {
            log(`[BetterPlutoKernel] Could not read file for sync comparison: ${err}`);
        }

        for (let i = 0; i < this.notebook.cellCount; i++) {
            const cell = this.notebook.cellAt(i);

            let cellId = getCellId(cell);

            if (!cellId) {
                cellId = generateCellId();
                await setCellId(cell, cellId);
            }

            const code = cell.document.getText();

            if (!this.server.isKnownCell(cellId)) {
                log(`[BetterPlutoKernel] Adding new cell ${cellId} to Pluto`);
                await this.server.addCellOnly(cellId, code);
            } else {
                // Only sync if VS Code's code differs from the file (which Pluto loaded)
                const fileCode = fileCells?.get(cellId)?.code || '';
                if (code !== fileCode) {
                    log(`[BetterPlutoKernel] Syncing changed code for cell ${cellId}`);
                    await this.server.updateCell(cellId, code);
                } else {
                    log(`[BetterPlutoKernel] Cell ${cellId} code matches file, skipping sync`);
                }
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
            console.error('[BetterPlutoKernel] Server error:', err);
            vscode.window.showErrorMessage(`Pluto error: ${err.message}`);
        });

        this.server.on('closed', () => {
            log('[BetterPlutoKernel] Server closed');
            this._isRunning = false;
            this.onStateChange();
        });

    }

    /**
     * Handle cell state update from Pluto
     */
    private handleCellState(cellId: string, state: Partial<CellState>): void {
        log(`[BetterPlutoKernel] Cell state update for ${cellId}: ${JSON.stringify(state).slice(0, 200)}`);
        log(`[BetterPlutoKernel] State details for ${cellId}: running=${state.running}, queued=${state.queued}, errored=${state.errored}, runtime=${state.runtime}`);
        this.lastStateUpdateAt.set(cellId, Date.now());

        // Accumulate execution state for completion detection.
        // Pluto sends partial updates (e.g., only queued=false) in separate events.
        // For unchanged cells, Pluto may skip running/runtime diffs entirely,
        // so we accumulate all fields to detect completion from combined state.
        const execState = this.cellExecStates.get(cellId);
        if (execState) {
            this.cellExecStates.set(cellId, accumulateExecutionState(execState, state));
        }

        // Use accumulated state for completion checks when an execution is active
        const checkState = this.cellExecStates.get(cellId) || state;

        // Only clear pending state sync if this update will actually end the execution
        // Otherwise keep the fallback timer running
        const willEndExecution = shouldEndExecution(checkState);
        
        if (willEndExecution) {
            const pending = this.pendingStateSync.get(cellId);
            if (pending) {
                clearTimeout(pending);
                this.pendingStateSync.delete(cellId);
                log(`[BetterPlutoKernel] Cleared pending state sync for ${cellId} (execution will end)`);
            }
        }

        // Track that Pluto knows about this cell
        this.knownCellIds.add(cellId);

        const execution = this.cellExecutions.get(cellId);

        // Track output state
        const existingOutput = this.cellOutputs.get(cellId) || {};

        if (state.output) {
            // For tree+object, don't overwrite existing data with just an objectid
            const isObjectIdOnly = state.output.mime === 'application/vnd.pluto.tree+object' &&
                                   isPlutoObjectId(state.output.body);
            // Don't overwrite non-empty output with empty output
            const isEmptyOverwrite = !state.output.body && existingOutput.body;
            
            if (isObjectIdOnly && existingOutput.body && existingOutput.mime === 'application/vnd.pluto.tree+object') {
                log(`[BetterPlutoKernel] Cell ${cellId} skipping objectid-only update, keeping existing tree data`);
            } else if (isEmptyOverwrite) {
                log(`[BetterPlutoKernel] Cell ${cellId} skipping empty output update, keeping existing: ${existingOutput.body?.slice(0, 50)}`);
            } else {
                existingOutput.body = state.output.body;
                existingOutput.mime = state.output.mime;
                log(`[BetterPlutoKernel] Cell ${cellId} output - mime: ${state.output.mime}, body preview: ${existingOutput.body?.slice(0, 100)}`);
            }
        }

        if (state.logs) {
            // Avoid wiping existing logs with empty arrays (full state often omits stdout)
            if (state.logs.length > 0 || !existingOutput.logs || existingOutput.logs.length === 0) {
                existingOutput.logs = state.logs;
            }
            console.log(`[BetterPlutoKernel] Cell ${cellId} logs:`, state.logs);
        }

        this.cellOutputs.set(cellId, existingOutput);

        const outputs = this.outputAdapter.toNotebookOutputs(cellId, existingOutput);
        if (existingOutput.body && existingOutput.body.includes('extra token after end of expression')) {
            this.showWrapSuggestion(cellId);
        }

        // Update execution output if we have an execution
        if (execution) {
            log(`[BetterPlutoKernel] Updating execution for ${cellId} with ${outputs.length} outputs`);
            if (outputs.length > 0) {
                execution.replaceOutput(outputs);
            }

            // End execution if cell is done (using accumulated state for robustness)
            // For unchanged cells, Pluto may skip running/runtime diffs entirely;
            // the last_run_timestamp handler in PlutoServer emits running=false
            // which gets accumulated here for reliable completion detection.
            const shouldEnd = shouldEndExecution(checkState);

            if (shouldEnd) {
                log(`[BetterPlutoKernel] Ending execution for ${cellId} (running=${checkState.running}, queued=${checkState.queued}, runtime=${checkState.runtime}, errored=${checkState.errored})`);
                const success = !checkState.errored;
                execution.end(success, Date.now());
                this.cellExecutions.delete(cellId);
                this.cellExecStates.delete(cellId);
                // Don't delete outputs - keep them for display
            } else {
                log(`[BetterPlutoKernel] Execution for ${cellId} not ending yet (running=${state.running}, queued=${state.queued}, runtime=${state.runtime})`);
            }
        } else {
            // No active execution - this might be initial state from Pluto or reactive update
            // Schedule a debounced direct update to collect all state changes
            log(`[BetterPlutoKernel] No execution for ${cellId}, scheduling direct update`);
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
     * Request full state if a cell execution is still pending after timeout.
     * This handles the case where Pluto doesn't send explicit completion signals
     * for unchanged cells.
     */
    private scheduleStateSync(cellId: string): void {
        const existing = this.pendingStateSync.get(cellId);
        if (existing) {
            clearTimeout(existing);
        }

        const timeout = setTimeout(async () => {
            this.pendingStateSync.delete(cellId);
            const execution = this.cellExecutions.get(cellId);
            if (!execution) {
                log(`[BetterPlutoKernel] State sync for ${cellId}: no pending execution, skipping`);
                return;
            }

            log(`[BetterPlutoKernel] State sync for ${cellId}: execution still pending, requesting full state`);
            try {
                this.server.requestFullState();

                // Wait a bit for full state to arrive
                await new Promise(resolve => setTimeout(resolve, 300));

                // If execution is still pending, end it now
                // This is a safety net - normally last_run_timestamp + accumulated state
                // should resolve the execution before this fires
                const stillPending = this.cellExecutions.get(cellId);
                if (stillPending) {
                    const cachedOutput = this.cellOutputs.get(cellId);
                    if (cachedOutput && cachedOutput.body) {
                        log(`[BetterPlutoKernel] Cell ${cellId} has cached output, ending execution (cell was likely already up-to-date)`);

                        // Rebuild and show the cached output
                        const outputs = this.buildOutputsFromCache(cellId, cachedOutput);
                        if (outputs.length > 0) {
                            stillPending.replaceOutput(outputs);
                        }
                        stillPending.end(true, Date.now());
                        this.cellExecutions.delete(cellId);
                        this.cellExecStates.delete(cellId);
                    } else {
                        // No cached output, just end the execution
                        log(`[BetterPlutoKernel] Cell ${cellId} has no output, ending execution`);
                        stillPending.end(true, Date.now());
                        this.cellExecutions.delete(cellId);
                        this.cellExecStates.delete(cellId);
                    }
                }
            } catch (err) {
                console.error('[BetterPlutoKernel] Failed to request full state:', err);
            }
        }, 500);

        this.pendingStateSync.set(cellId, timeout);
    }

    /**
     * Build VS Code notebook outputs from cached output data
     */
    private buildOutputsFromCache(cellId: string, cachedOutput: { body?: string; mime?: string; logs?: LogEntry[] }): vscode.NotebookCellOutput[] {
        return this.outputAdapter.toNotebookOutputs(cellId, cachedOutput);
    }

    /**
     * Execute the actual direct update for a cell
     */
    private async executeDirectUpdate(cellId: string): Promise<void> {
        // Skip if there's already an active execution (created by runAllCellsOnStart or user action)
        // The execution path in handleCellState will handle output rendering
        if (this.cellExecutions.has(cellId)) {
            log(`[BetterPlutoKernel] Skipping direct update for ${cellId} - active execution exists`);
            return;
        }

        const existingOutput = this.cellOutputs.get(cellId);
        if (!existingOutput) {
            log(`[BetterPlutoKernel] Skipping direct update for ${cellId} - no cached output`);
            return;
        }

        // Build outputs using shared method
        const outputs = this.buildOutputsFromCache(cellId, existingOutput);

        if (outputs.length === 0) {return;}

        // Find the cell by ID
        for (let i = 0; i < this.notebook.cellCount; i++) {
            const cell = this.notebook.cellAt(i);
            const id = getCellId(cell);

            if (id === cellId) {
                console.log(`[BetterPlutoKernel] Direct update for ${cellId} at index ${i} with ${outputs.length} outputs`);

                try {
                    // Create a temporary execution to update the output
                    const execution = this.controller.createNotebookCellExecution(cell);
                    execution.start(Date.now());
                    await execution.replaceOutput(outputs);
                    execution.end(true, Date.now());

                    console.log(`[BetterPlutoKernel] Updated cell ${cellId} successfully`);
                } catch (err) {
                    console.error(`[BetterPlutoKernel] Failed to update cell ${cellId}:`, err);
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
        if (isPlutoObjectId(body)) {
            log('[BetterPlutoKernel] Tree object is just objectid, returning placeholder');
            return '(computing...)';
        }

        try {
            const treeObj = JSON.parse(body);
            log(`[BetterPlutoKernel] Tree object structure: ${JSON.stringify(treeObj, null, 2).substring(0, 3000)}`);
            const result = this.extractPlutoTree(treeObj);
            log(`[BetterPlutoKernel] Tree object result: ${result}`);
            return result;
        } catch (e) {
            log(`[BetterPlutoKernel] Tree object parse error: ${e}`);
            // If parsing fails, return as-is (might be plain text)
            return body;
        }
    }

    /**
     * Render Pluto's tree object as collapsible HTML
     * This creates an interactive tree view identical to Pluto.jl
     */
    private renderPlutoTreeAsHtml(body: string, cellId?: string): string {
        // Check if body is just an objectid (hex string)
        if (isPlutoObjectId(body)) {
            return '<span style="color: #888; font-style: italic;">(computing...)</span>';
        }

        try {
            const treeObj = JSON.parse(body);
            const treeHtml = this.renderPlutoTree(treeObj, true, cellId);

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
    // Handle tree collapse/expand (skip if clicking "show more" - handled by renderer)
    const moreButton = e.target.closest('pluto-tree-more');
    if (moreButton) {
        // Let the renderer handle this via postMessage
        return;
    }

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
            log(`[BetterPlutoKernel] Tree HTML render error: ${e}`);
            return `<pre>${escapeHtml(body)}</pre>`;
        }
    }

    /**
     * Render a Pluto tree node - identical to Pluto.jl TreeView component
     */
    private renderPlutoTree(obj: unknown, isRoot: boolean = false, cellId?: string): string {
        if (obj === null || obj === undefined) {
            return '<span>nothing</span>';
        }
        if (typeof obj === 'string') {
            return `<span>${escapeHtml(obj)}</span>`;
        }
        if (typeof obj === 'number' || typeof obj === 'boolean') {
            return `<span>${obj}</span>`;
        }

        if (typeof obj !== 'object') {
            return `<span>${escapeHtml(String(obj))}</span>`;
        }

        // Handle arrays directly (sometimes Pluto sends just the elements array)
        if (Array.isArray(obj)) {
            // Check if this looks like a tree elements array [[index, [value, mime]], ...]
            if (obj.length > 0 && Array.isArray(obj[0]) && obj[0].length === 2) {
                // Treat as Array type
                const collapsedClass = isRoot ? '' : ' collapsed';
                const showMoreAttrs = cellId
                    ? ` data-cellid="${escapeHtml(cellId)}" data-dim="1"`
                    : ' data-dim="1"';
                const renderMimepair = (pair: unknown): string => {
                    if (!Array.isArray(pair) || pair.length !== 2) {
                        return this.renderPlutoTree(pair, false, cellId);
                    }
                    const [body, mime] = pair;
                    if (mime === 'application/vnd.pluto.tree+object' && body && typeof body === 'object') {
                        return this.renderPlutoTree(body, false, cellId);
                    }
                    if (typeof body === 'string') {
                        return `<span>${escapeHtml(body)}</span>`;
                    }
                    return this.renderPlutoTree(body, false, cellId);
                };
                const renderMoreDirect = (r: unknown): string => {
                    if (r === 'more') {
                        return `<pluto-tree-more${showMoreAttrs}>show more</pluto-tree-more>`;
                    }
                    if (r && typeof r === 'object' && !Array.isArray(r)) {
                        const moreObj = r as Record<string, unknown>;
                        if (moreObj.head === 'more' && moreObj.objectid) {
                            const oid = escapeHtml(String(moreObj.objectid));
                            return `<pluto-tree-more data-objectid="${oid}"${showMoreAttrs}>show more</pluto-tree-more>`;
                        }
                    }
                    return '';
                };
                const itemsHtml = obj.map((el) => {
                    const moreHtml = renderMoreDirect(el);
                    if (moreHtml) {return moreHtml;}
                    if (!Array.isArray(el) || el.length !== 2) {return '';}
                    const indexDisplay = `<p-k>${el[0]}</p-k>`;
                    return `<p-r>${indexDisplay}<p-v>${renderMimepair(el[1])}</p-v></p-r>`;
                }).join('');
                const isMoreMarker = (e: unknown) => e === 'more' || (e && typeof e === 'object' && !Array.isArray(e) && (e as Record<string, unknown>).head === 'more');
                const count = obj.filter(e => !isMoreMarker(e)).length;
                const prefix = `${count}-element Array:`;
                const prefixHtml = `<pluto-tree-prefix><span class="long">${escapeHtml(prefix)}</span><span class="short">${escapeHtml(prefix)}</span></pluto-tree-prefix>`;
                return `<pluto-tree class="Array${collapsedClass}">${prefixHtml}<pluto-tree-items class="Array">${itemsHtml}</pluto-tree-items></pluto-tree>`;
            }
            // Otherwise, just stringify
            return `<span>${escapeHtml(JSON.stringify(obj).substring(0, 100))}</span>`;
        }

        const record = obj as Record<string, unknown>;

        // Mimepair output helper
        const mimepairOutput = (pair: unknown): string => {
            if (!Array.isArray(pair) || pair.length !== 2) {
                return this.renderPlutoTree(pair, false, cellId);
            }
            const [body, mime] = pair;
            if (mime === 'application/vnd.pluto.tree+object' && body && typeof body === 'object') {
                return this.renderPlutoTree(body, false, cellId);
            }
            if (typeof body === 'string') {
                return `<span>${escapeHtml(body)}</span>`;
            }
            return this.renderPlutoTree(body, false, cellId);
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

            const prefixHtml = `<pluto-tree-prefix><span class="long">${escapeHtml(prefix || '')}</span><span class="short">${escapeHtml(prefixShort || prefix || '')}</span></pluto-tree-prefix>`;

            let itemsHtml = '';
            const showMoreAttrs = cellId
                ? ` data-cellid="${escapeHtml(cellId)}" data-dim="1"`
                : ' data-dim="1"';

            // Helper to render "more" marker with objectid
            const renderMore = (r: unknown): string => {
                if (r === 'more') {
                    return `<pluto-tree-more${showMoreAttrs}>show more</pluto-tree-more>`;
                }
                if (r && typeof r === 'object' && !Array.isArray(r)) {
                    const obj = r as Record<string, unknown>;
                    if (obj.head === 'more' && obj.objectid) {
                        const oid = escapeHtml(String(obj.objectid));
                        return `<pluto-tree-more data-objectid="${oid}"${showMoreAttrs}>show more</pluto-tree-more>`;
                    }
                }
                return '';
            };

            switch (plutoType) {
                case 'Array':
                case 'Set':
                case 'Tuple':
                    itemsHtml = elements.map(r => {
                        const moreHtml = renderMore(r);
                        if (moreHtml) {return moreHtml;}
                        const el = r as unknown[];
                        if (!Array.isArray(el) || el.length !== 2) {return '';}
                        const indexDisplay = plutoType === 'Set' ? '' : `<p-k>${el[0]}</p-k>`;
                        return `<p-r>${indexDisplay}<p-v>${mimepairOutput(el[1] as unknown[])}</p-v></p-r>`;
                    }).join('');
                    break;

                case 'Dict':
                    itemsHtml = elements.map(r => {
                        const moreHtml = renderMore(r);
                        if (moreHtml) {return moreHtml;}
                        const el = r as unknown[];
                        if (!Array.isArray(el) || el.length !== 2) {return '';}
                        return `<p-r><p-k>${mimepairOutput(el[0] as unknown[])}</p-k><p-v>${mimepairOutput(el[1] as unknown[])}</p-v></p-r>`;
                    }).join('');
                    break;

                case 'NamedTuple':
                case 'struct':
                    itemsHtml = elements.map(r => {
                        const moreHtml = renderMore(r);
                        if (moreHtml) {return moreHtml;}
                        const el = r as unknown[];
                        if (!Array.isArray(el) || el.length !== 2) {return '';}
                        return `<p-r><p-k>${escapeHtml(String(el[0]))}</p-k><p-v>${mimepairOutput(el[1] as unknown[])}</p-v></p-r>`;
                    }).join('');
                    break;

                default:
                    // Default handling for unknown types
                    itemsHtml = elements.map(r => {
                        const moreHtml = renderMore(r);
                        if (moreHtml) {return moreHtml;}
                        const el = r as unknown[];
                        if (!Array.isArray(el) || el.length !== 2) {return '';}
                        return `<p-r><p-k>${el[0]}</p-k><p-v>${mimepairOutput(el[1] as unknown[])}</p-v></p-r>`;
                    }).join('');
            }

            return `<pluto-tree class="${typeClass}${collapsedClass}">${prefixHtml}<pluto-tree-items class="${typeClass}">${itemsHtml}</pluto-tree-items></pluto-tree>`;
        }

        // Fallback
        if (prefix) {
            return `<span>${escapeHtml(prefix)}</span>`;
        }
        if (plutoType) {
            return `<span>&lt;${escapeHtml(plutoType)}&gt;</span>`;
        }

        return `<span>${escapeHtml(JSON.stringify(obj).substring(0, 100))}</span>`;
    }

    /**
     * Extract displayable text from Pluto tree object
     */
    private extractPlutoTree(obj: unknown): string {
        if (obj === null || obj === undefined) {return 'nothing';}
        if (typeof obj === 'string') {return obj;}
        if (typeof obj === 'number' || typeof obj === 'boolean') {return String(obj);}

        if (typeof obj !== 'object') {return String(obj);}

        const record = obj as Record<string, unknown>;

        // Check if it's a mime/body object (leaf value)
        if ('mime' in record && 'body' in record) {
            const body = record.body;
            if (typeof body === 'string') {return body;}
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
            if (plutoType === 'Tuple') {return `(${itemsStr})`;}
            if (plutoType === 'NamedTuple') {return `(${itemsStr})`;}
            if (plutoType === 'Dict') {return prefix ? `${prefix}(${itemsStr})` : `Dict(${itemsStr})`;}
            if (plutoType === 'Set') {return prefix ? `${prefix}([${itemsStr}])` : `Set([${itemsStr}])`;}
            if (plutoType === 'Array') {return prefix ? `${prefix}[${itemsStr}]` : `[${itemsStr}]`;}
            if (plutoType === 'struct') {return prefix ? `${prefix}(${itemsStr})` : `(${itemsStr})`;}

            return prefix ? `${prefix}[${itemsStr}]` : `[${itemsStr}]`;
        }

        // Fallback to prefix/type display
        if (prefix) {return prefix;}
        if (plutoType) {return `<${plutoType}>`;}
        if ('objectid' in record) {return `<object>`;}

        return JSON.stringify(obj).substring(0, 100);
    }

    /**
     * Extract a single element from Pluto tree elements array
     * Pluto format: [index, [body, mime]] for Array/Set/Tuple
     *               [key, value] for Dict (both are mimepairs)
     *               [fieldname, [body, mime]] for struct/NamedTuple
     */
    private extractPlutoElement(elem: unknown): string {
        if (elem === null || elem === undefined) {return 'nothing';}
        if (typeof elem === 'string') {return elem;}
        if (typeof elem === 'number' || typeof elem === 'boolean') {return String(elem);}

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

        if (cellIndex === -1) {return;}

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
            log('[BetterPlutoController] Cannot set bond, kernel not running');
        }
    }

    /**
     * Execute modified cells for a notebook (called on Cmd+S)
     */
    async executeModifiedCells(notebook: vscode.NotebookDocument): Promise<void> {
        const key = notebook.uri.toString();
        const kernel = this.kernels.get(key);
        if (kernel && kernel.isRunning) {
            await kernel.handleNotebookSave();
        } else {
            log('[BetterPlutoController] Cannot execute modified cells, kernel not running');
        }
    }

    /**
     * Ask Pluto to expand a tree/table output segment.
     */
    async reshowCell(notebook: vscode.NotebookDocument, cellId: string, objectid: string, dim: number): Promise<void> {
        const key = notebook.uri.toString();
        const kernel = this.kernels.get(key);
        if (kernel && kernel.isRunning) {
            try {
                await kernel.reshowCell(cellId, objectid, dim);
            } catch (error) {
                console.error('[BetterPlutoController] Failed to reshow cell output:', error);
            }
        } else {
            log('[BetterPlutoController] Cannot reshow cell output, kernel not running');
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
                this.handleNotebookChange(e).catch((err) => {
                    console.error('[BetterPlutoController] Failed to handle notebook change:', err);
                });
            })
        );

        // Listen for notebook save - execute modified cells on Cmd+S
        this.disposables.push(
            vscode.workspace.onDidSaveNotebookDocument(notebook => {
                this.handleNotebookSave(notebook).catch((err) => {
                    console.error('[BetterPlutoController] Failed to handle notebook save:', err);
                });
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
        console.log(`[BetterPlutoController] executeHandler called with ${cells.length} cells`);
        for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            console.log(`[BetterPlutoController] Cell ${i}: content=${cell.document.getText().slice(0, 50)}`);
        }

        const kernel = await this.getOrCreateKernel(notebook);
        await kernel.executeCells(cells);
    }

    /**
     * Interrupt handler called by VS Code when user stops execution
     */
    private async interruptHandler(notebook: vscode.NotebookDocument): Promise<void> {
        log(`[BetterPlutoController] Interrupt requested for ${notebook.uri.fsPath}`);
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
        // Associate this controller with the notebook so createNotebookCellExecution succeeds
        // (e.g. when startKernel is run from command palette or E2E tests without prior kernel selection)
        this.controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
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
     * Handle notebook save - execute modified cells
     */
    private async handleNotebookSave(notebook: vscode.NotebookDocument): Promise<void> {
        console.log(`[PlutoNotebookController] handleNotebookSave called for ${notebook.uri.toString()}`);
        const key = notebook.uri.toString();
        const kernel = this.kernels.get(key);
        console.log(`[PlutoNotebookController] kernel found: ${!!kernel}, isRunning: ${kernel?.isRunning}`);
        if (kernel && kernel.isRunning) {
            await kernel.handleNotebookSave();
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

    /**
     * Mark a cell as undergoing fold/unfold change.
     * Changes to this cell will be ignored in modifiedCellIds to prevent spurious re-execution.
     */
    markCellAsFoldChanging(notebook: vscode.NotebookDocument, cellId: string): void {
        const key = notebook.uri.toString();
        const kernel = this.kernels.get(key);
        if (kernel) {
            kernel.markCellAsFoldChanging(cellId);
        }
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
