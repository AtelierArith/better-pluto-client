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
