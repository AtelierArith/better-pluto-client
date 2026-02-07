# BetterPlutoClient

A VS Code extension for editing Pluto.jl notebooks with **full native editor support**.

## Features

- **Native VS Code Notebook**: Uses VS Code's Notebook API for full editor integration
- **Julia Syntax Highlighting**: Full syntax highlighting in each cell
- **AI Completion**: Works with GitHub Copilot, Cursor AI (Cmd+K), and other AI tools
- **Julia LSP Integration**: Autocomplete, hover info, go-to-definition via Julia extension
- **Reactive Execution**: Powered by Pluto.jl kernel for reactive notebook execution
- **Standard Editor Features**: Multi-cursor, search/replace, keybindings, etc.

## Requirements

- VS Code or Cursor 1.80.0+
- Julia installed and in PATH
- Pluto.jl package installed (`using Pkg; Pkg.add("Pluto")`)
- Recommended: [Julia extension](https://marketplace.visualstudio.com/items?itemName=julialang.language-julia)

## Installation

### Install from VSIX Package

1. **Build the VSIX package**:
   ```bash
   # Install dependencies
   yarn install

   # Build the extension
   yarn compile

   npx vsce package
   ```

2. **Install in VS Code**:
   ```bash
   code --install-extension better-pluto-client-0.0.1.vsix
   ```

3. **Install in Cursor**:
   ```bash
   cursor --install-extension better-pluto-client-0.0.1.vsix
   ```

4. **Reload the editor**: Restart VS Code/Cursor or use `Cmd+Shift+P` → "Developer: Reload Window"

### Uninstall

```bash
# VS Code
code --uninstall-extension undefined_publisher.better-pluto-client

# Cursor
cursor --uninstall-extension undefined_publisher.better-pluto-client
```

## Usage

### Opening a Pluto Notebook

1. Right-click a `.jl` file in the explorer
2. Select "Open as Pluto Notebook"

Or use the command palette:
- `Pluto: Open as Pluto Notebook`

### Running Cells

- **Shift+Enter**: Run current cell and move to next
- **Ctrl+Enter** / **Cmd+Enter**: Run current cell
- Click the play button next to a cell

### Kernel Commands

- **Pluto: Start Pluto Kernel**: Start the Pluto.jl backend
- **Pluto: Stop Pluto Kernel**: Stop the kernel
- **Pluto: Restart Pluto Kernel**: Restart the kernel

## Architecture

```
┌─────────────────────────────────────┐
│  VS Code Notebook API               │
│  ┌───────────────────────────────┐  │
│  │ Cell 1 (Julia Editor)         │  │  ← Full editor features
│  │ - Syntax highlighting         │  │  ← AI completion
│  │ - LSP integration             │  │  ← Julia extension support
│  └───────────────────────────────┘  │
│  ┌───────────────────────────────┐  │
│  │ Cell 2 (Julia Editor)         │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
            │
            ▼ WebSocket (MessagePack)
┌─────────────────────────────────────┐
│  Pluto.jl Server                    │
│  - Reactive execution               │
│  - Dependency tracking              │
└─────────────────────────────────────┘
```

## File Format

This extension reads and writes standard Pluto.jl notebook files (`.jl`), which are valid Julia scripts and can be run directly.

## Known Issues

- First cell execution starts the Pluto kernel (takes ~30-60 seconds on first run)

## Development

### Project Structure

- `src/extension.ts`: extension activation, command registration, renderer messaging
- `src/PlutoNotebookController.ts`: notebook execution orchestration
- `src/PlutoServer.ts`: Pluto process / transport orchestration with DI-friendly interfaces
- `src/pluto-protocol.ts`: protocol decoding and notebook diff processing (pure logic)
- `src/cell-state-machine.ts`: execution state accumulation and completion rules (pure logic)
- `src/PlutoNotebookParser.ts`: parse/serialize Pluto `.jl` notebook format
- `src/PlutoNotebookSerializer.ts`: VS Code `NotebookData` <-> Pluto parser bridge
- `src/output-utils.ts`: output classification and rendering helpers
- `src/pluto-renderer.ts`: webview renderer for interactive HTML outputs

### Examples

Sample notebooks are under `samples/`:

- `samples/Basic.jl`
- `samples/PlotsImages.jl`
- `samples/PlutoTeachingTools.jl`

### Testing

Run the test suite:

```bash
yarn test
```

Unit tests live in `src/test/` and cover parser/serializer, protocol decoding, execution state machine, output utils, Pluto server public behavior, and renderer TOC utils.

## License

MIT
