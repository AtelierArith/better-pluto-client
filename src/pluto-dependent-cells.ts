import * as vscode from 'vscode';
import { getCellId } from './PlutoNotebookSerializer';
import { PlutoNavigationState } from './pluto-navigation';

export interface DependentCellChoice extends vscode.QuickPickItem {
    cellId: string;
    code: string;
}

export interface DependentCellsUI {
    activeEditor(): vscode.NotebookEditor | undefined;
    pick(items: DependentCellChoice[]): PromiseLike<DependentCellChoice | undefined>;
    inform(message: string): void;
}

const defaultUI: DependentCellsUI = {
    activeEditor: () => vscode.window.activeNotebookEditor,
    pick: items => vscode.window.showQuickPick(items, {
        title: 'Pluto: Show Dependent Cells',
        placeHolder: 'Direct downstream cells, not exact source references',
        matchOnDescription: true,
        matchOnDetail: true,
    }),
    inform: message => { void vscode.window.showInformationMessage(message); },
};

/** Cell-level topology navigation. No lexical reference locations are inferred. */
export async function showDependentCells(
    getNavigation: (notebook: vscode.NotebookDocument) => PlutoNavigationState | undefined,
    ui: DependentCellsUI = defaultUI
): Promise<void> {
    const editor = ui.activeEditor();
    if (!editor || editor.notebook.notebookType !== 'pluto-notebook' ||
        editor.notebook.isClosed || editor.selection.start >= editor.notebook.cellCount) {
        ui.inform('Open a Pluto notebook and select a cell first.');
        return;
    }
    const notebook = editor.notebook;
    const source = notebook.cellAt(editor.selection.start);
    const sourceId = getCellId(source);
    const sourceCode = source.document.getText();
    const navigation = getNavigation(notebook);
    const dependents = sourceId && navigation?.dependentCells(sourceId, sourceCode);
    if (!navigation || !dependents) {
        ui.inform('Start the Pluto kernel and run or synchronize this cell before showing dependent cells.');
        return;
    }
    const byId = new Map(dependents.map(item => [item.cellId, item.symbols]));
    const choices: DependentCellChoice[] = [];
    for (const cell of notebook.getCells()) {
        const id = getCellId(cell);
        const symbols = byId.get(id);
        const code = cell.document.getText();
        if (!symbols || !navigation.matchesCode(id, code)) { continue; }
        choices.push({
            cellId: id,
            code,
            label: `Cell ${cell.index + 1}`,
            description: symbols.join(', '),
            detail: code.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 160) ?? '(empty cell)',
        });
    }
    if (choices.length === 0) {
        ui.inform(dependents.length === 0 ? 'This cell has no direct dependent cells.' : 'Dependent cells have unsynchronized changes. Run or synchronize them first.');
        return;
    }
    const selected = await ui.pick(choices);
    if (!selected) { return; }
    // The picker is asynchronous: the notebook, kernel, graph and cells may have
    // changed while it was open. Never reveal a stale index or another notebook.
    const currentEditor = ui.activeEditor();
    const currentNavigation = getNavigation(notebook);
    if (!currentEditor || currentEditor.notebook !== notebook || notebook.isClosed || currentNavigation !== navigation) { return; }
    const currentSource = notebook.getCells().find(cell => getCellId(cell) === sourceId);
    const target = notebook.getCells().find(cell => getCellId(cell) === selected.cellId);
    const currentDependents = currentSource && navigation.dependentCells(sourceId, currentSource.document.getText());
    if (!currentSource || currentSource.document.getText() !== sourceCode || !target ||
        target.document.getText() !== selected.code || !navigation.matchesCode(selected.cellId, selected.code) ||
        !currentDependents?.some(item => item.cellId === selected.cellId)) {
        ui.inform('The notebook changed while the picker was open. Show dependent cells again.');
        return;
    }
    const range = new vscode.NotebookRange(target.index, target.index + 1);
    currentEditor.selection = range;
    currentEditor.revealRange(range, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
}
