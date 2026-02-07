import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';

const NOTEBOOK_TYPE = 'pluto-notebook';

async function waitFor<T>(
    getValue: () => T | undefined,
    predicate: (value: T) => boolean,
    timeoutMs: number,
    intervalMs: number = 250
): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const value = getValue();
        if (value !== undefined && predicate(value)) {
            return value;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timed out after ${timeoutMs}ms`);
}

function hasJuliaInPath(): boolean {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(cmd, ['julia'], { encoding: 'utf-8' });
    return result.status === 0;
}

suite('Pluto E2E', () => {
    test('open Basic.jl as Pluto notebook and execute a cell', async function () {
        this.timeout(240_000);

        if (process.env.RUN_PLUTO_E2E !== '1') {
            this.skip();
            return;
        }

        if (!hasJuliaInPath()) {
            this.skip();
            return;
        }

        const basicPath = path.resolve(__dirname, '..', '..', 'samples', 'Basic.jl');
        assert.ok(fs.existsSync(basicPath), `Sample notebook not found: ${basicPath}`);

        const uri = vscode.Uri.file(basicPath);
        await vscode.commands.executeCommand('vscode.openWith', uri, NOTEBOOK_TYPE);

        const notebookEditor = await waitFor(
            () => vscode.window.activeNotebookEditor,
            (editor) => editor.notebook.notebookType === NOTEBOOK_TYPE,
            30_000
        );

        const notebook = notebookEditor.notebook;
        assert.ok(notebook.cellCount > 1, 'Expected Basic.jl to have at least two notebook cells');

        await vscode.commands.executeCommand('pluto-notebook.startKernel');

        // Execute the second cell (hello("Me")) and verify it produces output.
        notebookEditor.selection = new vscode.NotebookRange(1, 2);
        await vscode.commands.executeCommand('notebook.cell.execute');

        await waitFor(
            () => notebook.cellAt(1).outputs,
            (outputs) => outputs.length > 0,
            120_000
        );

        assert.ok(notebook.cellAt(1).outputs.length > 0, 'Expected executed cell to have outputs');

        await vscode.commands.executeCommand('pluto-notebook.stopKernel');
    });

    test('open PlutoTeachingTools.jl as Pluto notebook and execute a cell', async function () {
        this.timeout(240_000);

        if (process.env.RUN_PLUTO_E2E !== '1') {
            this.skip();
            return;
        }

        if (!hasJuliaInPath()) {
            this.skip();
            return;
        }

        const samplePath = path.resolve(__dirname, '..', '..', 'samples', 'PlutoTeachingTools.jl');
        assert.ok(fs.existsSync(samplePath), `Sample notebook not found: ${samplePath}`);

        const uri = vscode.Uri.file(samplePath);
        await vscode.commands.executeCommand('vscode.openWith', uri, NOTEBOOK_TYPE);

        const notebookEditor = await waitFor(
            () => vscode.window.activeNotebookEditor,
            (editor) => editor.notebook.notebookType === NOTEBOOK_TYPE,
            30_000
        );

        const notebook = notebookEditor.notebook;
        assert.ok(notebook.cellCount > 1, 'Expected PlutoTeachingTools.jl to have at least two cells');

        await vscode.commands.executeCommand('pluto-notebook.startKernel');

        // Find a code cell that contains println and execute it (e.g. println("Hello, World!"))
        let targetIndex = -1;
        for (let i = 0; i < notebook.cellCount; i++) {
            const cell = notebook.cellAt(i);
            if (cell.kind === vscode.NotebookCellKind.Code) {
                const text = cell.document.getText();
                if (text.includes('println')) {
                    targetIndex = i;
                    break;
                }
            }
        }
        assert.ok(targetIndex >= 0, 'Expected to find a code cell containing println in PlutoTeachingTools.jl');

        notebookEditor.selection = new vscode.NotebookRange(targetIndex, targetIndex + 1);
        await vscode.commands.executeCommand('notebook.cell.execute');

        await waitFor(
            () => notebook.cellAt(targetIndex).outputs,
            (outputs) => outputs.length > 0,
            120_000
        );

        assert.ok(notebook.cellAt(targetIndex).outputs.length > 0, 'Expected executed cell to have outputs');

        await vscode.commands.executeCommand('pluto-notebook.stopKernel');
    });
});
