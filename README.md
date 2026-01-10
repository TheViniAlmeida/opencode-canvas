# opencode-canvas

Interactive terminal canvases for [OpenCode](https://opencode.ai) - spawn rich TUI interfaces for calendars, documents, flight bookings, and more directly from your AI coding assistant.

![Canvas Demo](https://github.com/mailshieldai/opencode-canvas/raw/main/media/screenshot.png)

## What is this?

opencode-canvas gives OpenCode its own display. Instead of text-only responses, the AI can spawn interactive terminal interfaces in tmux split panes. This enables:

- **Calendar views** - Visual date pickers and event displays
- **Document editors** - Rich text editing with selections
- **Flight booking** - Interactive flight search and selection
- **Custom canvases** - Build your own TUI interfaces

## Requirements

- [Bun](https://bun.sh) - JavaScript runtime
- [tmux](https://github.com/tmux/tmux) - Canvases spawn in split panes
- [OpenCode](https://opencode.ai) - AI coding assistant

## Installation

### From npm

```bash
npm install @mailshieldai/opencode-canvas
# or
bun add @mailshieldai/opencode-canvas
```

### From source

```bash
git clone https://github.com/mailshieldai/opencode-canvas
cd opencode-canvas
bun install
bun run build
```

## Configuration

Add to your `opencode.jsonc` (in project root or `~/.config/opencode/config.json`):

```jsonc
{
  "plugin": ["@mailshieldai/opencode-canvas"],
  "permission": {
    "canvas_*": "allow"
  }
}
```

## Tools

The plugin provides 4 tools:

| Tool | Description |
|------|-------------|
| `canvas_spawn` | Create a new canvas (calendar, document, or flight) |
| `canvas_update` | Update canvas state via IPC |
| `canvas_selection` | Get current selection from canvas |
| `canvas_close` | Close a canvas session |

### canvas_spawn

Spawns a new canvas in a tmux split pane.

```typescript
canvas_spawn({
  canvas_type: "calendar" | "document" | "flight",
  initial_state: { /* canvas-specific state */ }
})
```

### canvas_update

Updates the state of an existing canvas.

```typescript
canvas_update({
  session_id: "canvas-abc123",
  state: { /* new state */ }
})
```

### canvas_selection

Retrieves the current selection from a canvas (e.g., selected date, highlighted text).

```typescript
canvas_selection({
  session_id: "canvas-abc123"
})
```

### canvas_close

Closes a canvas and cleans up resources.

```typescript
canvas_close({
  session_id: "canvas-abc123"
})
```

## Skills

The plugin includes skills that teach OpenCode how to use each canvas type:

- `canvas` - General canvas usage patterns
- `calendar` - Calendar-specific interactions
- `document` - Document editing patterns
- `flight` - Flight booking workflows

## Architecture

```
┌─────────────────┐     IPC (Unix Socket)     ┌─────────────────┐
│   OpenCode      │◄──────────────────────────►│  Canvas TUI     │
│   (Controller)  │                            │  (React/Ink)    │
└─────────────────┘                            └─────────────────┘
        │                                              │
        │ tool calls                                   │ renders in
        ▼                                              ▼
┌─────────────────┐                            ┌─────────────────┐
│  opencode-canvas│                            │  tmux split     │
│  plugin         │                            │  pane           │
└─────────────────┘                            └─────────────────┘
```

## Development

```bash
# Install dependencies
bun install

# Build plugin
bun run build

# Run tests
bun test

# Lint
bun run lint
```

## Publishing to npm

```bash
# Login to npm (one-time)
npm login

# Build and publish
bun run build
npm publish
```

## License

MIT - See [LICENSE](LICENSE) for details.

## Credits

Based on [claude-canvas](https://github.com/dvdsgl/claude-canvas) by David Siegel, adapted for OpenCode by [MailShield AI](https://github.com/mailshieldai).
