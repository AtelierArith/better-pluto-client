import * as assert from 'assert';
import { encode } from '@msgpack/msgpack';
import { PlutoServer } from '../PlutoServer';

suite('Pluto navigation server integration', () => {
    test('retains dependency updates from decoded messages and clears them on stop', () => {
        const server = new PlutoServer({ logger: () => undefined });
        const message = { type: 'notebook_diff', message: { patches: [{ op: 'replace', path: [], value: {
            cell_inputs: { a: { code: 'x = 1' }, b: { code: 'x + 2' } },
            cell_order: ['b', 'a'],
            cell_dependencies: { b: { upstream_cells_map: { x: ['a'] } } },
        } }] } };
        const harness = server as unknown as { handleMessage(data: Buffer): void };
        harness.handleMessage(Buffer.from(encode(message)));
        assert.deepStrictEqual(server.navigation.definitionCellIds('b', 'x + 2', 'x'), ['a']);
        server.stop();
        assert.deepStrictEqual(server.navigation.definitionCellIds('b', 'x + 2', 'x'), []);
    });
});

suite('Pluto navigation refresh after edits', () => {
    test('refreshes unchanged topology once after a fast terminal run, never from an unrelated cell', () => {
        const server = new PlutoServer({ logger: () => undefined });
        let requests = 0;
        server.requestFullState = () => { requests++; };
        const harness = server as unknown as { handleMessage(data: Buffer): void };
        const send = (patches: unknown[]) => harness.handleMessage(Buffer.from(encode({ type: 'notebook_diff', message: { patches } })));
        const snapshot = (code: string) => [{ op: 'replace', path: [], value: {
            cell_inputs: { a: { code: 'x = 1' }, b: { code } },
            cell_order: ['a', 'b'],
            cell_dependencies: { b: { upstream_cells_map: { x: ['a'] } } },
            cell_results: { a: { running: false, queued: false }, b: { running: false, queued: false } },
        } }];
        send(snapshot('x + 2'));
        send([{ op: 'replace', path: ['cell_inputs', 'b', 'code'], value: 'x + 3' }]);
        assert.strictEqual(server.navigation.needsRefresh, true);
        send([{ op: 'replace', path: ['cell_dependencies', 'a'], value: { upstream_cells_map: {} } }]);
        assert.deepStrictEqual(server.navigation.definitionCellIds('b', 'x + 3', 'x'), []);
        send([{ op: 'replace', path: ['cell_results', 'a', 'running'], value: false }]);
        assert.strictEqual(requests, 0);
        // A snapshot while awaiting execution is not itself evidence of a run.
        send(snapshot('x + 3'));
        assert.strictEqual(requests, 0);
        assert.strictEqual(server.navigation.needsRefresh, true);
        send([{ op: 'replace', path: ['cell_results', 'b', 'running'], value: false }]);
        assert.strictEqual(requests, 1);
        send([{ op: 'replace', path: ['cell_results', 'b', 'running'], value: false }]);
        assert.strictEqual(requests, 1);
        send(snapshot('x + 3'));
        assert.strictEqual(server.navigation.needsRefresh, false);
        assert.deepStrictEqual(server.navigation.definitionCellIds('b', 'x + 3', 'x'), ['a']);
        assert.strictEqual(requests, 1);
        send([{ op: 'replace', path: ['cell_inputs', 'b', 'code'], value: 'x + 4' }]);
        send([
            { op: 'replace', path: ['cell_results', 'b', 'running'], value: false },
            { op: 'replace', path: ['cell_results', 'b', 'queued'], value: true },
        ]);
        assert.strictEqual(requests, 1, 'A queued cell is not terminal, regardless of patch order');
        send([{ op: 'replace', path: ['cell_results', 'b', 'queued'], value: false }]);
        assert.strictEqual(requests, 2);
        send(snapshot('x + 4'));
        assert.deepStrictEqual(server.navigation.definitionCellIds('b', 'x + 4', 'x'), ['a']);
        server.stop();
    });
});
