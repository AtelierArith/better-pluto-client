# Modern Pluto Client - VS Code Extension

## プロジェクト概要

Pluto.jl リアクティブノートブックの機能を、ブラウザではなく VS Code の UI で表示・操作するための拡張機能。

## 目標

- Pluto.jl のバックエンド（Julia サーバー）に接続し、セル実行・リアクティビティを実現
- ブラウザを開かずに VS Code 内で完結したノートブック体験を提供
- Pluto.jl の既存機能（パッケージ管理、リアクティブ実行、エラー表示など）を活用

## 現在のアーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│ VS Code Extension                                        │
│  ┌─────────────────┐    ┌─────────────────────────────┐ │
│  │ PlutoWebview    │    │ JuliaExecutor               │ │
│  │ Provider        │───▶│ (独自実装)                   │ │
│  │                 │    │                             │ │
│  │ - UI表示        │    │ - spawn('julia', ['-e',...])│ │
│  │ - セル編集      │    │ - 各セル独立実行             │ │
│  └─────────────────┘    └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 現在の問題点

1. **プリアンブルが実行されない**: ノートブックの `using Markdown`, `using InteractiveUtils` は表示されるだけで、セル実行時に含まれない
2. **セル間の状態が共有されない**: 各セルが独立した Julia プロセスで実行される
3. **リアクティビティがない**: Pluto.jl の依存関係解析・自動再実行が機能しない
4. **Pluto.jl の機能を活用していない**: 独自の簡易実装のため、Pluto.jl の豊富な機能が使えない

## 目指すアーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│ VS Code Extension                                        │
│  ┌─────────────────┐    ┌─────────────────────────────┐ │
│  │ PlutoWebview    │    │ PlutoConnection             │ │
│  │ Provider        │───▶│ (WebSocket/HTTP)            │ │
│  │                 │    │                             │ │
│  │ - UI表示        │    │ - Pluto.jl API呼び出し      │ │
│  │ - セル編集      │    │ - 状態同期                   │ │
│  └─────────────────┘    └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼ WebSocket
┌─────────────────────────────────────────────────────────┐
│ Pluto.jl Server (Julia)                                  │
│  - セル実行                                              │
│  - リアクティブ依存関係管理                               │
│  - パッケージ管理                                        │
│  - エラーハンドリング                                    │
└─────────────────────────────────────────────────────────┘
```

## Pluto.jl サーバーとの接続方法

### オプション 1: Pluto.run() で起動してWebSocket接続

```julia
# Julia側
import Pluto
Pluto.run(launch_browser=false, port=1234)
```

Pluto.jl は WebSocket で以下のメッセージを送受信:
- セル追加/削除/更新
- セル実行リクエスト
- 実行結果の受信
- ノートブック状態の同期

### オプション 2: PlutoSliderServer 的なアプローチ

静的な HTML エクスポートではなく、リアルタイム接続を維持

## 実装タスク

### Phase 1: Pluto.jl サーバー接続
- [x] Pluto.jl サーバーの起動/管理 (`PlutoConnection.ts`)
- [x] WebSocket クライアント実装 (MessagePack + ws)
- [x] メッセージプロトコル理解・実装
- [x] PlutoWebviewProvider との統合（実行モード切り替え対応）
- [ ] エラーハンドリング改善
- [ ] 接続状態の UI 表示

### Phase 2: UI 連携
- [ ] セル実行結果の表示（Pluto形式）
- [ ] エラー表示（Pluto.jl フォーマット）
- [ ] リアクティブ更新の反映
- [ ] 実行中状態の表示

### Phase 3: 完全な機能
- [ ] パッケージ管理 UI
- [ ] 変数エクスプローラー
- [ ] ドキュメント表示
- [ ] セル依存関係グラフ表示

## Pluto.jl WebSocket プロトコル

### サーバー起動

```julia
import Pluto
Pluto.run(
    launch_browser=false,      # ブラウザを開かない
    host="127.0.0.1",
    port=1234,
    require_secret_for_access=false  # 開発用
)
```

### メッセージ形式

- **シリアライゼーション**: MessagePack (バイナリ)
- **ライブラリ**: `@msgpack/msgpack` (npm)

### 主要メッセージタイプ

| Client → Server | 説明 |
|-----------------|------|
| `connect` | 初期接続ハンドシェイク |
| `update_notebook` | セルコード・順序の更新 |
| `run_multiple_cells` | セル実行リクエスト |
| `interrupt_all` | 実行中断 |
| `reset_shared_state` | 状態リセット（全状態取得） |

| Server → Client | 説明 |
|-----------------|------|
| `👋` | 接続応答（セッション情報） |
| `notebook_diff` | 状態差分（JSONPatch形式） |
| `pong` | Ping応答 |

### セル実行フロー

```
Client                          Server
  │                               │
  │─── run_multiple_cells ───────▶│
  │    {cells: ["uuid1"]}         │
  │                               │ (リアクティブ実行)
  │◀─── notebook_diff ───────────│
  │    {running: true}            │
  │                               │
  │◀─── notebook_diff ───────────│
  │    {output: {...},            │
  │     running: false}           │
