import * as assert from 'assert';
import { PlutoServer } from '../PlutoServer';

suite('PlutoServer helpers (via private access)', () => {
    test('extractOutput: decodes Uint8Array for images to base64', () => {
        const server = new PlutoServer() as any;
        const bytes = new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3]);
        const output = server.extractOutput({ body: bytes, mime: 'image/png' });
        const expected = Buffer.from(bytes).toString('base64');
        assert.strictEqual(output.mime, 'image/png');
        assert.strictEqual(output.body, expected);
    });

    test('extractOutput: decodes Uint8Array for text to utf-8', () => {
        const server = new PlutoServer() as any;
        const bytes = new Uint8Array(Buffer.from('hello', 'utf-8'));
        const output = server.extractOutput({ body: bytes, mime: 'text/plain' });
        assert.strictEqual(output.body, 'hello');
    });

    test('tryDecodeMsgpackBinary: decodes msgpack binary object to base64 for image', () => {
        const server = new PlutoServer() as any;
        const body = { type: 18, data: { 0: 137, 1: 80, 2: 78, 3: 71 } };
        const result = server.tryDecodeMsgpackBinary(body, 'image/png');
        const expected = Buffer.from(new Uint8Array([137, 80, 78, 71])).toString('base64');
        assert.strictEqual(result, expected);
    });

    test('tryDecodeMsgpackBinary: returns null for non-msgpack body', () => {
        const server = new PlutoServer() as any;
        const result = server.tryDecodeMsgpackBinary('not-json', 'text/plain');
        assert.strictEqual(result, null);
    });

    test('extractLogs: handles array and object formats', () => {
        const server = new PlutoServer() as any;
        const arrayLogs = [
            { level: 'LogLevel(-555)', msg: ['Hi\n', 'text/plain'] }
        ];
        const objectLogs = {
            a: { level: 'LogLevel(-555)', msg: ['Bye\n', 'text/plain'] }
        };

        const res1 = server.extractLogs(arrayLogs);
        assert.deepStrictEqual(res1, [{ level: 'LogLevel(-555)', msg: 'Hi\n', line: undefined }]);

        const res2 = server.extractLogs(objectLogs);
        assert.deepStrictEqual(res2, [{ level: 'LogLevel(-555)', msg: 'Bye\n', line: undefined }]);
    });

    test('handleOutputSubField: does not overwrite tree+object body with objectid-only', () => {
        const server = new PlutoServer() as any;
        const cellId = '11111111-1111-1111-1111-111111111111';

        // Seed existing tree output body (as Pluto frontend expects object content)
        server.cellOutputs.set(cellId, {
            mime: 'application/vnd.pluto.tree+object',
            body: '{"type":"Array","elements":[[0,["1","text/plain"]]]}'
        });

        // Pluto can send objectid placeholders as hex strings; should not overwrite existing tree data
        const objectIdPlaceholder = 'a1b2c3d4e5f6a7';
        server.handleOutputSubField(cellId, 'body', objectIdPlaceholder);

        const updated = server.cellOutputs.get(cellId);
        assert.strictEqual(updated.body, '{"type":"Array","elements":[[0,["1","text/plain"]]]}');
        assert.strictEqual(updated.mime, 'application/vnd.pluto.tree+object');
    });

    test('extractOutput: rich output with text/html key (TableOfContents-style)', () => {
        const server = new PlutoServer() as any;
        const output = { 'text/html': '<script>scrollIntoView</script>', 'text/plain': 'fallback' };
        const result = server.extractOutput(output);
        assert.strictEqual(result.mime, 'text/html');
        assert.strictEqual(result.body, '<script>scrollIntoView</script>');
    });

    test('extractOutput: rich output prefers text/html over text/plain', () => {
        const server = new PlutoServer() as any;
        const output = { 'text/plain': 'plain', 'text/html': '<div>HTML</div>' };
        const result = server.extractOutput(output);
        assert.strictEqual(result.mime, 'text/html');
        assert.strictEqual(result.body, '<div>HTML</div>');
    });

    test('extractOutput: rich output with only text/plain key', () => {
        const server = new PlutoServer() as any;
        const output = { 'text/plain': 'hello world' };
        const result = server.extractOutput(output);
        assert.strictEqual(result.mime, 'text/plain');
        assert.strictEqual(result.body, 'hello world');
    });

    test('extractOutput: fallback MIME key containing slash', () => {
        const server = new PlutoServer() as any;
        const output = { 'application/x-custom': 'custom content' };
        const result = server.extractOutput(output);
        assert.strictEqual(result.mime, 'application/x-custom');
        assert.strictEqual(result.body, 'custom content');
    });
});
