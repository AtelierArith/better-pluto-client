import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildOutputItems } from '../output-utils';

// Valid one-pixel red image fixtures, generated once (no runtime image dependency).
const fixtures = [{"mime": "image/gif", "base64": "R0lGODdhAQABAIEAAP8AAAAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw=="}, {"mime": "image/bmp", "base64": "Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAADEDgAAxA4AAAAAAAAAAAAAAAD/AA=="}, {"mime": "image/jpg", "base64": "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z"}];

suite('Pluto raster outputs (real Julia)', () => {
    test('VS Code webview decodes the supported raster fixtures to one-pixel images', async function () {
        this.timeout(30_000);
        const panel = vscode.window.createWebviewPanel('pluto-raster-check', 'Raster decode check',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true });
        let listener: vscode.Disposable | undefined;
        let timer: NodeJS.Timeout | undefined;
        try {
            const decoded = new Promise<void>((resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Webview image decoding timed out')), 20_000);
                listener = panel.webview.onDidReceiveMessage(message => {
                    if (message.ok === true) { resolve(); }
                    else { reject(new Error(`Webview image decoding failed: ${JSON.stringify(message)}`)); }
                });
            });
            const images = fixtures.map(fixture => {
                const [item] = buildOutputItems({ mime: fixture.mime, body: fixture.base64 });
                return item.type === 'binary'
                    ? `<img src="data:${item.mime};base64,${Buffer.from(item.content as Uint8Array).toString('base64')}">`
                    : item.content as string;
            }).join('');
            panel.webview.html = `<!DOCTYPE html><html><body>${images}<script>
                const vscode = acquireVsCodeApi();
                Promise.all([...document.images].map(img => new Promise((resolve, reject) => {
                    const check = () => img.naturalWidth === 1 && img.naturalHeight === 1 ? resolve() : reject('wrong dimensions');
                    img.onload = check;
                    img.onerror = () => reject('image decode error');
                    if (img.complete) check();
                }))).then(() => vscode.postMessage({ok: true}), error => vscode.postMessage({ok: false, error}));
            </script></body></html>`;
            await decoded;
        } finally {
            if (timer) { clearTimeout(timer); }
            listener?.dispose();
            panel.dispose();
        }
    });

    test('GIF, BMP and JPG arrive as displayable output without text-encoded image bytes', async function () {
        if (process.env.RUN_PLUTO_E2E !== '1') { this.skip(); return; }
        this.timeout(180_000);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'better-pluto-raster-'));
        const file = path.join(dir, 'Raster.jl');
        const ids = ['41111111-1111-4111-8111-111111111111', '42222222-2222-4222-8222-222222222222', '43333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
        const codes = [
            `begin
    using Base64
    struct Raster{M}
        data::Vector{UInt8}
    end
    Base.show(io::IO, ::MIME{M}, image::Raster{M}) where M = write(io, image.data)
end`,
            ...fixtures.map(({ mime, base64 }) => `Raster{Symbol("${mime}")}(base64decode("${base64}"))`),
        ];
        fs.writeFileSync(file, '### A Pluto.jl notebook ###\n# v0.20.28\n\nusing Markdown\nusing InteractiveUtils\n\n' +
            codes.map((code, i) => `# ╔═╡ ${ids[i]}\n${code}\n`).join('\n') + '\n# ╔═╡ Cell order:\n' + ids.map(id => `# ╠═${id}`).join('\n') + '\n');
        try {
            await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'pluto-notebook');
            const notebook = vscode.window.activeNotebookEditor?.notebook;
            assert.ok(notebook);
            await vscode.commands.executeCommand('pluto-notebook.startKernel');
            const deadline = Date.now() + 120_000;
            for (let i = 0; i < fixtures.length; i++) {
                const fixture = fixtures[i];
                const expectedMime = fixture.mime === 'image/bmp' ? 'application/vnd.pluto.html+html' : fixture.mime === 'image/jpg' ? 'image/jpeg' : fixture.mime;
                const cell: vscode.NotebookCell = notebook.cellAt(i + 1);
                let item: vscode.NotebookCellOutputItem | undefined;
                while (!(item = cell.outputs.flatMap(output => output.items).find(output => output.mime === expectedMime))) {
                    if (Date.now() > deadline) { throw new Error(`No displayable output for ${fixture.mime}`); }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                if (fixture.mime === 'image/bmp') {
                    assert.strictEqual(Buffer.from(item.data).toString(), `<img src="data:image/bmp;base64,${fixture.base64}" alt="Pluto bitmap output">`);
                } else {
                    assert.deepStrictEqual(Buffer.from(item.data), Buffer.from(fixture.base64, 'base64'));
                }
            }
        } finally {
            await vscode.commands.executeCommand('pluto-notebook.stopKernel');
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
