## Models

See also:

- [System Prompt](./system-prompt.md)

mux supports multiple AI providers through its flexible provider architecture.

### Supported Providers

#### Anthropic (Cloud)

Best supported provider with full feature support:

- `anthropic:claude-sonnet-4-5`
- `anthropic:claude-opus-4-1`

#### OpenAI (Cloud)

GPT-5 family of models:

- `openai:gpt-5`
- `openai:gpt-5-pro`

#### Google (Cloud)

Access Gemini models directly via Google's generative AI API:

- `google:gemini-3-pro-preview`
- `google:gemini-2.5-pro`
- `google:gemini-2.5-flash`

**Setup:**

1. Get your API key from [Google AI Studio](https://aistudio.google.com/)
2. Add to `~/.mux/providers.jsonc`:

```jsonc
{
  "google": {
    "apiKey": "AIza...",
  },
}
```

- `openai:gpt-5-codex`

**Note:** Anthropic models are better supported than GPT-5 class models due to an outstanding issue in the Vercel AI SDK.

TODO: add issue link here.

#### xAI (Grok)

Frontier reasoning models from xAI with built-in search orchestration:

- `xai:grok-4` — Fast unified model (switches between reasoning/non-reasoning based on thinking toggle)
- `xai:grok-code` — Optimized for coding tasks

**Setup:**

1. Create an API key at [console.x.ai](https://console.x.ai/)
2. Add to `~/.mux/providers.jsonc`:

```jsonc
{
  "xai": {
    "apiKey": "sk-xai-...",
  },
}
```

**Search orchestration:**

Mux enables Grok's live search by default using `mode: "auto"` with citations. Add [`searchParameters`](https://docs.x.ai/docs/resources/search) to `providers.jsonc` if you want to customize the defaults (e.g., regional focus, time filters, or disabling search entirely per workspace).

#### OpenRouter (Cloud)

Access 300+ models from multiple providers through a single API:

- `openrouter:z-ai/glm-4.6`
- `openrouter:anthropic/claude-3.5-sonnet`
- `openrouter:google/gemini-2.0-flash-thinking-exp`
- `openrouter:deepseek/deepseek-chat`
- `openrouter:openai/gpt-4o`
- Any model from [OpenRouter Models](https://openrouter.ai/models)

**Setup:**

1. Get your API key from [openrouter.ai](https://openrouter.ai/)
2. Add to `~/.mux/providers.jsonc`:

```jsonc
{
  "openrouter": {
    "apiKey": "sk-or-v1-...",
  },
}
```

**Provider Routing (Advanced):**

OpenRouter can route requests to specific infrastructure providers (Cerebras, Fireworks, Together, etc.). Configure provider preferences in `~/.mux/providers.jsonc`:

```jsonc
{
  "openrouter": {
    "apiKey": "sk-or-v1-...",
    // Use Cerebras for ultra-fast inference
    "order": ["Cerebras", "Fireworks"], // Try in order
    "allow_fallbacks": true, // Allow other providers if unavailable
  },
}
```

Or require a specific provider (no fallbacks):

```jsonc
{
  "openrouter": {
    "apiKey": "sk-or-v1-...",
    "order": ["Cerebras"], // Only try Cerebras
    "allow_fallbacks": false, // Fail if Cerebras unavailable
  },
}
```

**Provider Routing Options:**

- `order`: Array of provider names to try in priority order (e.g., `["Cerebras", "Fireworks"]`)
- `allow_fallbacks`: Boolean - whether to fall back to other providers (default: `true`)
- `only`: Array - restrict to only these providers
- `ignore`: Array - exclude specific providers
- `require_parameters`: Boolean - only use providers supporting all your request parameters
- `data_collection`: `"allow"` or `"deny"` - control whether providers can store/train on your data

See [OpenRouter Provider Routing docs](https://openrouter.ai/docs/features/provider-routing) for details.

**Reasoning Models:**

OpenRouter supports reasoning models like Claude Sonnet Thinking. Use the thinking slider to control reasoning effort:

- **Off**: No extended reasoning
- **Low**: Quick reasoning for straightforward tasks
- **Medium**: Standard reasoning for moderate complexity (default)
- **High**: Deep reasoning for complex problems

The thinking level is passed to OpenRouter as `reasoning.effort` and works with any reasoning-capable model. See [OpenRouter Reasoning docs](https://openrouter.ai/docs/use-cases/reasoning-tokens) for details.

#### Ollama (Local)

Run models locally with Ollama. No API key required:

- `ollama:gpt-oss:20b`
- `ollama:gpt-oss:120b`
- `ollama:qwen3-coder:30b`
- Any model from the [Ollama Library](https://ollama.com/library)

**Setup:**

1. Install Ollama from [ollama.com](https://ollama.com)
2. Pull a model: `ollama pull gpt-oss:20b`
3. That's it! Ollama works out-of-the-box with no configuration needed.

**Custom Configuration** (optional):

By default, mux connects to Ollama at `http://localhost:11434/api`. To use a remote instance or custom port, add to `~/.mux/providers.jsonc`:

```jsonc
{
  "ollama": {
    "baseUrl": "http://your-server:11434/api",
  },
}
```

### Provider Configuration

All providers are configured in `~/.mux/providers.jsonc`. Example configurations:

```jsonc
{
  // Required for Anthropic models
  "anthropic": {
    "apiKey": "sk-ant-...",
  },
  // Required for OpenAI models
  "openai": {
    "apiKey": "sk-...",
  },
  // Required for Google models
  "google": {
    "apiKey": "AIza...",
  },
  // Required for Grok models
  "xai": {
    "apiKey": "sk-xai-...",
  },
  // Required for OpenRouter models
  "openrouter": {
    "apiKey": "sk-or-v1-...",
  },
  // Optional for Ollama (only needed for custom URL)
  "ollama": {
    "baseUrl": "http://your-server:11434/api",
  },
}
```

### Model Selection

The quickest way to switch models is with the keyboard shortcut:

- **macOS:** `Cmd+/`
- **Windows/Linux:** `Ctrl+/`

Alternatively, use the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

1. Type "model"
2. Select "Change Model"
3. Choose from available models

Models are specified in the format: `provider:model-name`
