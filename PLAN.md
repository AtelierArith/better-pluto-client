# Modern Pluto Client - 設計仕様書

## 概要

Pluto.jl ノートブックを VS Code/Cursor 内で表示・編集・実行するための拡張機能。

## 目標

### Phase 1: 基本機能（Standalone モード） ✅ 完了
- [x] .jl ファイルを Pluto ノートブック形式で表示
- [x] セルの編集
- [x] セルの追加・削除
- [x] セルの実行（独立した Julia プロセス）
- [x] エラー表示

### Phase 2: Pluto.jl 接続 ← 次のステップ
- [ ] Pluto.jl サーバーの起動・管理
- [ ] WebSocket 接続
- [ ] セル間の状態共有（リアクティブ実行）
- [ ] 依存関係に基づく自動再実行

---

## Phase 2: Pluto.jl 統合の設計

### 現在の問題
- 各セルが独立した Julia プロセスで実行される
- セル間で変数を共有できない（`x = 2` → `y = 2x` でエラー）

### 解決策: Pluto.jl サーバー接続

```
┌────────────────────────────────────────────┐
│ VS Code Extension                          │
│                                            │
│  PlutoEditorProvider                       │
│       │                                    │
│       ▼                                    │
│  PlutoServer.ts (NEW)                      │
│  - Pluto.jl プロセス起動                   │
│  - WebSocket 接続管理                      │
│       │                                    │
│       ▼ WebSocket                          │
└────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│ Pluto.jl Server (Julia)                    │
│  - セッション管理                          │
│  - リアクティブ実行                        │
│  - 依存関係解析                            │
└────────────────────────────────────────────┘
```

### 実装ステップ

1. **PlutoServer.ts** - サーバー起動・接続
   ```typescript
   class PlutoServer {
       start(notebookPath: string): Promise<void>
       runCell(cellId: string): Promise<void>
       updateCell(cellId: string, code: string): Promise<void>
       onStateChange(callback): void
       stop(): void
   }
   ```

2. **Julia 起動コード**
   ```julia
   import Pluto
   Pluto.run(
       launch_browser=false,
       port=PORT,
       require_secret_for_access=false
   )
   ```

3. **WebSocket プロトコル**（MessagePack）
   - `run_multiple_cells` - セル実行
   - `update_notebook` - セル更新
   - `notebook_diff` - 状態変更通知

---

## アーキテクチャ

### シンプルな構成

```
┌────────────────────────────────────────────┐
│ VS Code Extension                          │
│                                            │
│  extension.ts                              │
│       │                                    │
│       ▼                                    │
│  PlutoEditorProvider.ts                    │
│  (CustomTextEditorProvider)                │
│       │                                    │
│       ├──▶ Webview (HTML/JS)              │
│       │    - セル表示                      │
│       │    - Monaco Editor                 │
│       │                                    │
│       └──▶ JuliaExecutor.ts               │
│            - Julia プロセス起動            │
│            - コード実行                    │
└────────────────────────────────────────────┘
```

---

## ファイル構成

```
src/
├── extension.ts              # エントリーポイント
├── PlutoEditorProvider.ts    # カスタムエディタ（メイン）
├── PlutoNotebookParser.ts    # .jl パーサー
└── JuliaExecutor.ts          # Julia 実行
```

---

## 1. extension.ts

エントリーポイント。PlutoEditorProvider を登録するだけ。

```typescript
import * as vscode from 'vscode';
import { PlutoEditorProvider } from './PlutoEditorProvider';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        PlutoEditorProvider.register(context)
    );
}

export function deactivate() {}
```

---

## 2. PlutoEditorProvider.ts

CustomTextEditorProvider を実装。

### 責務
- Webview の作成・管理
- ドキュメントと Webview の同期
- メッセージハンドリング

### メッセージプロトコル

**Webview → Extension:**
| type | data | 説明 |
|------|------|------|
| `ready` | - | Webview 準備完了 |
| `updateCell` | `{cellId, code}` | セルコード更新 |
| `runCell` | `{cellId}` | セル実行 |
| `addCell` | `{afterCellId?}` | セル追加 |
| `deleteCell` | `{cellId}` | セル削除 |

**Extension → Webview:**
| type | data | 説明 |
|------|------|------|
| `notebook` | `{cells, cellOrder}` | ノートブック全体 |
| `cellResult` | `{cellId, output, error?, runtime}` | 実行結果 |
| `cellRunning` | `{cellId, running}` | 実行状態 |

### Webview HTML 構造

```html
<!DOCTYPE html>
<html>
<head>
    <style>/* CSS */</style>
</head>
<body>
    <div id="app"></div>
    <script>
        const vscode = acquireVsCodeApi();

        // 状態
        let notebook = null;

        // メッセージ受信
        window.addEventListener('message', e => {
            const msg = e.data;
            if (msg.type === 'notebook') {
                notebook = msg;
                render();
            }
            // ...
        });

        // 準備完了通知
        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>
```

---

## 3. PlutoNotebookParser.ts

Pluto.jl の .jl ファイル形式をパース。

### 形式

```julia
### A Pluto.jl notebook ###
# v0.20.0

using Markdown
using InteractiveUtils

# ╔═╡ cell-uuid-here
code here

# ╔═╡ another-cell-uuid
more code

# ╔═╡ Cell order:
# ╠═cell-uuid-here
# ╠═another-cell-uuid
```

### インターフェース

```typescript
interface PlutoCell {
    id: string;
    code: string;
}

interface PlutoNotebook {
    version: string;
    cells: Map<string, PlutoCell>;
    cellOrder: string[];
    preamble: string;
}

function parse(content: string): PlutoNotebook;
function serialize(notebook: PlutoNotebook): string;
```

---

## 4. JuliaExecutor.ts

Julia コードを実行。

### シンプルな実装

```typescript
import { spawn } from 'child_process';

export async function executeJulia(code: string): Promise<{
    output: string;
    error?: string;
    runtime: number;
}> {
    const start = Date.now();

    return new Promise((resolve) => {
        const proc = spawn('julia', ['-e', code]);
        let output = '';
        let error = '';

        proc.stdout.on('data', d => output += d);
        proc.stderr.on('data', d => error += d);

        proc.on('close', () => {
            resolve({
                output: output.trim(),
                error: error.trim() || undefined,
                runtime: Date.now() - start
            });
        });
    });
}
```

---

## 開発コマンド

```bash
# 依存関係インストール
yarn install

# ビルド
yarn compile

# 開発（ウォッチ）
yarn watch

# デバッグ実行
# Cursor/VS Code で F5
```

---

## 実装順序

1. **PlutoNotebookParser.ts** - パーサー実装
2. **JuliaExecutor.ts** - 実行エンジン
3. **PlutoEditorProvider.ts** - エディタ本体
4. **extension.ts** - 登録

---

## テスト用ノートブック

`samples/test.jl`:
```julia
### A Pluto.jl notebook ###
# v0.20.0

using Markdown
using InteractiveUtils

# ╔═╡ 00000001-0000-0000-0000-000000000001
1 + 1

# ╔═╡ 00000002-0000-0000-0000-000000000002
println("Hello")

# ╔═╡ Cell order:
# ╠═00000001-0000-0000-0000-000000000001
# ╠═00000002-0000-0000-0000-000000000002
```
