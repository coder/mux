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

#### Vercel AI Gateway (Cloud)

Access hundreds of AI models through Vercel's unified gateway with automatic failover and monitoring:

- `gateway:openai/gpt-5`
- `gateway:anthropic/claude-sonnet-4-5`
- `gateway:xai/grok-4`
- `gateway:google/gemini-3-pro-preview`
- Any model from [Vercel AI Gateway Models](https://vercel.com/docs/ai-gateway/models-and-providers)

**Setup:**

1. Get your API key from [Vercel AI Gateway](https://vercel.com/ai-gateway)
2. Add to `~/.mux/providers.jsonc`:

```jsonc
{
  "gateway": {
    "apiKey": "vai_...",
  },
}
```

**Features:**

- **Unified API**: Access 100+ models from OpenAI, Anthropic, xAI, Google, and more
- **High Reliability**: Automatic failover to other providers if one fails
- **No Markup**: Tokens cost the same as directly from providers (0% markup with BYOK)
- **Spend Monitoring**: Track usage across providers
- **Provider Routing**: Configure fallback chains and model preferences

**Bring Your Own Key (BYOK):**

You can configure your own provider credentials through the Vercel dashboard to use existing provider accounts:

```jsonc
{
  "gateway": {
    "apiKey": "vai_...",
    // BYOK credentials configured through Vercel dashboard
  },
}
```

See [Vercel AI Gateway Documentation](https://vercel.com/docs/ai-gateway) for details.

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
  // Required for Vercel AI Gateway models
  "gateway": {
    "apiKey": "vai_...",
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
