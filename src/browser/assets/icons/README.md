# Provider Icons

This directory contains SVG icons for AI providers displayed in the UI.

## Current icons

| File | Provider | Source |
|------|----------|--------|
| `anthropic.svg` | Anthropic | [Brand assets](https://www.anthropic.com/brand) |
| `openai.svg` | OpenAI | [Brand guidelines](https://openai.com/brand) |
| `aws.svg` | Amazon Bedrock | [AWS Architecture Icons](https://aws.amazon.com/architecture/icons/) |
| `mux.svg` | Mux Gateway | Internal |

## Adding a new icon

1. **Get the official SVG** from the provider's brand/press kit
2. **Optimize the SVG** - remove unnecessary metadata, comments, and attributes
3. **Ensure single color** - icons should use `fill="currentColor"` or a class like `.st0` that can be styled via CSS
4. **Name the file** `{provider}.svg` matching the provider key in `src/common/constants/providers.ts`
5. **Register in ProviderIcon** - add to `PROVIDER_ICONS` map in `src/browser/components/ProviderIcon.tsx`:

```tsx
import NewProviderIcon from "@/browser/assets/icons/newprovider.svg?react";

const PROVIDER_ICONS: Partial<Record<ProviderName | "mux-gateway", React.FC>> = {
  // ...existing icons
  newprovider: NewProviderIcon,
};
```

## SVG requirements

- Monochrome (single fill color)
- Use classes (`.st0`) or `currentColor` for fills so the icon inherits text color
- Reasonable viewBox (icons are rendered at 1em × 1em)
- No embedded raster images
