# Kimchi Proxy Server

Vercel-hosted proxy for Kimchi API with multi-API-key rotation. Designed for opencode/claude code integration.

## Features

- **Multi API key rotation** - Round-robin with cooldown tracking
- **Retry logic** - Exponential backoff, respects Retry-After header
- **Streaming support** - SSE streaming for chat completions
- **Key health tracking** - Auto-throttle on 429/5xx errors
- **Key pinning** - Pin specific key via `X-Kimchi-Key-Index` header

## Setup

### 1. Deploy to Vercel

```bash
npm i -g vercel
vercel
vercel --prod
```

### 2. Configure Environment Variables

In Vercel dashboard, set:

```
KIMCHI_API_KEYS=apikey1,apikey2,apikey3
```

Format: comma-separated or space-separated.

### 3. Configure opencode

```json
{
  "llm": {
    "provider": "openai",
    "baseUrl": "https://your-proxy.vercel.app",
    "apiKey": "placeholder"
  }
}
```

### 4. Configure claude code

```bash
export ANTHROPIC_BASE_URL="https://your-proxy.vercel.app"
export ANTHROPIC_API_KEY="placeholder"
```

## API Endpoints

| Route | Method | Description |
|---|---|---|
| `/v1/chat/completions` | POST | Chat completions (streaming) |
| `/v1/models` | GET | Model metadata |
| `/health` | GET | Health check + key status |

## Headers

### Request Headers

| Header | Description |
|---|---|
| `X-Kimchi-Key-Index` | Pin to specific key index (0-based) |

### Response Headers

| Header | Description |
|---|---|
| `X-Proxy-Key-Index` | Key index used for this request |
| `X-Proxy-Key-Total` | Total keys available |
| `X-Proxy-Attempts` | Number of retry attempts |
| `X-Proxy-Elapsed-Ms` | Request duration in ms |

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│ opencode/   │────▶│  Vercel      │────▶│  llm.kimchi.dev │
│ claude code │     │  Proxy       │     │  (Kimchi API)   │
└─────────────┘     └──────────────┘     └─────────────────┘
```

## Limitations (Vercel Hobby)

- **60s function timeout** - Long chat completions may be cut off
- **4.5MB request body** - Sufficient for typical prompts
- **Stateless keys** - Cooldown tracking is in-memory (resets on cold start)

## Debugging

Check `/health` endpoint to see key status:

```bash
curl https://your-proxy.vercel.app/health
```

Response:

```json
{
  "ok": true,
  "keysConfigured": 3,
  "keyStatus": [
    { "index": 0, "key": "sk-abc...", "throttled": false },
    { "index": 1, "key": "sk-def...", "throttled": true },
    { "index": 2, "key": "sk-ghi...", "throttled": false }
  ]
}
```
