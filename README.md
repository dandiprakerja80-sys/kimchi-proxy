---
title: Kimchi Proxy
emoji: 🌶️
colorFrom: red
colorTo: yellow
sdk: docker
app_port: 7860
---

# Kimchi Proxy Server

Multi-key rotating proxy for Kimchi API with multi-API-key rotation. Designed for opencode/claude code integration.

## Features

- **Multi API key rotation** - Round-robin with cooldown tracking
- **Retry logic** - Exponential backoff, respects Retry-After header
- **Streaming support** - SSE streaming for chat completions
- **Key health tracking** - Auto-throttle on 429/5xx errors
- **Key pinning** - Pin specific key via `X-Kimchi-Key-Index` header

## Setup

### 1. Configure Environment Variables

In the Hugging Face Space settings, set:

```
KIMCHI_API_KEYS=apikey1,apikey2,apikey3
```

Format: comma-separated or space-separated.

### 2. Configure opencode

```json
{
  "llm": {
    "provider": "openai",
    "baseUrl": "https://elysiadev11-proxy.hf.space",
    "apiKey": "placeholder"
  }
}
```

### 3. Configure claude code

```bash
export ANTHROPIC_BASE_URL="https://elysiadev11-proxy.hf.space"
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
│ opencode/   │────▶│  HF Space    │────▶│  llm.kimchi.dev │
│ claude code │     │  Proxy       │     │  (Kimchi API)   │
└─────────────┘     └──────────────┘     └─────────────────┘
```

## Debugging

Check `/health` endpoint to see key status:

```bash
curl https://elysiadev11-proxy.hf.space/health
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
