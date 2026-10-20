import * as assert from 'assert';
import * as vscode from 'vscode';
import { PlutoNavigationState } from '../pluto-navigation';
import { showDependentCells, type DependentCellChoice, type DependentCellsUI } from '../pluto-dependent-cells';

suite('Show dependent cells', () => {
    function fixture() {
        const ids = ['s', 'b', 'c'];
        const texts: Record<string, string> = { s: 'begin\nx = 1\ny = 2\nend', b: 'x + y', c: 'x * 2' };
        const cells = new Map(ids.map(id => [id, {
            get index() { return ids.indexOf(id); },
            metadata: { custom: { id } },
            document: { getText: () => texts[id] },
        } as unknown as vscode.NotebookCell]));
        const notebook = {
            notebookType: 'pluto-notebook', isClosed: false,
            get cellCount() { return ids.length; },
            cellAt: (index: number) => cells.get(ids[index])!,
            getCells: () => ids.map(id => cells.get(id)!),
        } as unknown as vscode.NotebookDocument;
        const revealed: number[] = [];
        const editor = {
            notebook, selection: new vscode.NotebookRange(0, 1),
            revealRange: (range: vscode.NotebookRange) => revealed.push(range.start),
        } as unknown as vscode.NotebookEditor;
        const state = new PlutoNavigationState();
        state.applyNotebookDiff({ message: { patches: [{ op: 'replace', path: [], value: {
            cell_inputs: Object.fromEntries(ids.map(id => [id, { code: texts[id] }])),
            cell_dependencies: {
                s: { downstream_cells_map: { x: ['b', 'c', 'b'], y: ['b'] } },
                b: { downstream_cells_map: {} }, c: { downstream_cells_map: {} },
            },
        } }] } });
        let navigation: PlutoNavigationState | undefined = state;
        let activeEditor: vscode.NotebookEditor | undefined = editor;
        const messages: string[] = [];
        const ui: DependentCellsUI = {
            activeEditor: () => activeEditor,
            pick: async choices => choices[0],
            inform: message => messages.push(message),
        };
        return {
            ids, texts, state, notebook, editor, revealed, messages, ui,
            getNavigation: () => navigation,
            stop: () => { navigation = undefined; },
            leave: () => { activeEditor = undefined; },
        };
    }

    test('groups globals, deduplicates cells and navigates from complex source code', async () => {
        const f = fixture();
        let offered: DependentCellChoice[] = [];
        f.ui.pick = async choices => { offered = choices; return choices[0]; };
        await showDependentCells(f.getNavigation, f.ui);
        assert.deepStrictEqual(offered.map(choice => [choice.label, choice.description, choice.detail]), [
            ['Cell 2', 'x, y', 'x + y'], ['Cell 3', 'x', 'x * 2'],
        ]);
        assert.deepStrictEqual(f.revealed, [1]);
    });

    test('resolves stable cell IDs after visual reordering while picker is open', async () => {
        const f = fixture();
        f.ui.pick = async choices => { f.ids.splice(0, 3, 's', 'c', 'b'); return choices[0]; };
        await showDependentCells(f.getNavigation, f.ui);
        assert.deepStrictEqual(f.revealed, [2]);
    });

    test('cancellation and repeated invocation do not cause unintended navigation', async () => {
        const f = fixture();
        f.ui.pick = async () => undefined;
        await showDependentCells(f.getNavigation, f.ui);
        await showDependentCells(f.getNavigation, f.ui);
        assert.deepStrictEqual(f.revealed, []);
        assert.deepStrictEqual(f.messages, []);
    });

    test('excludes unsynchronized targets and rejects an unsynchronized source', async () => {
        const f = fixture();
        f.texts.c = 'x * 3';
        f.ui.pick = async choices => { assert.deepStrictEqual(choices.map(choice => choice.cellId), ['b']); return undefined; };
        await showDependentCells(f.getNavigation, f.ui);
        f.texts.s += '\n# edited';
        f.ui.pick = async () => { assert.fail('Stale source must not open picker'); };
        await showDependentCells(f.getNavigation, f.ui);
        assert.strictEqual(f.messages.length, 1);
        assert.deepStrictEqual(f.revealed, []);
    });

    test('rejects changed or deleted targets after picker selection', async () => {
        for (const deleted of [false, true]) {
            const f = fixture();
            f.ui.pick = async choices => {
                if (deleted) { f.ids.splice(1, 1); } else { f.texts.b = 'x + y + 1'; }
                return choices[0];
            };
            await showDependentCells(f.getNavigation, f.ui);
            assert.deepStrictEqual(f.revealed, []);
            assert.strictEqual(f.messages.length, 1);
        }
    });

    test('rejects stopped kernels, closed notebooks and leaving the editor during picker', async () => {
        for (const action of ['stop', 'close', 'leave']) {
            const f = fixture();
            f.ui.pick = async choices => {
                if (action === 'stop') { f.stop(); }
                if (action === 'close') { (f.notebook as unknown as { isClosed: boolean }).isClosed = true; }
                if (action === 'leave') { f.leave(); }
                return choices[0];
            };
            await showDependentCells(f.getNavigation, f.ui);
            assert.deepStrictEqual(f.revealed, []);
        }
    });

    test('rejects changed topology after picker selection', async () => {
        const f = fixture();
        f.ui.pick = async choices => {
            f.state.applyNotebookDiff({ message: { patches: [{ op: 'replace', path: ['cell_dependencies', 's', 'downstream_cells_map'], value: {} }] } });
            return choices[0];
        };
        await showDependentCells(f.getNavigation, f.ui);
        assert.deepStrictEqual(f.revealed, []);
    });

    test('reports no direct dependents and does not open picker', async () => {
        const f = fixture();
        f.editor.selection = new vscode.NotebookRange(1, 2);
        f.ui.pick = async () => { assert.fail('No dependents must not open picker'); };
        await showDependentCells(f.getNavigation, f.ui);
        assert.deepStrictEqual(f.revealed, []);
        assert.ok(f.messages[0].includes('no direct dependent'));
    });
});
