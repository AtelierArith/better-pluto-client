# Modern Pluto Client

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
- Some Pluto-specific features (like bind widgets) may not render in VS Code outputs

## License

MIT
