import * as assert from 'assert';
import { PlutoNavigationState } from '../pluto-navigation';

suite('Pluto navigation topology', () => {
    const initial = () => ({ message: { patches: [{ op: 'replace', path: [], value: {
        cell_inputs: { a: { code: 'x = 1' }, b: { code: 'x + 2' } },
        cell_dependencies: { b: { upstream_cells_map: { x: ['a'] } } },
    } }] } });
    test('uses server dependency IDs, independent of notebook visual order', () => {
        const state = new PlutoNavigationState();
        state.applyNotebookDiff(initial());
        assert.deepStrictEqual(state.definitionCellIds('b', 'x + 2', 'x'), ['a']);
        assert.deepStrictEqual(state.definitionCellIds('b', 'x + 2', 'unknown'), []);
        assert.ok(state.matchesCode('a', 'x = 1'));
    });
    test('does not navigate from unsynchronized source or target code', () => {
        const state = new PlutoNavigationState(); state.applyNotebookDiff(initial());
        assert.deepStrictEqual(state.definitionCellIds('b', 'y + 2', 'x'), []);
        assert.strictEqual(state.matchesCode('a', 'x = 3'), false);
    });
    test('applies nested topology patches and removes obsolete definitions', () => {
        const state = new PlutoNavigationState(); state.applyNotebookDiff(initial());
        state.applyNotebookDiff({ message: { patches: [{ op: 'replace', path: ['cell_dependencies', 'b', 'upstream_cells_map', 'x'], value: ['c', 'c'] }] } });
        assert.deepStrictEqual(state.definitionCellIds('b', 'x + 2', 'x'), ['c']);
        state.applyNotebookDiff({ message: { patches: [{ op: 'remove', path: ['cell_dependencies', 'b'] }] } });
        assert.deepStrictEqual(state.definitionCellIds('b', 'x + 2', 'x'), []);
    });
    test('invalidates graph between input synchronization and topology recomputation', () => {
        const state = new PlutoNavigationState(); state.applyNotebookDiff(initial());
        state.applyNotebookDiff({ message: { patches: [{ op: 'replace', path: ['cell_inputs', 'b', 'code'], value: 'x + 3' }] } });
        assert.deepStrictEqual(state.definitionCellIds('b', 'x + 3', 'x'), []);
        state.applyNotebookDiff({ message: { patches: [{ op: 'replace', path: ['cell_dependencies', 'b', 'upstream_cells_map'], value: { x: ['a'] } }] } });
        assert.deepStrictEqual(state.definitionCellIds('b', 'x + 3', 'x'), ['a']);
    });
    test('accepts same-message graph and input updates in either order', () => {
        for (const reverse of [false, true]) {
            const state = new PlutoNavigationState(); state.applyNotebookDiff(initial());
            const patches = [
                { op: 'replace', path: ['cell_inputs', 'b', 'code'], value: 'x + 3' as unknown },
                { op: 'replace', path: ['cell_dependencies', 'b', 'upstream_cells_map'], value: { x: ['a'] } },
            ];
            state.applyNotebookDiff({ message: { patches: reverse ? patches.reverse() : patches } });
            assert.deepStrictEqual(state.definitionCellIds('b', 'x + 3', 'x'), ['a']);
        }
    });
    test('resets on full snapshots and kernel shutdown', () => {
        const state = new PlutoNavigationState(); state.applyNotebookDiff(initial());
        state.applyNotebookDiff({ message: { patches: [{ op: 'replace', path: [], value: {} }] } });
        assert.deepStrictEqual(state.definitionCellIds('b', 'x + 2', 'x'), []);
        state.applyNotebookDiff(initial()); state.clear();
        assert.strictEqual(state.matchesCode('a', 'x = 1'), false);
    });
    test('ignores malformed data and prototype paths', () => {
        const state = new PlutoNavigationState(); state.applyNotebookDiff(initial());
        state.applyNotebookDiff({ message: { patches: [{ op: 'replace', path: ['cell_inputs', '__proto__', 'polluted'], value: true }] } });
        assert.strictEqual(({} as Record<string, unknown>).polluted, undefined);
        assert.deepStrictEqual(state.definitionCellIds('b', 'x + 2', 'toString'), []);
    });
});
