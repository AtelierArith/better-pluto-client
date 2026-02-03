import * as assert from 'assert';
import {
    parse,
    serialize,
    detectCellKind,
    generateCellId,
    type PlutoNotebook
} from '../PlutoNotebookParser';

suite('PlutoNotebookParser', () => {
    test('parse: handles version, preamble, cells, folded, internal cells', () => {
        const id1 = '11111111-1111-1111-1111-111111111111';
        const id2 = '22222222-2222-2222-2222-222222222222';
        const internal1 = '00000000-0000-0000-0000-000000000001';

        const content = [
            '### A Pluto.jl notebook ###',
            '# v0.19.0',
            '',
            'using Foo',
            'x = 1',
            '',
            `# ╔═╡ ${id1}`,
            'a = 10',
            '',
            `# ╔═╡ ${id2}`,
            'md"""hello"""',
            '',
            `# ╔═╡ ${internal1}`,
            '[deps]',
            'Foo = "123"',
            '',
            '# ╔═╡ Cell order:',
            `# ╠═${id1}`,
            `# ╟─${id2}`,
            `# ╟─${internal1}`,
            ''
        ].join('\n');

        const notebook = parse(content);

        assert.strictEqual(notebook.version, '0.19.0');
        assert.strictEqual(notebook.preamble, 'using Foo\nx = 1');
        assert.strictEqual(notebook.cells.size, 2);
        assert.deepStrictEqual(notebook.cellOrder, [id1, id2]);
        assert.ok(notebook.foldedCells.has(id2));
        assert.ok(!notebook.foldedCells.has(id1));

        const cell1 = notebook.cells.get(id1);
        const cell2 = notebook.cells.get(id2);
        assert.ok(cell1);
        assert.ok(cell2);
        assert.strictEqual(cell1?.folded, false);
        assert.strictEqual(cell2?.folded, true);
        assert.strictEqual(cell2?.kind, 'markdown');

        assert.ok(notebook.internalCells.has(internal1));
        assert.strictEqual(notebook.internalCells.get(internal1), '[deps]\nFoo = "123"');
    });

    test('serialize: uses folded delimiter and strips leading newline', () => {
        const id1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const id2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        const internal1 = '00000000-0000-0000-0000-000000000001';

        const notebook: PlutoNotebook = {
            version: '0.20.0',
            preamble: 'using Bar',
            cells: new Map([
                [id1, { id: id1, code: 'x = 1', kind: 'code', folded: false }],
                [id2, { id: id2, code: '\nmd"""hello"""', kind: 'markdown', folded: true }],
            ]),
            cellOrder: [id1, id2],
            foldedCells: new Set([id2]),
            internalCells: new Map([[internal1, 'internal = true']]),
        };

        const output = serialize(notebook);

        assert.ok(output.includes(`# ╔═╡ ${id2}\nmd"""hello"""`));
        assert.ok(output.includes('# ╔═╡ Cell order:'));
        assert.ok(output.includes(`# ╠═${id1}`));
        assert.ok(output.includes(`# ╟─${id2}`));
        assert.ok(output.includes(`# ╟─${internal1}`));
    });

    test('detectCellKind: markdown detection', () => {
        assert.strictEqual(detectCellKind('md"""hello"""'), 'markdown');
        assert.strictEqual(detectCellKind('   md"""hello"""'), 'markdown');
        assert.strictEqual(detectCellKind('x = 1'), 'code');
    });

    test('generateCellId: returns uuid-like v4 id', () => {
        const id = generateCellId();
        assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
    });
});
