import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

async function until(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (!predicate()) {
        if (Date.now() > deadline) { throw new Error(`Timed out: ${label}`); }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}
function output(cell: vscode.NotebookCell): string {
    return cell.outputs.flatMap(value => value.items.map(item => Buffer.from(item.data).toString())).join('\n');
}

suite('Pluto issue #94 regressions (real Julia)', () => {
    test('unchanged manual rerun reads fresh data; errored upstream blocks and recovers dependents', async function () {
        if (process.env.RUN_PLUTO_E2E !== '1') { this.skip(); return; }
        this.timeout(360_000);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'better-pluto-regression-'));
        const dataPath = path.join(dir, 'data.txt');
        const markerPath = path.join(dir, 'dependent.txt');
        fs.writeFileSync(dataPath, 'first-value');
        const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
        const codes = [
            `read(${JSON.stringify(dataPath)}, String)`,
            'x = error("upstream-failed")',
            `begin\n    write(${JSON.stringify(markerPath)}, "executed")\n    x + 1\nend`,
        ];
        const file = path.join(dir, 'Regression.jl');
        fs.writeFileSync(file, '### A Pluto.jl notebook ###\n# v0.20.19\n\nusing Markdown\nusing InteractiveUtils\n\n' +
            codes.map((code, i) => `# ╔═╡ ${ids[i]}\n${code}\n`).join('\n') + '\n# ╔═╡ Cell order:\n' + ids.map(id => `# ╠═${id}`).join('\n') + '\n');
        try {
            await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'pluto-notebook');
            const editor = vscode.window.activeNotebookEditor;
            assert.ok(editor, 'Notebook editor must open');
            const notebook = editor.notebook;
            await vscode.commands.executeCommand('pluto-notebook.startKernel');
            await until(() => output(notebook.cellAt(0)).includes('first-value') && output(notebook.cellAt(1)).includes('upstream-failed'), 'initial output/error');
            await until(() => notebook.cellAt(2).executionSummary?.success === false, 'dependent settles as errored');
            assert.strictEqual(fs.existsSync(markerPath), false, 'Dependent side effects must not execute while upstream errors');

            fs.writeFileSync(dataPath, 'second-value');
            editor.selection = new vscode.NotebookRange(0, 1);
            await vscode.commands.executeCommand('notebook.cell.execute');
            await until(() => output(notebook.cellAt(0)).includes('second-value'), 'unchanged manual rerun produces fresh output');
            assert.ok(!output(notebook.cellAt(0)).includes('first-value'), 'Old output must be replaced');
            assert.strictEqual(fs.existsSync(markerPath), false, 'Dependent remains blocked until upstream is fixed');

            const parent = notebook.cellAt(1).document;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(parent.uri, new vscode.Range(0, 0, parent.lineCount, 0), 'x = 40');
            assert.ok(await vscode.workspace.applyEdit(edit));
            editor.selection = new vscode.NotebookRange(1, 2);
            await vscode.commands.executeCommand('notebook.cell.execute');
            await until(() => output(notebook.cellAt(2)).trim() === '41', 'dependent automatically recovers');
            assert.strictEqual(fs.readFileSync(markerPath, 'utf8'), 'executed');
        } finally {
            await vscode.commands.executeCommand('pluto-notebook.stopKernel');
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
