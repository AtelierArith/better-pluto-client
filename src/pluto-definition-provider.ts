import * as vscode from 'vscode';
import { getCellId } from './PlutoNotebookSerializer';
import { PlutoNavigationState } from './pluto-navigation';

/** Pluto knows which cell defines a global, but not its precise source range. */
export class PlutoDefinitionProvider implements vscode.DefinitionProvider {
    constructor(
        private readonly getNavigation: (notebook: vscode.NotebookDocument) => PlutoNavigationState | undefined,
        private readonly getNotebooks: () => readonly vscode.NotebookDocument[] = () => vscode.workspace.notebookDocuments
    ) {}

    provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Location[] {
        const notebook = this.getNotebooks().find(item =>
            item.notebookType === 'pluto-notebook' && item.getCells().some(cell => cell.document.uri.toString() === document.uri.toString())
        );
        if (!notebook) { return []; }
        const source = notebook.getCells().find(cell => cell.document.uri.toString() === document.uri.toString());
        const sourceId = source && getCellId(source);
        const navigation = this.getNavigation(notebook);
        if (!sourceId || !navigation) { return []; }
        const word = document.getWordRangeAtPosition(position, /[\p{L}_][\p{L}\p{N}\p{M}_!′]*/u);
        if (!word || !isSimpleGlobalReference(document.getText(), document.offsetAt(word.start))) { return []; }
        const targetIds = new Set(navigation.definitionCellIds(sourceId, document.getText(), document.getText(word)));
        return notebook.getCells().filter(cell => {
            const id = getCellId(cell);
            return id && targetIds.has(id) && navigation.matchesCode(id, cell.document.getText());
        }).map(cell => new vscode.Location(cell.document.uri, new vscode.Position(0, 0)));
    }
}

/**
 * A dependency graph is cell-wide: it cannot distinguish a local x from a global
 * x referenced elsewhere in the same cell. Fail closed for syntax that could
 * introduce bindings or quoted names. Complex cells remain the Julia language
 * server's responsibility. This is deliberately not a Julia parser.
 */
export function isSimpleGlobalReference(code: string, offset: number): boolean {
    if (offset < 0 || offset >= code.length || /[\r\n;#"'`@:]/.test(code) || code.includes('->')) { return false; }
    const scopeKeywords = new Set([
        'function', 'macro', 'let', 'for', 'while', 'do', 'begin', 'end',
        'quote', 'module', 'baremodule', 'struct', 'type', 'where',
        'if', 'elseif', 'else', 'try', 'catch', 'finally', 'local', 'global',
        'const', 'import', 'using', 'export', 'public',
    ]);
    const words = code.match(/[\p{L}_][\p{L}\p{N}\p{M}_!′]*/gu) ?? [];
    if (words.some(word => scopeKeywords.has(word))) { return false; }
    // a.x is a property, not the global x, even when that global is used nearby.
    if (/\.\s*$/.test(code.slice(0, offset))) { return false; }
    const assignment = /^\s*[\p{L}_][\p{L}\p{N}\p{M}_!′]*\s*=(?!=)/u.exec(code);
    const expression = assignment ? code.slice(assignment[0].length) : code;
    if (assignment && offset < assignment[0].length) { return false; }
    // This also declines function definitions, keyword arguments and nested
    // assignments. Comparisons with '=' are conservatively left to the LS.
    return !expression.includes('=');
}
