---
title: Models
description: Configure AI providers including Anthropic, OpenAI, Google, xAI, and more
---

See also:

- [System Prompt](/system-prompt)

mux supports multiple AI providers through its flexible provider architecture.

### Supported Providers

#### Anthropic (Cloud)

Best supported provider with full feature support:

- `anthropic:claude-sonnet-4-5`
- `anthropic:claude-opus-4-5`
- `anthropic:claude-haiku-4-5`

**Setup:**

Anthropic can be configured via `~/.mux/providers.jsonc` or environment variables:

```jsonc
{
  "anthropic": {
    "apiKey": "sk-ant-...",
    // Optional: custom base URL (mux auto-appends /v1 if missing)
    "baseUrl": "https://api.anthropic.com",
  },
}
```

Or set environment variables:

- `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` — API key (required if not in providers.jsonc)
- `ANTHROPIC_BASE_URL` — Custom base URL (optional)

**Note:** Environment variables are read automatically if no config is provided. The `/v1` path suffix is normalized automatically—you can omit it from base URLs.

#### OpenAI (Cloud)

GPT-5 family of models:

- `openai:gpt-5.1`
- `openai:gpt-5-pro`
- `openai:gpt-5.1-codex`
- `openai:gpt-5.1-codex-max` — supports the XHIGH (extra high) thinking level; aliases: `gpt-5.1-codex-max`, `codex-max`
- `openai:gpt-5.1-codex-mini`

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

**Note:** Anthropic models are better supported than GPT-5 class models due to an outstanding issue in the Vercel AI SDK.

TODO: add issue link here.

#### xAI (Grok)

Frontier reasoning models from xAI with built-in search orchestration:

- `xai:grok-4-1-fast` — Fast unified model (switches between reasoning/non-reasoning based on thinking toggle)
- `xai:grok-code-fast-1` — Optimized for coding tasks

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

#### Amazon Bedrock (Cloud)

Access Anthropic Claude and other models through AWS Bedrock:

- `bedrock:us.anthropic.claude-sonnet-4-20250514-v1:0`
- `bedrock:us.amazon.nova-pro-v1:0`

Model IDs follow the Bedrock format: `[region.]vendor.model-name-version`. mux automatically parses these for display (e.g., `us.anthropic.claude-sonnet-4-20250514-v1:0` displays as "Sonnet 4").

**Authentication Options:**

Bedrock supports multiple authentication methods, tried in order:

1. **Bearer Token** (simplest) — A single API key for Bedrock access
2. **Explicit Credentials** — Access Key ID + Secret Access Key in config
3. **AWS Credential Chain** — Automatic credential resolution (recommended for AWS environments)

**Option 1: Bearer Token**

The simplest approach if you have a Bedrock API key:

```jsonc
{
  "bedrock": {
    "region": "us-east-1",
    "bearerToken": "your-bedrock-api-key",
  },
}
```

Or set via environment variable:

```bash
export AWS_REGION=us-east-1
export AWS_BEARER_TOKEN_BEDROCK=your-bedrock-api-key
```

**Option 2: Explicit AWS Credentials**

Use IAM access keys directly:

```jsonc
{
  "bedrock": {
    "region": "us-east-1",
    "accessKeyId": "AKIA...",
    "secretAccessKey": "...",
  },
}
```

**Option 3: AWS Credential Chain (Recommended for AWS)**

If no explicit credentials are provided, mux uses the AWS SDK's `fromNodeProviderChain()` which automatically resolves credentials from (in order):

1. **Environment variables** — `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
2. **Shared credentials file** — `~/.aws/credentials` (supports profiles via `AWS_PROFILE`)
3. **SSO credentials** — AWS IAM Identity Center (configure with `aws sso login`)
4. **EC2 instance profile** — Automatic on EC2 instances with IAM roles
5. **ECS task role** — Automatic in ECS containers
6. **EKS Pod Identity / IRSA** — Automatic in Kubernetes with IAM Roles for Service Accounts

For region, mux checks `AWS_REGION` and `AWS_DEFAULT_REGION` environment variables, so standard AWS CLI configurations work automatically.

This means if you're already authenticated with AWS CLI (`aws sso login` or configured credentials), mux will automatically use those credentials:

```jsonc
{
  "bedrock": {
    "region": "us-east-1",
    // No credentials needed — uses AWS credential chain
  },
}
```

**Required IAM Permissions:**

Your AWS credentials need the `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` permissions for the models you want to use.

### Provider Configuration

All providers are configured in `~/.mux/providers.jsonc`. Example configurations:

```jsonc
{
  // Anthropic: config OR env vars (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL)
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
  // Bedrock (uses AWS credential chain if no explicit credentials)
  "bedrock": {
    "region": "us-east-1",
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
