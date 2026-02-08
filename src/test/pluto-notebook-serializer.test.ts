import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    PlutoNotebookSerializer,
    isPlutoNotebookMetadata,
    isPlutoCellMetadata,
    toNotebookMetadata,
    toCellMetadata,
} from '../PlutoNotebookSerializer';
import { parse as parsePluto } from '../PlutoNotebookParser';

suite('PlutoNotebookSerializer', () => {
    test('deserialize: empty file creates single empty cell with defaults', () => {
        const serializer = new PlutoNotebookSerializer();
        const data = serializer.deserializeNotebook(new Uint8Array(), new vscode.CancellationTokenSource().token);

        assert.strictEqual(data.cells.length, 1);
        assert.strictEqual(data.cells[0].value, '');
        assert.strictEqual(data.cells[0].languageId, 'julia');
        const meta = data.metadata?.custom as { version?: string; preamble?: string } | undefined;
        assert.strictEqual(meta?.version, '0.20.0');
        assert.strictEqual(meta?.preamble, '');
    });

    test('deserialize: folded cell gets leading newline and folded metadata', () => {
        const serializer = new PlutoNotebookSerializer();
        const id = '11111111-1111-1111-1111-111111111111';
        const content = [
            '### A Pluto.jl notebook ###',
            '# v0.20.0',
            '',
            `# ╔═╡ ${id}`,
            'x = 1',
            '',
            '# ╔═╡ Cell order:',
            `# ╟─${id}`,
            ''
        ].join('\n');

        const data = serializer.deserializeNotebook(new TextEncoder().encode(content), new vscode.CancellationTokenSource().token);
        const cell = data.cells[0];

        assert.ok(cell.value.startsWith('\n'));
        assert.strictEqual(cell.metadata?.inputCollapsed, true);
        const custom = cell.metadata?.custom as { id?: string; folded?: boolean } | undefined;
        assert.strictEqual(custom?.id, id);
        assert.strictEqual(custom?.folded, true);
    });

    test('deserialize: preserves internalCells in notebook metadata', () => {
        const serializer = new PlutoNotebookSerializer();
        const id = '11111111-1111-1111-1111-111111111111';
        const internal1 = '00000000-0000-0000-0000-000000000001';
        const content = [
            '### A Pluto.jl notebook ###',
            '# v0.20.0',
            '',
            `# ╔═╡ ${id}`,
            'x = 1',
            '',
            `# ╔═╡ ${internal1}`,
            '[deps]',
            'Foo = "123"',
            '',
            '# ╔═╡ Cell order:',
            `# ╠═${id}`,
            `# ╟─${internal1}`,
            ''
        ].join('\n');

        const data = serializer.deserializeNotebook(new TextEncoder().encode(content), new vscode.CancellationTokenSource().token);
        const meta = data.metadata?.custom as { internalCells?: Record<string, string> } | undefined;
        assert.ok(meta?.internalCells);
        assert.strictEqual(meta?.internalCells?.[internal1], '[deps]\nFoo = "123"');
    });

    test('serialize: inputCollapsed takes precedence for folded state', () => {
        const serializer = new PlutoNotebookSerializer();
        const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '\nfoo = 1', 'julia');
        cell.metadata = {
            inputCollapsed: true,
            custom: { id, folded: false }
        };

        const notebookData = new vscode.NotebookData([cell]);
        notebookData.metadata = { custom: { version: '0.20.0', preamble: '' } };

        const bytes = serializer.serializeNotebook(notebookData, new vscode.CancellationTokenSource().token);
        const text = new TextDecoder().decode(bytes);

        // Cell order should mark folded
        assert.ok(text.includes(`# ╟─${id}`));

        // Leading newline should be stripped in serialized content
        assert.ok(text.includes(`# ╔═╡ ${id}\nfoo = 1`));

        // Double newline (empty line) should not appear immediately after marker
        assert.ok(!text.includes(`# ╔═╡ ${id}\n\nfoo = 1`));
    });

    test('serialize: round-trips internalCells through metadata', () => {
        const serializer = new PlutoNotebookSerializer();
        const id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        const internal1 = '00000000-0000-0000-0000-000000000001';

        const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'x = 1', 'julia');
        cell.metadata = { custom: { id, folded: false } };

        const notebookData = new vscode.NotebookData([cell]);
        notebookData.metadata = {
            custom: {
                version: '0.20.0',
                preamble: '',
                internalCells: {
                    [internal1]: 'internal = true'
                }
            }
        };

        const bytes = serializer.serializeNotebook(notebookData, new vscode.CancellationTokenSource().token);
        const text = new TextDecoder().decode(bytes);
        const parsed = parsePluto(text);

        assert.ok(parsed.internalCells.has(internal1));
        assert.strictEqual(parsed.internalCells.get(internal1), 'internal = true');
    });

    test('serialize: internal cells are written after normal cells', () => {
        const serializer = new PlutoNotebookSerializer();
        const id1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const id2 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
        const internal1 = '00000000-0000-0000-0000-000000000001';

        const cell1 = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'x = 1', 'julia');
        cell1.metadata = { custom: { id: id1, folded: false } };
        const cell2 = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'y = 2', 'julia');
        cell2.metadata = { custom: { id: id2, folded: false } };

        const notebookData = new vscode.NotebookData([cell1, cell2]);
        notebookData.metadata = {
            custom: {
                version: '0.20.0',
                preamble: '',
                internalCells: {
                    [internal1]: 'internal = true'
                }
            }
        };

        const bytes = serializer.serializeNotebook(notebookData, new vscode.CancellationTokenSource().token);
        const text = new TextDecoder().decode(bytes);

        const idxCell1 = text.indexOf(`# ╔═╡ ${id1}`);
        const idxCell2 = text.indexOf(`# ╔═╡ ${id2}`);
        const idxInternal = text.indexOf(`# ╔═╡ ${internal1}`);

        assert.ok(idxCell1 !== -1);
        assert.ok(idxCell2 !== -1);
        assert.ok(idxInternal !== -1);
        assert.ok(idxInternal > idxCell1);
        assert.ok(idxInternal > idxCell2);
    });
});

