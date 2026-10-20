import * as assert from 'assert';
import * as vscode from 'vscode';
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

});
