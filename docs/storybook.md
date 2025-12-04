---
title: Storybook
description: Develop and test UI components in isolation
---

Storybook is a tool for developing and testing UI components in isolation. It provides a sandboxed environment where you can build, view, and test components without running the full Electron application.

## Starting Storybook

```bash
make storybook
# or
bun run storybook
```

This will start the Storybook development server at `http://localhost:6006`.

## Building Static Storybook

To build a static version of Storybook that can be deployed:

```bash
make storybook-build
# or
bun run storybook:build
```

The output will be in `storybook-static/`.

## Writing Stories

Stories are colocated with their components. For example, `ErrorMessage.tsx` has its stories in `ErrorMessage.stories.tsx` in the same directory.

### Basic Story Structure

```typescript
import type { Meta, StoryObj } from "@storybook/react";
import { MyComponent } from "./MyComponent";

const meta = {
  title: "Components/MyComponent",
  component: MyComponent,
  parameters: {
    layout: "centered", // or "fullscreen" or "padded"
  },
  tags: ["autodocs"], // Enables automatic documentation
} satisfies Meta<typeof MyComponent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    prop1: "value1",
    prop2: "value2",
  },
};

export const Variant: Story = {
  args: {
    prop1: "different value",
    prop2: "another value",
  },
};
```

### Component Examples

See the existing stories for reference:

- `src/components/ErrorMessage.stories.tsx` - Simple component with multiple states
- `src/components/Modal.stories.tsx` - Complex component with children and multiple variants

## Global Styles

Storybook automatically applies the same global styles as the main app:

- Color variables (`GlobalColors`)
- Font definitions (`GlobalFonts`)
- Scrollbar styles (`GlobalScrollbars`)

These are configured in `.storybook/preview.tsx`.

## Handling Electron APIs

Some components depend on `window.api` for Electron IPC communication. For these components:

1. **Preferred**: Extract the component logic to accept props instead of calling IPC directly
2. **Alternative**: Mock the `window.api` object in `.storybook/preview.tsx`

Example mock structure:

```typescript
window.api = {
  workspace: {
    create: async () => ({ success: true, metadata: { ... } }),
    list: async () => ({ success: true, workspaces: [...] }),
    // ...
  },
  // ... other IPC channels
};
```

## Benefits

- **Isolated Development**: Build components without running the full Electron app
- **Visual Testing**: See all component states at once
- **Documentation**: Stories serve as living documentation with `autodocs`
- **Faster Iteration**: Hot reload is faster than Electron rebuilds
- **Accessibility**: Storybook addons can check accessibility issues

## Configuration

- `.storybook/main.ts` - Main Storybook configuration
- `.storybook/preview.tsx` - Global decorators and parameters
- `tsconfig.json` - Includes `.storybook/**/*.ts` for type checking

## Tips

- Keep stories simple and focused on visual states
- Use Storybook's Controls addon to make props interactive
- Add multiple stories for different states (loading, error, success, etc.)
- Use the `tags: ["autodocs"]` option to generate automatic documentation
