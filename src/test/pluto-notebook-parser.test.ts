import * as assert from 'assert';
import {
    parse,
    serialize,
    isPlutoInternalCell,
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

const NOTEBOOK_WITH_INTERNAL_CELLS = `### A Pluto.jl notebook ###
# v0.20.19

using Markdown
using InteractiveUtils

# ╔═╡ abcdef01-1234-5678-abcd-ef0123456789
1 + 1

# ╔═╡ 00000000-0000-0000-0000-000000000001
PLUTO_PROJECT_TOML_CONTENTS = """
[deps]
Example = "7876af07-990d-54b4-ab0e-23690620f79a"
"""

# ╔═╡ 00000000-0000-0000-0000-000000000002
PLUTO_MANIFEST_TOML_CONTENTS = """
# This file is machine-generated
[[deps.Example]]
git-tree-sha1 = "abc123"
uuid = "7876af07-990d-54b4-ab0e-23690620f79a"
version = "0.5.3"
"""

# ╔═╡ Cell order:
# ╠═abcdef01-1234-5678-abcd-ef0123456789
# ╟─00000000-0000-0000-0000-000000000001
# ╟─00000000-0000-0000-0000-000000000002`;

const NOTEBOOK_WITHOUT_INTERNAL_CELLS = `### A Pluto.jl notebook ###
# v0.20.19

using Markdown
using InteractiveUtils

# ╔═╡ abcdef01-1234-5678-abcd-ef0123456789
1 + 1

# ╔═╡ Cell order:
# ╠═abcdef01-1234-5678-abcd-ef0123456789`;

suite('PlutoNotebookParser - internal cells', () => {
    test('isPlutoInternalCell: recognizes known internal IDs', () => {
        assert.strictEqual(isPlutoInternalCell('00000000-0000-0000-0000-000000000001'), true);
        assert.strictEqual(isPlutoInternalCell('00000000-0000-0000-0000-000000000002'), true);
        assert.strictEqual(isPlutoInternalCell('abcdef01-1234-5678-abcd-ef0123456789'), false);
    });

    test('parse collects internal cells into internalCells map', () => {
        const notebook = parse(NOTEBOOK_WITH_INTERNAL_CELLS);
        assert.strictEqual(notebook.internalCells.size, 2);
        assert.ok(notebook.internalCells.has('00000000-0000-0000-0000-000000000001'));
        assert.ok(notebook.internalCells.has('00000000-0000-0000-0000-000000000002'));

        const projectToml = notebook.internalCells.get('00000000-0000-0000-0000-000000000001') || '';
        assert.ok(projectToml.includes('PLUTO_PROJECT_TOML_CONTENTS'));
        assert.ok(projectToml.includes('Example'));

        const manifestToml = notebook.internalCells.get('00000000-0000-0000-0000-000000000002') || '';
        assert.ok(manifestToml.includes('PLUTO_MANIFEST_TOML_CONTENTS'));
        assert.ok(manifestToml.includes('0.5.3'));
    });

    test('parse excludes internal cells from cells and cellOrder', () => {
        const notebook = parse(NOTEBOOK_WITH_INTERNAL_CELLS);
        assert.strictEqual(notebook.cells.size, 1);
        assert.ok(notebook.cells.has('abcdef01-1234-5678-abcd-ef0123456789'));
        assert.ok(!notebook.cells.has('00000000-0000-0000-0000-000000000001'));
        assert.ok(!notebook.cells.has('00000000-0000-0000-0000-000000000002'));
        assert.deepStrictEqual(notebook.cellOrder, ['abcdef01-1234-5678-abcd-ef0123456789']);
    });

    test('parse returns empty internalCells for notebook without them', () => {
        const notebook = parse(NOTEBOOK_WITHOUT_INTERNAL_CELLS);
        assert.strictEqual(notebook.internalCells.size, 0);
        assert.strictEqual(notebook.cells.size, 1);
    });

    test('serialize writes internal cells after regular cells and before cell order', () => {
        const notebook = parse(NOTEBOOK_WITH_INTERNAL_CELLS);
        const output = serialize(notebook);
        const lines = output.split('\n');

        const regularCellPos = lines.findIndex((line) => line === '# ╔═╡ abcdef01-1234-5678-abcd-ef0123456789');
        const projectCellPos = lines.findIndex((line) => line === '# ╔═╡ 00000000-0000-0000-0000-000000000001');
        const manifestCellPos = lines.findIndex((line) => line === '# ╔═╡ 00000000-0000-0000-0000-000000000002');
        const cellOrderPos = lines.findIndex((line) => line === '# ╔═╡ Cell order:');

        assert.ok(regularCellPos > 0, 'regular cell should exist');
        assert.ok(projectCellPos > 0, 'project toml cell should exist');
        assert.ok(manifestCellPos > 0, 'manifest toml cell should exist');
        assert.ok(cellOrderPos > 0, 'cell order should exist');

        assert.ok(regularCellPos < projectCellPos, 'regular cell before project cell');
        assert.ok(projectCellPos < manifestCellPos, 'project cell before manifest cell');
        assert.ok(manifestCellPos < cellOrderPos, 'internal cells before cell order');
    });

    test('serialize writes internal cells in cell order with folded marker', () => {
        const notebook = parse(NOTEBOOK_WITH_INTERNAL_CELLS);
        const output = serialize(notebook);
        const lines = output.split('\n');
        const cellOrderStart = lines.findIndex((line) => line === '# ╔═╡ Cell order:');
        const cellOrderLines = lines.slice(cellOrderStart + 1).filter((line) => line.startsWith('# '));

        assert.ok(cellOrderLines.some((line) => line === '# ╠═abcdef01-1234-5678-abcd-ef0123456789'));
        assert.ok(cellOrderLines.some((line) => line === '# ╟─00000000-0000-0000-0000-000000000001'));
        assert.ok(cellOrderLines.some((line) => line === '# ╟─00000000-0000-0000-0000-000000000002'));

        const regularIdx = cellOrderLines.findIndex((line) => line.includes('abcdef01'));
        const projectIdx = cellOrderLines.findIndex((line) => line.includes('000000000001'));
        const manifestIdx = cellOrderLines.findIndex((line) => line.includes('000000000002'));
        assert.ok(regularIdx < projectIdx);
        assert.ok(projectIdx < manifestIdx);
    });

    test('serialize without internal cells does not add internal markers', () => {
        const notebook = parse(NOTEBOOK_WITHOUT_INTERNAL_CELLS);
        const output = serialize(notebook);
        assert.ok(!output.includes('00000000-0000-0000-0000-000000000001'));
        assert.ok(!output.includes('00000000-0000-0000-0000-000000000002'));
    });

    test('round-trip preserves internal cells', () => {
        const notebook1 = parse(NOTEBOOK_WITH_INTERNAL_CELLS);
        const serialized = serialize(notebook1);
        const notebook2 = parse(serialized);

        assert.strictEqual(notebook2.internalCells.size, 2);
        assert.strictEqual(
            notebook2.internalCells.get('00000000-0000-0000-0000-000000000001'),
            notebook1.internalCells.get('00000000-0000-0000-0000-000000000001')
        );
        assert.strictEqual(
            notebook2.internalCells.get('00000000-0000-0000-0000-000000000002'),
            notebook1.internalCells.get('00000000-0000-0000-0000-000000000002')
        );
        assert.strictEqual(notebook2.cells.size, 1);
        assert.deepStrictEqual(notebook2.cellOrder, notebook1.cellOrder);
    });
});
