# Recall.ai Voice Agent with RAG

Voice agent that joins meetings and answers questions using Azure AI Search for document retrieval.

## Prerequisites

- Node.js 18+
- ngrok CLI
- OpenAI API key
- Azure AI Search service
- Recall.ai API key

## Quick Setup

1. **Install dependencies:**
```bash
cd node-server
npm install
```

2. **Configure environment:**
Create `.env` in `/node-server/`:
```env
OPENAI_API_KEY=your_key_here
AZURE_SEARCH_KEY=your_azure_key_here
WS_PORT=3002
HTTP_PORT=3001
```

3. **Run development setup (3 terminals):**

Terminal 1 - Node server:
```bash
cd node-server
npm run dev
```

Terminal 2 - ngrok for WebSocket:
```bash
ngrok http 3002
```

Terminal 3 - localtunnel for webhook:
```bash
npx localtunnel --port 3001
```

4. **Create bot with URLs from tunnels:**
```bash
curl --request POST \
  --url https://us-east-1.recall.ai/api/v1/bot/ \
  --header 'Authorization: YOUR_RECALL_TOKEN' \
  --header 'content-type: application/json' \
  --data '{
    "meeting_url": "YOUR_MEETING_URL",
    "bot_name": "RAG Assistant",
    "recording_config": {
      "realtime_endpoints": [{
        "type": "webhook",
        "events": ["participant_events.chat_message"],
        "url": "https://your-localtunnel-url.loca.lt/webhook"
      }]
    },
    "output_media": {
      "camera": {
        "kind": "webpage",
        "config": {
          "url": "https://recallai-demo.netlify.app?wss=wss://your-ngrok-url.ngrok-free.app"
        }
      }
    }
  }'
```

## Usage

- **Voice**: Talk normally with the agent
- **Chat commands**:
  - `rag on` - Activate document search (NEEDS WORK - STILL DOES NOT DO RAG)
  - `rag off` - Normal voice only
  - `rag test [query]` - Test search ( RAG QUERIES WORK THIS WAY, BUT NOT THROUGH VOICE)

## Production

Deploy to Azure Web App and replace tunnel URLs with your app domain.