```

### 状態オブジェクト構造

```typescript
interface NotebookState {
    notebook_id: string;
    path: string;
    process_status: "ready" | "starting" | "waiting_for_permission";

    cell_inputs: {
        [cell_id: string]: {
            cell_id: string;
            code: string;
            code_folded: boolean;
        }
    };

    cell_results: {
        [cell_id: string]: {
            cell_id: string;
            output: any;           // レンダリング済み出力
            queued: boolean;
            running: boolean;
            errored: boolean;
            runtime: number;       // 秒
        }
    };

    cell_order: string[];          // 表示順
    cell_execution_order: string[]; // 実行順（依存関係順）
}
```

### 接続ライフサイクル

1. WebSocket接続 (`ws://host:port/`)
2. `connect` メッセージ送信
3. `👋` 応答受信
4. `reset_shared_state` で全状態取得
5. `notebook_diff` で状態差分を継続受信

## 参考資料

- `Pluto.jl/src/webserver/WebServer.jl` - WebSocket サーバー実装
- `Pluto.jl/src/webserver/Dynamic.jl` - メッセージハンドラー定義
- `Pluto.jl/src/webserver/Session.jl` - セッション管理
- `Pluto.jl/src/webserver/PutUpdates.jl` - 状態更新・差分送信
- `Pluto.jl/frontend/common/PlutoConnection.js` - クライアント実装参考

## 開発コマンド

```bash
# 依存パッケージのインストール
yarn install

# 拡張機能のビルド
yarn compile

# 開発モード（ウォッチ）
yarn watch

# パッケージ
yarn package

# Pluto接続テスト（スタンドアロン）
node test-pluto-connection.js
```

## Cursor/VS Code へのインストール

### VSIX パッケージ作成とインストール

```bash
# 1. パッケージ化（VSIX ファイル作成）
npx vsce package

# 2. Cursor にインストール
cursor --install-extension modern-pluto-client-0.0.1.vsix

# 3. インストール確認
cursor --list-extensions | grep pluto

# 4. Cursor を再起動または Cmd+Shift+P → "Developer: Reload Window"
```

### VS Code の場合

```bash
# VS Code にインストール
code --install-extension modern-pluto-client-0.0.1.vsix
```

### アンインストール

```bash
# Cursor からアンインストール
cursor --uninstall-extension undefined_publisher.modern-pluto-client

# VS Code からアンインストール
code --uninstall-extension undefined_publisher.modern-pluto-client
```

### 開発中のデバッグ実行（推奨）

VSIX を作らずに素早くテストする場合：

1. Cursor/VS Code でプロジェクトフォルダを開く
2. `F5` を押す → Extension Development Host が起動
3. そこで `.jl` ファイルを開いてテスト
4. コード変更後は `Cmd+R` でリロード

## テスト方法

### 動作確認

1. `yarn compile` でビルド
2. `npx vsce package && cursor --install-extension modern-pluto-client-0.0.1.vsix`
3. Cursor を再起動
4. `samples/Basic.jl` を開く
5. セルの追加・削除・実行をテスト

### 現在の実行モード

現在は **standalone モード**（JuliaExecutor）で動作中。

`PlutoConnection.ts` は実装済みだが、`ws` モジュールのバンドリング問題により一時的に無効化されている。

```typescript
// PlutoWebviewProvider.ts - 現在コメントアウト中
// import { PlutoConnection, CellResult } from './PlutoConnection';
```

### PlutoConnection を有効にする場合

1. `PlutoWebviewProvider.ts` のインポートを有効化
2. `executionMode` を `'pluto'` に変更
3. webpack で `ws` モジュールが正しくバンドルされるよう設定を調整

## ファイル構成

```
src/
├── extension.ts             # エントリーポイント
├── PlutoWebviewProvider.ts  # Webview UI プロバイダー
├── PlutoEditorProvider.ts   # カスタムエディタプロバイダー
├── PlutoNotebookParser.ts   # .jl ファイルパーサー
├── PlutoConnection.ts       # Pluto.jl サーバー接続 (NEW)
├── JuliaExecutor.ts         # Julia 実行（旧・独自実装）
└── CellDependencyAnalyzer.ts # 依存関係解析

Pluto.jl/                    # Pluto.jl ソースコード（参照用）
```
