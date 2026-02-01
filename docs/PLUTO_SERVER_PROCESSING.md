# Pluto.jl サーバー側の処理（参考: ./Pluto.jl）

BetterPlutoClient が WebSocket で送るメッセージに対して、Pluto.jl 側でどのような処理が行われるかを、`Pluto.jl/src/webserver/` を元にまとめる。

---

## 1. 全体の流れ

- **WebServer.jl**: HTTP + WebSocket サーバーを起動し、クライアント接続を受け付ける。
- **Session.jl**: `ServerSession` が接続中のクライアント (`ClientSession`) とノートブック (`Notebook`) を管理。
- **Dynamic.jl**: クライアントからのメッセージ種別に応じて `responses[:type]` のハンドラを実行。
- **PutUpdates.jl**: サーバー→クライアントの通知を `UpdateMessage` として送信（`notebook_diff` など）。

---

## 2. 状態の表現（Notebook）

- **Notebook.jl**: ノートブックは `cells_dict::Dict{UUID,Cell}` と `cell_order::Vector{UUID}` で表現される。
  - `cells_dict`: セル ID → セル（コード・メタデータ・結果など）の辞書。
  - `cell_order`: 表示順のセル ID 配列。
  - `notebook.cells` は `cell_order` に沿って `cells_dict` から並べたベクター。
  - `notebook.cell_inputs` は getproperty で `cells_dict` を返す（Firebasey 用）。

---

## 3. クライアント→サーバー: 主なメッセージと処理

### 3.1 `connect`

- **Dynamic.jl** `responses[:connect]`
- 接続確認。`👋` と `notebook_exists` などを返す。

### 3.2 `reset_shared_state`

- **Dynamic.jl** `responses[:reset_shared_state]`
- そのクライアントの `current_state_for_clients` を削除し、`send_notebook_changes!` で**ノートブック全体**を `notebook_diff`（patches の replace [] = フル状態）として送る。

### 3.3 `update_notebook`（セル追加・並び・コード変更）

- **Dynamic.jl** `responses[:update_notebook]`
- 受信 body の `updates` は **Firebasey の JSONPatch の配列**（`path`, `op`, `value`）。

処理の流れ:

1. **クライアント状態への適用**  
   各 patch を `Firebasey.applypatch!(current_state_for_clients[client], patch)` で適用（クライアントごとの「最後に知っている状態」を更新）。

2. **Notebook への適用と「効果」**  
   各 patch に対して `effects_of_changed_state` で path に応じた処理を実行:
   - **`cell_order`** (ReplacePatch):  
     `Firebasey.applypatch!(request.notebook, patch)` → `notebook.cell_order` を `value` で置き換え。  
     → `[FileChanged()]` を返す（保存などに使う）。
   - **`cell_inputs`** (Add / Replace / Remove 等):  
     `Firebasey.applypatch!(request.notebook, patch)` → `notebook.cells_dict`（= `cell_inputs`）を更新。  
     → パスが `code` なら `[CodeChanged(), FileChanged()]`、それ以外は `[FileChanged()]` など。

3. **重要**: `applypatch!` は **path に従って** `notebook` のプロパティ/フィールドを書き換えるだけ。
   - `cell_order` の replace → `notebook.cell_order = value`
   - `cell_inputs` への add → `notebook.cells_dict[id] = value`（Cell 相当の Dict）
   - **「cell_order に含まれるが cells_dict にない ID を消す」ような正規化はここでは行っていない**。  
     パッチをそのまま順に適用するだけ。

4. **変更後の通知**  
   `FileChanged()` のみならファイル保存、`CodeChanged()` があれば後続の `run_multiple_cells` などに任せる。  
   最後に `send_notebook_changes!(🙋; commentary=...)` で、**現在のノートブック状態**と各クライアントの前回状態の **diff** を計算し、`notebook_diff` で送る。

つまり、**1 回の `update_notebook` に「cell_order の replace」と「cell_inputs の add」を両方含めれば、同じメッセージ内で両方が適用され、その状態で `send_notebook_changes!` が 1 回だけ呼ばれる**。

### 3.4 `run_multiple_cells`

- **Dynamic.jl** `responses[:run_multiple_cells]`
- body の `cells`（UUID 配列）に対し、`🙋.notebook.cells_dict[uuid]` でセルを取得。
  - **ここで `cells_dict` に無い ID が含まれていると例外になる。**  
    そのため、新規セルを実行する前に、同じノートブック状態として「cell_order への追加」と「cell_inputs への add」の両方が適用されている必要がある。
- 取得したセルを `update_save_run!` に渡し、依存関係を解決してから `run_reactive_async!` で実行。
- 実行結果は `send_notebook_changes!` 経由で `notebook_diff` としてクライアントに送られる。

---

## 4. サーバー→クライアント: `notebook_diff`

- **PutUpdates.jl** で `UpdateMessage(:notebook_diff, response, notebook, ...)` を送信。
- **Dynamic.jl** の `send_notebook_changes!` で:
  - `notebook_to_js(notebook)` でノートブックを「JS 用の 1 つの Dict」に変換（`cell_order`, `cell_inputs`, `cell_results` など）。
  - 各クライアントの `current_state_for_clients[client]` との **Firebasey.diff** を計算。
  - 差分だけを `patches` として送る（`replace []` のときはフル状態）。

クライアントはこの `notebook_diff` でセルの実行結果（`cell_results`）や `cell_order` の変更を受け取る。

---

## 5. BetterPlutoClient への示唆

1. **新規セルを 1 回で認識させる**  
   `cell_order` の replace と `cell_inputs` の add を**同じ `update_notebook` の `updates` にまとめて送る**と、Pluto は両方を適用したあとで 1 回だけ `send_notebook_changes!` する。  
   別々のメッセージにすると、その間に `notebook_diff` が飛び、クライアントやサーバー側の「状態」が一瞬不整合になり得る。

2. **run_multiple_cells の前にセルがいること**  
   `run_multiple_cells` は `notebook.cells_dict[uuid]` を参照するため、**先にその uuid が `cell_inputs`（= `cells_dict`）に存在している必要がある**。  
   その意味でも、新規セルは「cell_order + cell_inputs を 1 メッセージで追加」してから `run_multiple_cells` を送るのが安全。

3. **正規化の有無**  
   今回参照した範囲では、`update_notebook` のハンドラ内で「cell_order と cells_dict を一致させるためにセルを消す」ような処理は見当たらない。  
   パッチを順に適用し、その結果をそのまま `notebook_to_js` で diff して送っている。

---

## 6. 参照した主なファイル

| ファイル | 役割 |
|----------|------|
| `Pluto.jl/src/webserver/WebServer.jl` | HTTP/WebSocket サーバー起動 |
| `Pluto.jl/src/webserver/Session.jl` | ServerSession / ClientSession / UpdateMessage |
| `Pluto.jl/src/webserver/Dynamic.jl` | responses（update_notebook, run_multiple_cells, connect, reset_shared_state 等）、notebook_to_js、effects_of_changed_state、send_notebook_changes! |
| `Pluto.jl/src/webserver/PutUpdates.jl` | putnotebookupdates!、send_message、flushclient |
| `Pluto.jl/src/webserver/Firebasey.jl` | applypatch!（AddPatch / ReplacePatch / RemovePatch）、diff |
| `Pluto.jl/src/notebook/Notebook.jl` | Notebook 構造（cells_dict, cell_order）、cell_inputs getproperty |
| `Pluto.jl/src/evaluation/Run.jl` | update_save_run!、run_reactive_async!、reactive 実行 |
