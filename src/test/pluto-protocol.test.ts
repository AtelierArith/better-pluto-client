import * as assert from 'assert';
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
