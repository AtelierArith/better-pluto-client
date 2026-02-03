import * as assert from 'assert';
import * as vscode from 'vscode';
import { PlutoNotebookSerializer } from '../PlutoNotebookSerializer';
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
