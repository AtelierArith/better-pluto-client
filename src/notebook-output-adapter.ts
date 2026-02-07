import * as vscode from 'vscode';
import { buildOutputItems, renderStdoutAsHtml, type CachedOutput } from './output-utils';

export interface NotebookOutputAdapter {
    toNotebookOutputs(cellId: string, cachedOutput: CachedOutput): vscode.NotebookCellOutput[];
}

interface NotebookOutputAdapterOptions {
    parseError: (body: string, mime: string) => string;
    addErrorHints: (body: string) => string;
    renderTreeAsHtml: (body: string) => string;
}

export class VscodeNotebookOutputAdapter implements NotebookOutputAdapter {
    constructor(private readonly options: NotebookOutputAdapterOptions) {}

    toNotebookOutputs(_cellId: string, cachedOutput: CachedOutput): vscode.NotebookCellOutput[] {
        const items = buildOutputItems(cachedOutput, {
            parseError: this.options.parseError,
            addErrorHints: this.options.addErrorHints,
            renderTreeAsHtml: this.options.renderTreeAsHtml,
        });

        const outputs: vscode.NotebookCellOutput[] = [];

        for (const item of items) {
            if (item.type === 'stdout') {
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(renderStdoutAsHtml(item.content as string), 'application/vnd.pluto.html+html')
                ]));
                continue;
            }

            if (item.type === 'stderr') {
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.stderr(item.content as string)
                ]));
                continue;
            }

            if (item.type === 'binary') {
                const mime = item.mime || 'application/octet-stream';
                outputs.push(new vscode.NotebookCellOutput([
                    new vscode.NotebookCellOutputItem(item.content as Uint8Array, mime)
                ]));
                continue;
            }

            if (item.type === 'json') {
                const mime = item.mime || 'application/json';
                try {
                    const json = JSON.parse(item.content as string);
                    outputs.push(new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.json(json, mime)
                    ]));
                } catch {
                    outputs.push(new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text(item.content as string, 'text/plain')
                    ]));
                }
                continue;
            }

            outputs.push(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.text(item.content as string, item.mime || 'text/plain')
            ]));
        }

        return outputs;
    }
}
