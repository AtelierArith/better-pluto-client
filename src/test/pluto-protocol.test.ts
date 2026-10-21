import * as assert from 'assert';
import { shouldEndExecution } from '../cell-state-machine';
import {
    extractLogs,
    extractOutput,
    processNotebookDiff,
    tryDecodeMsgpackBinary,
    type ProtocolRuntimeState,
} from '../pluto-protocol';

function createState(): ProtocolRuntimeState {
    return {
        cellOutputs: new Map(),
        knownCellIds: new Set(),
        cellOrder: [],
        pendingCellIds: new Set(),
    };
}

suite('pluto-protocol', () => {
    test('full cell results preserve queued state', () => {
        const result = processNotebookDiff({
            type: 'notebook_diff',
            message: { patches: [{ op: 'replace', path: [], value: {
                cell_results: { 'cell-1': { running: false, queued: true, errored: false } }
            } }] }
        }, createState());
        assert.strictEqual(result.events[0].state.running, false);
        assert.strictEqual(result.events[0].state.queued, true);
        assert.strictEqual(shouldEndExecution(result.events[0].state), false);
    });

    test('removing logs emits an explicit empty list', () => {
        const result = processNotebookDiff({
            type: 'notebook_diff',
            message: { patches: [{ op: 'remove', path: ['cell_results', 'cell-1', 'logs'] }] }
        }, createState());
        assert.deepStrictEqual(result.events[0].state.logs, []);
    });

    test('tryDecodeMsgpackBinary decodes image bytes to base64', () => {
        const bytes = new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3]);
        const output = tryDecodeMsgpackBinary(bytes, 'image/png');
        const expected = Buffer.from(bytes).toString('base64');
        assert.strictEqual(output, expected);
    });

    test('extractOutput prefers text/html in rich output object', () => {
        const output = extractOutput({ 'text/plain': 'plain', 'text/html': '<div>HTML</div>' });
        assert.strictEqual(output.mime, 'text/html');
        assert.strictEqual(output.body, '<div>HTML</div>');
    });

    test('extractOutput prefers tree+object over plain body/mime fallback', () => {
        const output = extractOutput({
            mime: 'text/plain',
            body: 'Dict',
            'application/vnd.pluto.tree+object': {
                type: 'Dict',
                prefix: 'Dict',
                prefix_short: 'Dict',
                elements: [
                    [['a', 'text/plain'], ['1', 'text/plain']],
                    [['b', 'text/plain'], ['2', 'text/plain']],
                ],
            },
        });
        assert.strictEqual(output.mime, 'application/vnd.pluto.tree+object');
        assert.ok(output.body.includes('"type":"Dict"'));
    });

    test('extractLogs supports object format', () => {
        const logs = extractLogs({
            a: { id: 'log-1', level: 'LogLevel(-555)', msg: ['hello\n', 'text/plain'], kwargs: [['progress', ['0.3', 'text/plain']]] }
        });

        assert.deepStrictEqual(logs, [{
            id: 'log-1',
            level: 'LogLevel(-555)',
            msg: 'hello\n',
            line: undefined,
            kwargs: [['progress', ['0.3', 'text/plain']]]
        }]);
    });

    test('processNotebookDiff avoids objectid-only overwrite for tree output', () => {
        const state = createState();
        state.cellOutputs.set('cell-1', {
            mime: 'application/vnd.pluto.tree+object',
            body: '{"type":"Array","elements":[[0,["1","text/plain"]]]}'
        });

        const result = processNotebookDiff({
            type: 'notebook_diff',
            message: {
                patches: [
                    {
                        op: 'replace',
                        path: ['cell_results', 'cell-1', 'output', 'body'],
                        value: 'a1b2c3d4e5f6a7'
                    }
                ]
            }
        }, state);

        assert.strictEqual(
            result.nextState.cellOutputs.get('cell-1')?.body,
            '{"type":"Array","elements":[[0,["1","text/plain"]]]}'
        );
        assert.strictEqual(result.events.length, 0);
    });

    test('processNotebookDiff emits running=false on last_run_timestamp', () => {
        const state = createState();

        const result = processNotebookDiff({
            type: 'notebook_diff',
            message: {
                patches: [
                    {
                        op: 'replace',
                        path: ['cell_results', 'cell-1', 'output', 'last_run_timestamp'],
                        value: 123
                    }
                ]
            }
        }, state);

        assert.strictEqual(result.events.length, 1);
        assert.strictEqual(result.events[0].cellId, 'cell-1');
        assert.strictEqual(result.events[0].state.running, false);
    });

    test('processNotebookDiff reaches same output regardless of patch ordering', () => {
        const initial = createState();

        const msgA = {
            type: 'notebook_diff',
            message: {
                patches: [
                    { op: 'replace', path: ['cell_results', 'cell-1', 'output', 'mime'], value: 'text/plain' },
                    { op: 'replace', path: ['cell_results', 'cell-1', 'output', 'body'], value: 'hello' },
                ]
            }
        };

        const msgB = {
            type: 'notebook_diff',
            message: {
                patches: [
                    { op: 'replace', path: ['cell_results', 'cell-1', 'output', 'body'], value: 'hello' },
                    { op: 'replace', path: ['cell_results', 'cell-1', 'output', 'mime'], value: 'text/plain' },
                ]
            }
        };

        const resA = processNotebookDiff(msgA as Record<string, unknown>, initial);
        const resB = processNotebookDiff(msgB as Record<string, unknown>, createState());

        assert.deepStrictEqual(resA.nextState.cellOutputs.get('cell-1'), resB.nextState.cellOutputs.get('cell-1'));
    });

    test('processNotebookDiff handles remove op on output body', () => {
        const state = createState();
        state.cellOutputs.set('cell-1', {
            mime: 'text/plain',
            body: 'hello'
        });

        const result = processNotebookDiff({
            type: 'notebook_diff',
            message: {
                patches: [
                    { op: 'remove', path: ['cell_results', 'cell-1', 'output', 'body'] },
                ]
            }
        }, state);

        assert.strictEqual(result.nextState.cellOutputs.get('cell-1')?.body, '');
        assert.strictEqual(result.events.length, 1);
        assert.strictEqual(result.events[0].state.output?.body, '');
    });

    test('processNotebookDiff applies nested body patch without dropping objectid', () => {
        const state = createState();
        state.cellOutputs.set('cell-1', {
            mime: 'application/vnd.pluto.tree+object',
            body: JSON.stringify({
                objectid: 'abc123def456',
                type: 'Array',
                elements: [[1, ['0.1', 'text/plain']], 'more'],
            }),
        });

        const result = processNotebookDiff({
            type: 'notebook_diff',
            message: {
                patches: [
                    {
                        op: 'replace',
                        path: ['cell_results', 'cell-1', 'output', 'body', 'elements'],
                        value: [[1, ['0.1', 'text/plain']], [2, ['0.2', 'text/plain']], 'more'],
                    },
                ],
            },
        }, state);

        const body = result.nextState.cellOutputs.get('cell-1')?.body || '';
        const parsed = JSON.parse(body) as { objectid?: string; type?: string; elements?: unknown[] };
        assert.strictEqual(parsed.objectid, 'abc123def456');
        assert.strictEqual(parsed.type, 'Array');
        assert.ok(Array.isArray(parsed.elements));
        assert.strictEqual(parsed.elements?.length, 3);
    });
});

