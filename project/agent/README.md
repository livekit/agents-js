# LiveKit Agent Worker

## Setup

1. Install dependencies:
```bash
pnpm install
```

2. Create a `.env.local` file from `.env.example` and fill in the API keys.

3. Run in development mode:
```bash
# Agent only (from project/agent directory)
pnpm dev

# Both agent and web with beautiful TUI (from workspace root)
turbo dev 
```

## Environment Variables

The agent loads environment variables in the following order:
1. `.env.local` (recommended for local development - not committed to git)

All API keys are required for the respective services to work:
- `OPENAI_API_KEY` - Required for LLM functionality
- `DEEPGRAM_API_KEY` - Required for speech-to-text
- `ELEVENLABS_API_KEY` - Required for text-to-speech