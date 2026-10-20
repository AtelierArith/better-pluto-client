import * as assert from 'assert';
import * as vscode from 'vscode';
import { PlutoDefinitionProvider, isSimpleGlobalReference } from '../pluto-definition-provider';
import { PlutoNavigationState } from '../pluto-navigation';

suite('Pluto cross-cell definitions', () => {
    test('declines lexical constructs where cell topology cannot resolve the selected occurrence', () => {
        for (const code of [
            'f(x) = x + 1', 'let x = 1; x end', 'map(x -> x, xs) + x',
            '[x for x in xs] + x', 'begin\nx + 1\nend', '# x', '"x" * string(x)',
            'f(; x=x)', 'x + a.x', ':x', '@macro x', 'function f(x); x; end',
        ]) {
            const offset = code.lastIndexOf('x');
            assert.strictEqual(isSimpleGlobalReference(code, offset), false, code);
        }
        assert.strictEqual(isSimpleGlobalReference('y = x + 2', 4), true);
        assert.strictEqual(isSimpleGlobalReference('y = x + 2', 0), false);
        assert.strictEqual(isSimpleGlobalReference('α + 2', 0), true);
    });
    async function fixture(symbol = 'x') {
        const definition = await vscode.workspace.openTextDocument({ language: 'julia', content: `${symbol} = 1` });
        const reference = await vscode.workspace.openTextDocument({ language: 'julia', content: `${symbol} + 2` });
        const cell = (document: vscode.TextDocument, id: string) => ({ document, metadata: { custom: { id } } } as unknown as vscode.NotebookCell);
        const notebook = { notebookType: 'pluto-notebook', getCells: () => [cell(reference, 'b'), cell(definition, 'a')] } as unknown as vscode.NotebookDocument;
        const navigation = new PlutoNavigationState();
        navigation.applyNotebookDiff({ message: { patches: [{ path: [], op: 'replace', value: {
            cell_inputs: { a: { code: definition.getText() }, b: { code: reference.getText() } },
            cell_dependencies: { b: { upstream_cells_map: { [symbol]: ['a'] } } },
        } }] } });
        return { definition, reference, notebook, navigation, provider: new PlutoDefinitionProvider(() => navigation, () => [notebook]) };
    }
    test('navigates to the defining cell URI even when it is visually later', async () => {
        const { provider, reference, definition } = await fixture();
        const locations = provider.provideDefinition(reference, new vscode.Position(0, 0));
        assert.strictEqual(locations.length, 1);
        assert.strictEqual(locations[0].uri.toString(), definition.uri.toString());
        assert.strictEqual(locations[0].range.start.line, 0);
    });
    test('supports Unicode globals reported by Pluto', async () => {
        const { provider, reference, definition } = await fixture('α');
        assert.strictEqual(provider.provideDefinition(reference, new vscode.Position(0, 0))[0].uri.toString(), definition.uri.toString());
    });
    test('returns no result for stopped kernels or unrelated documents', async () => {
        const { notebook, reference, navigation } = await fixture();
        assert.deepStrictEqual(new PlutoDefinitionProvider(() => undefined, () => [notebook]).provideDefinition(reference, new vscode.Position(0, 0)), []);
        assert.deepStrictEqual(new PlutoDefinitionProvider(() => navigation, () => []).provideDefinition(reference, new vscode.Position(0, 0)), []);
    });
    test('does not navigate to a target whose code has changed locally', async () => {
        const { provider, reference, definition } = await fixture();
        const edit = new vscode.WorkspaceEdit();
        edit.replace(definition.uri, new vscode.Range(0, 0, 0, 5), 'y = 1');
        assert.ok(await vscode.workspace.applyEdit(edit));
        assert.deepStrictEqual(provider.provideDefinition(reference, new vscode.Position(0, 0)), []);
    });
});