suite('pluto-protocol raster MIME bundles', () => {
    for (const mime of ['image/gif', 'image/bmp', 'image/jpg']) {
        test(`prefers ${mime} over text fallback and preserves exact bytes`, () => {
            const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
            const output = extractOutput({ 'text/plain': 'image fallback', [mime]: bytes });
            assert.strictEqual(output.mime, mime);
            assert.strictEqual(output.body, Buffer.from(bytes).toString('base64'));
        });
    }
});

suite('pluto-protocol atomic output patches', () => {
    const diff = (patches: Array<{ path: (string | number)[]; op: string; value?: unknown }>, state = createState()) =>
        processNotebookDiff({ message: { patches } }, state);
    const patch = (field: string, value: unknown) => ({ path: ['cell_results', 'c', 'output', field], op: 'replace', value });
    const bytes = new Uint8Array([71, 73, 70, 56, 57, 97, 128, 255, 0]);
    for (const mime of ['image/gif', 'image/bmp', 'image/jpg']) {
        for (const reverse of [false, true]) {
            test(`${mime} decodes body/MIME batch losslessly (${reverse ? 'MIME first' : 'body first'})`, () => {
                const state = createState();
                state.cellOutputs.set('c', { body: 'old text', mime: 'text/plain' });
                const patches = [patch('body', bytes), patch('mime', mime)];
                if (reverse) { patches.reverse(); }
                const result = diff([...patches, { path: ['cell_results', 'c', 'running'], op: 'replace', value: false }], state);
                assert.deepStrictEqual(result.events[0].state.output, { body: Buffer.from(bytes).toString('base64'), mime });
                assert.strictEqual(result.events.filter(event => event.state.output).length, 1);
                assert.strictEqual(result.events[1].state.running, false);
                assert.deepStrictEqual(state.cellOutputs.get('c'), { body: 'old text', mime: 'text/plain' });
            });
        }
    }
    test('a later MIME message re-decodes retained raw binary bytes', () => {
        const first = diff([patch('body', bytes)]);
        const second = diff([patch('mime', 'image/gif')], first.nextState);
        assert.strictEqual(second.events[0].state.output?.body, Buffer.from(bytes).toString('base64'));
    });
    test('image to text or structured data does not reuse old binary bytes', () => {
        const initial = diff([patch('body', bytes), patch('mime', 'image/gif')]);
        const text = diff([patch('body', 'hello'), patch('mime', 'text/plain')], initial.nextState);
        assert.deepStrictEqual(text.events[0].state.output, { body: 'hello', mime: 'text/plain' });
        const object = diff([patch('body', { rows: [] }), patch('mime', 'application/vnd.pluto.table+object')], text.nextState);
        assert.deepStrictEqual(object.events[0].state.output, { body: '{"rows":[]}', mime: 'application/vnd.pluto.table+object' });
    });
    test('full replacement followed by subfield patches respects wire order', () => {
        const result = diff([
            { path: ['cell_results', 'c'], op: 'replace', value: { running: false, output: { body: 'old', mime: 'text/plain' } } },
            patch('body', bytes), patch('mime', 'image/gif'),
        ]);
        assert.strictEqual(result.events[0].state.output?.body, Buffer.from(bytes).toString('base64'));
        assert.strictEqual(result.events[0].state.output?.mime, 'image/gif');
    });
    test('removal and full snapshots discard retained bytes', () => {
        const initial = diff([patch('body', bytes), patch('mime', 'image/gif')]);
        for (const path of [['cell_results', 'c', 'output', 'body'], ['cell_results', 'c', 'output'], ['cell_results', 'c']]) {
            const removed = diff([{ path, op: 'remove' }], initial.nextState);
            const changed = diff([patch('mime', 'text/plain')], removed.nextState);
            assert.strictEqual(changed.events[0].state.output?.body, '');
        }
        const reset = diff([{ path: [], op: 'replace', value: { cell_results: {}, cell_order: [] } }], initial.nextState);
        assert.strictEqual(reset.nextState.cellOutputs.size, 0);
        const replaced = diff([{ path: ['cell_results', 'c', 'output'], op: 'replace', value: { body: 'new', mime: 'text/plain' } }], initial.nextState);
        assert.strictEqual(diff([patch('mime', 'text/plain')], replaced.nextState).events[0].state.output?.body, 'new');
    });
    test('ignored tree object identifiers cannot replace retained data through a MIME update', () => {
        const state = createState();
        const body = JSON.stringify({ objectid: '1234567890abcdef', elements: [['kept', 'text/plain']] });
        state.cellOutputs.set('c', { body, mime: 'application/vnd.pluto.tree+object' });
        const result = diff([patch('body', '1234567890abcdef'), patch('mime', 'application/vnd.pluto.tree+object')], state);
        assert.strictEqual(result.events[0].state.output?.body, body);
    });
    test('root or whole-cell replacement clears earlier output in the same batch', () => {
        for (const reset of [
            { path: [], op: 'replace', value: { cell_results: {}, cell_order: [] } },
            { path: ['cell_results', 'c'], op: 'replace', value: { running: false } },
        ]) {
            const result = diff([patch('body', bytes), patch('mime', 'image/gif'), reset]);
            assert.deepStrictEqual(result.events[0].state.output, { body: '', mime: 'text/plain' });
            assert.strictEqual(result.events.filter(event => event.state.output).length, 1);
            assert.strictEqual(result.nextState.cellOutputs.has('c'), false);
        }
    });
    test('rich bundle retains the selected raw image rather than its plain fallback', () => {
        for (const path of [['cell_results', 'c'], ['cell_results', 'c', 'output']]) {
            const output = { body: 'fallback', mime: 'text/plain', 'image/gif': bytes };
            const value = path.length === 2 ? { output } : output;
            const initial = diff([{ path, op: 'replace', value }]);
            const result = diff([patch('mime', 'image/gif')], initial.nextState);
            assert.deepStrictEqual(result.events[0].state.output, { body: Buffer.from(bytes).toString('base64'), mime: 'image/gif' });
        }
    });
    test('null whole-output replacement safely clears previous bytes', () => {
        const initial = diff([patch('body', bytes), patch('mime', 'image/gif')]);
        const result = diff([{ path: ['cell_results', 'c', 'output'], op: 'replace', value: null }], initial.nextState);
        assert.deepStrictEqual(result.events[0].state.output, { body: '', mime: 'text/plain' });
        assert.strictEqual(result.nextState.cellOutputs.get('c')?.rawBody, undefined);
    });

});