suite('Metadata type validation (#80)', () => {
    suite('isPlutoNotebookMetadata', () => {
        test('accepts valid metadata', () => {
            assert.strictEqual(isPlutoNotebookMetadata({ version: '0.20.0', preamble: '' }), true);
            assert.strictEqual(isPlutoNotebookMetadata({ version: '0.20.0', preamble: '', internalCells: { a: 'b' } }), true);
        });

        test('rejects null/undefined/non-object', () => {
            assert.strictEqual(isPlutoNotebookMetadata(null), false);
            assert.strictEqual(isPlutoNotebookMetadata(undefined), false);
            assert.strictEqual(isPlutoNotebookMetadata('string'), false);
            assert.strictEqual(isPlutoNotebookMetadata(42), false);
        });

        test('rejects missing required fields', () => {
            assert.strictEqual(isPlutoNotebookMetadata({ preamble: '' }), false);
            assert.strictEqual(isPlutoNotebookMetadata({ version: '0.20.0' }), false);
            assert.strictEqual(isPlutoNotebookMetadata({}), false);
        });

        test('rejects wrong field types', () => {
            assert.strictEqual(isPlutoNotebookMetadata({ version: 123, preamble: '' }), false);
            assert.strictEqual(isPlutoNotebookMetadata({ version: '0.20.0', preamble: null }), false);
            assert.strictEqual(isPlutoNotebookMetadata({ version: '0.20.0', preamble: '', internalCells: 'bad' }), false);
        });
    });

    suite('isPlutoCellMetadata', () => {
        test('accepts valid metadata', () => {
            assert.strictEqual(isPlutoCellMetadata({ id: 'abc-123' }), true);
            assert.strictEqual(isPlutoCellMetadata({ id: 'abc-123', folded: true }), true);
            assert.strictEqual(isPlutoCellMetadata({ id: 'abc-123', folded: false }), true);
        });

        test('rejects null/undefined/non-object', () => {
            assert.strictEqual(isPlutoCellMetadata(null), false);
            assert.strictEqual(isPlutoCellMetadata(undefined), false);
            assert.strictEqual(isPlutoCellMetadata('string'), false);
        });

        test('rejects missing id', () => {
            assert.strictEqual(isPlutoCellMetadata({}), false);
            assert.strictEqual(isPlutoCellMetadata({ folded: true }), false);
        });

        test('rejects wrong field types', () => {
            assert.strictEqual(isPlutoCellMetadata({ id: 123 }), false);
            assert.strictEqual(isPlutoCellMetadata({ id: 'abc', folded: 'yes' }), false);
        });
    });

    suite('toNotebookMetadata', () => {
        test('passes through valid metadata', () => {
            const valid = { version: '0.20.0', preamble: '# comment' };
            const result = toNotebookMetadata(valid);
            assert.strictEqual(result.version, '0.20.0');
            assert.strictEqual(result.preamble, '# comment');
        });

        test('returns defaults for null/undefined', () => {
            const result = toNotebookMetadata(null);
            assert.strictEqual(result.version, '0.20.0');
            assert.strictEqual(result.preamble, '');
        });

        test('extracts valid fields from partial object', () => {
            const partial = { version: '0.19.0', preamble: 42, extra: true };
            const result = toNotebookMetadata(partial);
            assert.strictEqual(result.version, '0.19.0');
            assert.strictEqual(result.preamble, '');  // invalid type → default
        });
    });

    suite('toCellMetadata', () => {
        test('passes through valid metadata', () => {
            const valid = { id: 'cell-1', folded: true };
            const result = toCellMetadata(valid);
            assert.strictEqual(result.id, 'cell-1');
            assert.strictEqual(result.folded, true);
        });

        test('returns defaults for null/undefined', () => {
            const result = toCellMetadata(undefined);
            assert.strictEqual(result.id, '');
            assert.strictEqual(result.folded, false);
        });

        test('extracts valid fields from partial object', () => {
            const partial = { id: 123, folded: true };
            const result = toCellMetadata(partial);
            assert.strictEqual(result.id, '');  // invalid type → default
            assert.strictEqual(result.folded, true);
        });
    });

    test('serialize handles invalid notebook metadata gracefully', () => {
        const serializer = new PlutoNotebookSerializer();
        const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'x = 1', 'julia');
        cell.metadata = { custom: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', folded: false } };

        const notebookData = new vscode.NotebookData([cell]);
        // Invalid metadata (missing version/preamble)
        notebookData.metadata = { custom: { bad: 'data' } };

        // Should not throw — falls back to defaults
        const bytes = serializer.serializeNotebook(notebookData, new vscode.CancellationTokenSource().token);
        const text = new TextDecoder().decode(bytes);
        assert.ok(text.includes('v0.20.0'), 'should use default version');
    });

    test('serialize handles invalid cell metadata gracefully', () => {
        const serializer = new PlutoNotebookSerializer();
        const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'x = 1', 'julia');
        // Invalid cell metadata (no id)
        cell.metadata = { custom: { notAnId: 42 } };

        const notebookData = new vscode.NotebookData([cell]);
        notebookData.metadata = { custom: { version: '0.20.0', preamble: '' } };

        // Should not throw — generates a cell ID
        const bytes = serializer.serializeNotebook(notebookData, new vscode.CancellationTokenSource().token);
        const text = new TextDecoder().decode(bytes);
        assert.ok(text.includes('# ╔═╡'), 'should have cell marker with generated ID');
    });
});
