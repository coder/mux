# Cloudflare AI Gateway

Cloudflare AI Gateway provides a unified interface for accessing AI models from various providers with built-in features like caching, rate limiting, analytics, and cost control.

## What is Cloudflare AI Gateway?

Cloudflare AI Gateway sits between your application and AI model providers, offering:

- **Request management**: Rate limiting, request queueing, and load balancing
- **Caching**: Cache AI responses to reduce costs and improve latency
- **Analytics**: Track usage, costs, and performance across all providers
- **Cost control**: Set spending limits and monitor API usage
- **Observability**: Detailed logs of all AI requests and responses

## Setup

### 1. Create a Cloudflare AI Gateway

1. Sign up for a [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier available)
2. Navigate to the AI Gateway section in your Cloudflare dashboard
3. Click "Create Gateway" and give it a name (e.g., `my-mux-gateway`)
4. Note your **Account ID** (found in the dashboard URL or account settings)
5. Note your **Gateway Name** (the name you just created)

### 2. Configure mux

Open or create `~/.mux/providers.jsonc` and add the `cloudflareGateway` configuration to any provider:

```jsonc
{
  "anthropic": {
    "apiKey": "sk-ant-...",
    "cloudflareGateway": {
      "accountId": "your-cloudflare-account-id",
      "gatewayName": "my-mux-gateway"
    }
  },
  "openai": {
    "apiKey": "sk-...",
    "cloudflareGateway": {
      "accountId": "your-cloudflare-account-id",
      "gatewayName": "my-mux-gateway"
    }
  }
}
```

### 3. Verify Setup

When you send a message, mux will automatically route requests through Cloudflare AI Gateway. You should see a log message in the console:

```
Using Cloudflare AI Gateway { provider: 'anthropic', accountId: '...', gatewayName: '...' }
```

All AI requests will now appear in your Cloudflare AI Gateway dashboard with detailed analytics.

## Configuration Options

### Per-Provider Configuration

You can configure different gateways for different providers:

```jsonc
{
  "anthropic": {
    "apiKey": "sk-ant-...",
    "cloudflareGateway": {
      "accountId": "account-id-1",
      "gatewayName": "production-gateway"
    }
  },
  "openai": {
    "apiKey": "sk-...",
    "cloudflareGateway": {
      "accountId": "account-id-2",
      "gatewayName": "testing-gateway"
    }
  },
  // Ollama without gateway (direct connection)
  "ollama": {
    "baseUrl": "http://localhost:11434/api"
  }
}
```

### Mixing Gateway and Direct Connections

You can use Cloudflare AI Gateway for some providers and direct connections for others. Simply omit the `cloudflareGateway` configuration for providers you want to connect directly.

## How It Works

When `cloudflareGateway` is configured:

1. mux constructs the Cloudflare AI Gateway URL:
   ```
   https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayName}/{provider}
   ```

2. This URL is passed to the Vercel AI SDK as the `baseURL` parameter

3. All API requests are routed through Cloudflare's infrastructure

4. Your provider API key is still required and sent with each request

5. Cloudflare logs, caches, and manages the requests according to your gateway settings

## Benefits

### Cost Optimization

- **Caching**: Identical requests can be served from cache, avoiding provider API calls
- **Rate limiting**: Prevent unexpected bill spikes from runaway requests
- **Usage tracking**: Monitor spending across all providers in one dashboard

### Performance

- **Global edge network**: Requests are routed through Cloudflare's global network
- **Intelligent caching**: Reduce latency for repeated queries
- **Load balancing**: Distribute requests efficiently

### Observability

- **Request logs**: See every AI request and response
- **Analytics**: Track usage patterns, error rates, and performance
- **Cost breakdown**: Understand spending by model, project, or time period

## Troubleshooting

### Gateway Not Working

1. **Verify account ID and gateway name**: Check your Cloudflare dashboard
2. **Check API key**: Ensure your provider API key is still valid
3. **Review Cloudflare logs**: Check the AI Gateway dashboard for error messages
4. **Test direct connection**: Temporarily remove `cloudflareGateway` to verify basic connectivity

### Performance Issues

1. **Check cache settings**: Cloudflare might be caching responses you don't want cached
2. **Review rate limits**: Your gateway might be throttling requests
3. **Check regional routing**: Ensure Cloudflare edge locations are optimal for your region

### Missing Analytics

1. **Verify gateway is active**: Check Cloudflare dashboard shows "Active" status
2. **Wait for propagation**: Analytics may take a few minutes to appear
3. **Check configuration**: Ensure `accountId` and `gatewayName` match exactly

## Supported Providers

Cloudflare AI Gateway supports all major AI providers that mux integrates with:

- Anthropic (Claude)
- OpenAI (GPT, o1, o3)
- Google (Gemini)
- Any provider using OpenAI-compatible APIs

## Advanced Configuration

For advanced Cloudflare AI Gateway features (custom caching, rate limiting, etc.), configure them in your Cloudflare dashboard. The mux integration automatically uses whatever settings you've configured for your gateway.

## Learn More

- [Cloudflare AI Gateway Documentation](https://developers.cloudflare.com/ai-gateway/)
- [Vercel AI SDK Integration Guide](https://developers.cloudflare.com/ai-gateway/integrations/vercel-ai-sdk/)
- [Cloudflare AI Gateway Dashboard](https://dash.cloudflare.com/)
