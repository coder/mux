# @coder/mux-chat-components

Shared chat components for rendering Mux conversations. Used by the Mux desktop app and mux.md viewer.

## Installation

```bash
npm install @coder/mux-chat-components
# or
bun add @coder/mux-chat-components
```

## Usage

### Basic Example

```tsx
import {
  MessageRenderer,
  ChatHostContextProvider,
  ThemeProvider,
  createReadOnlyContext,
  type DisplayedMessage,
} from "@coder/mux-chat-components";

// Import CSS variables
import "@coder/mux-chat-components/styles";

function ConversationViewer({ messages }: { messages: DisplayedMessage[] }) {
  return (
    <ThemeProvider defaultTheme="dark">
      <ChatHostContextProvider value={createReadOnlyContext()}>
        <div className="mux-chat-components">
          {messages.map((message) => (
            <MessageRenderer key={message.historyId} message={message} />
          ))}
        </div>
      </ChatHostContextProvider>
    </ThemeProvider>
  );
}
```

### Components

| Component          | Description                                                |
| ------------------ | ---------------------------------------------------------- |
| `MessageRenderer`  | Routes messages to appropriate components based on type    |
| `MessageWindow`    | Base window wrapper for messages with buttons and metadata |
| `UserMessage`      | Renders user messages with copy functionality              |
| `AssistantMessage` | Renders assistant messages with markdown rendering         |
| `ReasoningMessage` | Renders thinking/reasoning content (collapsible)           |
| `GenericToolCall`  | Renders tool invocations with expandable details           |
| `MarkdownRenderer` | Basic markdown-to-HTML rendering                           |

### Contexts

| Context                   | Description                                         |
| ------------------------- | --------------------------------------------------- |
| `ChatHostContextProvider` | Controls feature availability (editing, copy, etc.) |
| `ThemeProvider`           | Manages theme state (dark/light/solarized)          |

### Types

The package exports types for:

- `MuxMessage` - Raw message format from Mux history
- `DisplayedMessage` - UI-ready message types for rendering
- `SharedConversation` - Format for sharing conversations via mux.md

## Theme Support

The package supports four themes:

- `dark` (default)
- `light`
- `solarized-dark`
- `solarized-light`

Set the theme via `ThemeProvider`:

```tsx
<ThemeProvider defaultTheme="light">
  {/* or */}
<ThemeProvider forcedTheme="dark">
```

## Read-Only Mode

For static viewers like mux.md, use `createReadOnlyContext()`:

```tsx
import { createReadOnlyContext, ChatHostContextProvider } from "@coder/mux-chat-components";

// Disables editing, review notes, command palette
// Keeps copy and JSON view enabled
<ChatHostContextProvider value={createReadOnlyContext()}>{children}</ChatHostContextProvider>;
```

## CSS Variables

The package uses CSS variables for theming. Import the stylesheet:

```css
@import "@coder/mux-chat-components/styles";
```

Or import in your JavaScript:

```ts
import "@coder/mux-chat-components/styles";
```

## Development

```bash
cd packages/chat-components
bun install
bun run typecheck
bun run build
```

## License

AGPL-3.0-only
