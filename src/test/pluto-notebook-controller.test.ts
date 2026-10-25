import * as assert from 'assert';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { PlutoKernel } from '../PlutoNotebookController';
import type { CellState } from '../PlutoServer';
import type { CachedOutput } from '../output-utils';

interface KernelHarness {
    cellOutputs: Map<string, CachedOutput>;
    cellExecutions: Map<string, vscode.NotebookCellExecution>;
    handleCellState(cellId: string, state: Partial<CellState>): void;
    executeDirectUpdate(cellId: string): Promise<void>;
    scheduleStateSync(cellId: string): void;
    server: { requestFullState(): void };
    pendingDirectUpdates: Map<string, NodeJS.Timeout>;
}

suite('Pluto notebook output state', () => {
    let kernel: PlutoKernel;
    let harness: KernelHarness;
    let replacements: readonly vscode.NotebookCellOutput[][];
    let execution: vscode.NotebookCellExecution;

    setup(() => {
        replacements = [];
        execution = {
            start: () => undefined,
            end: () => undefined,
            replaceOutput: (outputs: vscode.NotebookCellOutput[]) => {
                replacements = [...replacements, outputs];
                return Promise.resolve();
            },
        } as unknown as vscode.NotebookCellExecution;
        const cell = { metadata: { custom: { id: 'cell-1' } } } as unknown as vscode.NotebookCell;
        const notebook = {
            cellCount: 1,
            cellAt: () => cell,
        } as unknown as vscode.NotebookDocument;
        const controller = {
            createNotebookCellExecution: () => execution,
        } as unknown as vscode.NotebookController;
        kernel = new PlutoKernel(controller, notebook, () => undefined);
        harness = kernel as unknown as KernelHarness;
    });

    teardown(async () => {
        await kernel.stop();
    });

    test('explicit empty output clears an active execution result', () => {
        harness.cellOutputs.set('cell-1', { body: 'old result', mime: 'text/plain' });
        harness.cellExecutions.set('cell-1', execution);
        harness.handleCellState('cell-1', { output: { body: '', mime: 'text/plain' } });
        assert.strictEqual(harness.cellOutputs.get('cell-1')?.body, '');
        assert.deepStrictEqual(replacements, [[]]);
    });

    test('explicit empty logs clear stdout while omitted fields preserve it', () => {
        const logs = [{ level: 'LogLevel(-555)', msg: 'old stdout' }];
        harness.cellOutputs.set('cell-1', { logs });
        harness.cellExecutions.set('cell-1', execution);
        harness.handleCellState('cell-1', { running: true });
        assert.deepStrictEqual(harness.cellOutputs.get('cell-1')?.logs, logs);
        assert.strictEqual(replacements[0].length, 1);
        harness.handleCellState('cell-1', { logs: [] });
        assert.deepStrictEqual(harness.cellOutputs.get('cell-1')?.logs, []);
        assert.deepStrictEqual(replacements[1], []);
    });

    test('a reactive empty result clears output without an active execution', async () => {
        harness.cellOutputs.set('cell-1', { body: 'old result', mime: 'text/plain' });
        harness.handleCellState('cell-1', { output: { body: '', mime: 'text/plain' } });
        // Invoke the scheduled path deterministically without waiting for the debounce.
        for (const timer of harness.pendingDirectUpdates.values()) { clearTimeout(timer); }
        harness.pendingDirectUpdates.clear();
        await harness.executeDirectUpdate('cell-1');
        assert.deepStrictEqual(replacements, [[]]);
    });

    test('state-only updates preserve cached output', () => {
        harness.cellOutputs.set('cell-1', { body: 'keep', mime: 'text/plain' });
        harness.cellExecutions.set('cell-1', execution);
        harness.handleCellState('cell-1', { running: true });
        assert.strictEqual(harness.cellOutputs.get('cell-1')?.body, 'keep');
        assert.strictEqual(replacements[0].length, 1);
        assert.strictEqual(Buffer.from(replacements[0][0].items[0].data).toString(), 'keep');
    });
    test('state recovery never completes a still-running cell from cached output', async () => {
        let requests = 0;
        const completions: (boolean | undefined)[] = [];
        harness.server.requestFullState = () => { requests++; };
        execution.end = success => { completions.push(success); };
        harness.cellOutputs.set('cell-1', { body: 'previous result', mime: 'text/plain' });
        harness.cellExecutions.set('cell-1', execution);
        harness.handleCellState('cell-1', { running: true, queued: false });
        harness.scheduleStateSync('cell-1');
        await new Promise(resolve => setTimeout(resolve, 900));
        assert.strictEqual(requests, 1);
        assert.deepStrictEqual(completions, []);
        assert.strictEqual(harness.cellExecutions.get('cell-1'), execution);
        harness.handleCellState('cell-1', { running: false, queued: false, errored: true });
        assert.deepStrictEqual(completions, [false]);
        assert.strictEqual(harness.cellExecutions.has('cell-1'), false);
    });

    test('reactive updates preserve error status across partial patches and recover', async () => {
        const completions: (boolean | undefined)[] = [];
        execution.end = success => { completions.push(success); };
        const flush = async () => {
            for (const timer of harness.pendingDirectUpdates.values()) { clearTimeout(timer); }
            harness.pendingDirectUpdates.clear();
            await harness.executeDirectUpdate('cell-1');
        };
        harness.handleCellState('cell-1', { running: false, queued: false, errored: true });
        harness.handleCellState('cell-1', { output: { body: 'upstream error', mime: 'text/plain' } });
        await flush();
        assert.deepStrictEqual(completions, [false]);
        // An output-only follow-up must not reset the error flag.
        harness.handleCellState('cell-1', { logs: [] });
        await flush();
        assert.deepStrictEqual(completions, [false, false]);
        harness.handleCellState('cell-1', { running: true });
        await flush();
        assert.deepStrictEqual(completions, [false, false, undefined]);
        harness.handleCellState('cell-1', { errored: false, output: { body: '41', mime: 'text/plain' } });
        harness.handleCellState('cell-1', { running: false });
        await flush();
        assert.deepStrictEqual(completions, [false, false, undefined, true]);
    });
    test('output alone does not invent a successful execution status', async () => {
        const completions: (boolean | undefined)[] = [];
        execution.end = success => { completions.push(success); };
        harness.handleCellState('cell-1', { output: { body: 'rendered', mime: 'text/plain' } });
        for (const timer of harness.pendingDirectUpdates.values()) { clearTimeout(timer); }
        harness.pendingDirectUpdates.clear();
        await harness.executeDirectUpdate('cell-1');
        assert.deepStrictEqual(completions, [undefined]);
    });

    test('manual rerun takes ownership while a reactive output replacement is pending', async () => {
        let releaseOutput!: () => void;
        const outputPending = new Promise<void>(resolve => { releaseOutput = resolve; });
        let occupied = false;
        let creates = 0;
        let runs = 0;
        const ended: number[] = [];
        const manual = kernel as unknown as {
            controller: vscode.NotebookController;
            notebook: vscode.NotebookDocument;
            executeCell(cell: vscode.NotebookCell): Promise<void>;
            server: {
                getPlutoCellId(id: string): string;
                isKnownCell(id: string): boolean;
                updateCell(id: string, code: string): Promise<void>;
                runCell(id: string): Promise<void>;
            };
        };
        const cell = manual.notebook.cellAt(0);
        Object.assign(cell, { document: { getText: () => 'read("data.txt", String)', languageId: 'julia' } });
        manual.controller.createNotebookCellExecution = () => {
            assert.strictEqual(occupied, false, 'VS Code rejects overlapping execution objects');
            occupied = true;
            const id = ++creates;
            return {
                start: () => undefined,
                end: () => { ended.push(id); occupied = false; },
                replaceOutput: () => id === 1 ? outputPending : Promise.resolve(),
                clearOutput: () => Promise.resolve(),
            } as unknown as vscode.NotebookCellExecution;
        };
        manual.server.getPlutoCellId = id => id;
        manual.server.isKnownCell = () => true;
        manual.server.updateCell = async () => undefined;
        manual.server.runCell = async () => { runs++; };
        harness.cellOutputs.set('cell-1', { body: 'first-value', mime: 'text/plain' });
        const rendering = harness.executeDirectUpdate('cell-1');
        assert.ok(harness.cellExecutions.has('cell-1'), 'Pending reactive rendering must be tracked');
        await manual.executeCell(cell);
        const newExecution = harness.cellExecutions.get('cell-1');
        assert.strictEqual(runs, 1, 'Manual run must reach Pluto');
        assert.strictEqual(creates, 2);
        assert.deepStrictEqual(ended, [1]);
        releaseOutput();
        await rendering;
        assert.strictEqual(harness.cellExecutions.get('cell-1'), newExecution, 'Old renderer must not remove the manual execution');
        assert.deepStrictEqual(ended, [1], 'Old renderer must not end a replaced execution twice');
        harness.handleCellState('cell-1', { running: false, queued: false, errored: false });
        assert.deepStrictEqual(ended, [1, 2]);
    });

    test('partial terminal updates during reactive rendering retain the accumulated error', async () => {
        let releaseOutput!: () => void;
        const pending = new Promise<void>(resolve => { releaseOutput = resolve; });
        const ended: (boolean | undefined)[] = [];
        execution.replaceOutput = () => pending;
        execution.end = success => { ended.push(success); };
        harness.handleCellState('cell-1', { running: false, queued: false, errored: true, output: { body: 'error', mime: 'text/plain' } });
        for (const timer of harness.pendingDirectUpdates.values()) { clearTimeout(timer); }
        harness.pendingDirectUpdates.clear();
        const rendering = harness.executeDirectUpdate('cell-1');
        harness.handleCellState('cell-1', { running: false });
        assert.deepStrictEqual(ended, [false]);
        releaseOutput();
        await rendering;
        assert.deepStrictEqual(ended, [false], 'Completed renderer must not end again');
        assert.strictEqual(harness.cellExecutions.has('cell-1'), false);
    });

});

suite('Pluto kernel restart lifecycle', () => {
    test('reconnects server event handlers after restart', async () => {
        const cell = { metadata: { custom: { id: 'cell-1' } } } as unknown as vscode.NotebookCell;
        const notebook = {
            cellCount: 1,
            cellAt: () => cell,
        } as unknown as vscode.NotebookDocument;
        const controller = {
            createNotebookCellExecution: () => ({}) as vscode.NotebookCellExecution,
        } as unknown as vscode.NotebookController;
        const kernel = new PlutoKernel(controller, notebook, () => undefined);
        const server = new EventEmitter() as EventEmitter & { stop(): void };
        server.stop = () => { server.removeAllListeners(); };
        const internal = kernel as unknown as {
            server: typeof server;
            setupServerEvents(): void;
            stop(): Promise<void>;
            start(): Promise<void>;
            restart(): Promise<void>;
        };
        internal.server = server;
        internal.setupServerEvents();
        internal.stop = async () => { server.stop(); };
        internal.start = async () => undefined;

        await internal.restart();

        assert.strictEqual(server.listenerCount('cellState'), 1);
        assert.strictEqual(server.listenerCount('error'), 1);
        assert.strictEqual(server.listenerCount('closed'), 1);
    });
});
