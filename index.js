import { WebSocketServer } from "ws";
import { RealtimeClient } from "@openai/realtime-api-beta";
import dotenv from "dotenv";
import express from "express";
import { SearchClient, AzureKeyCredential } from "@azure/search-documents";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error(
    `Environment variable "OPENAI_API_KEY" is required.\n` +
      `Please set it in your .env file.`
  );
  process.exit(1);
}

const WS_PORT = process.env.WS_PORT || 3002;
const HTTP_PORT = process.env.HTTP_PORT || 3001;

// Add Azure Search back
const searchClient = new SearchClient(
  "https://softworld-search.search.windows.net",
  "softworld-gabriel-index",
  new AzureKeyCredential(process.env.AZURE_SEARCH_KEY)
);

// Simple webhook server for RAG commands (separate from speech)
const app = express();
app.use(express.json());

// Store RAG mode state and connections
const connectionStates = new Map();
const wsConnections = new Set();

// Enhanced webhook server for RAG commands
app.post('/webhook', async (req, res) => {
  try {
    const { event, data } = req.body;
    console.log(`Webhook received: ${JSON.stringify(req.body, null, 2)}`);
    
    if (event === 'participant_events.chat_message') {
      const text = data.data.data.text;
      const sender = data.data.participant;
      console.log(`Received chat message: "${text}" from ${sender.name}`);
      
      // Handle RAG commands
      if (text.toLowerCase().includes('rag on')) {
        console.log('RAG mode activated');
        wsConnections.forEach(ws => {
          const state = connectionStates.get(ws);
          if (state) state.ragMode = true;
        });
      } else if (text.toLowerCase().includes('rag off')) {
        console.log('RAG mode deactivated');
        wsConnections.forEach(ws => {
          const state = connectionStates.get(ws);
          if (state) state.ragMode = false;
        });
      } else if (text.toLowerCase().includes('rag test')) {
        console.log('Testing RAG search...');
        const testResults = await performRAGSearch(text.replace(/rag test/i, '').trim() || 'test query');
        console.log(`RAG test results: ${JSON.stringify(testResults, null, 2)}`);
      }
    }
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add RAG search function
async function performRAGSearch(query) {
  try {
    console.log(`Starting Azure Search for query: "${query}"`);
    
    const searchResults = await searchClient.search(query, {
      top: 2
    });
    
    const documents = [];
    let resultCount = 0;
    for await (const result of searchResults.results) {
      resultCount++;
      console.log(`Found document ${resultCount}:`, Object.keys(result.document));
      documents.push(result.document);
    }
    
    console.log(`Azure Search completed. Found ${documents.length} documents.`);
    return documents;
  } catch (error) {
    console.error('Azure Search error:', error);
    return [];
  }
}

app.listen(HTTP_PORT, () => {
  console.log(`HTTP server for webhooks listening on port ${HTTP_PORT}`);
});

// EXACT COPY of your working speech-only version
const wss = new WebSocketServer({ port: WS_PORT });

wss.on("connection", async (ws, req) => {
  // Add connection tracking
  wsConnections.add(ws);
  connectionStates.set(ws, { ragMode: false });
  
  const client = new RealtimeClient({ apiKey: OPENAI_API_KEY });

  // Relay: OpenAI Realtime API Event -> Browser Event
  client.realtime.on("server.*", (event) => {
    console.log(`Relaying "${event.type}" to Client`);
    ws.send(JSON.stringify(event));
  });
  client.realtime.on("close", () => ws.close());

  // Relay: Browser Event -> OpenAI Realtime API Event
  const messageQueue = [];
  const messageHandler = (data) => {
    try {
      const event = JSON.parse(data);
      client.realtime.send(event.type, event);
    } catch (e) {
      console.error(e.message);
      console.log(`Error parsing event from client: ${data}`);
    }
  };

  ws.on("message", (data) => {
    if (!client.isConnected()) {
      messageQueue.push(data);
    } else {
      messageHandler(data);
    }
  });
  
  ws.on("close", () => {
    wsConnections.delete(ws);
    connectionStates.delete(ws);
    client.disconnect();
  });

  // Connect to OpenAI Realtime API
  try {
    console.log(`Connecting to OpenAI...`);
    await client.connect();
  } catch (e) {
    console.log(`Error connecting to OpenAI: ${e.message}`);
    ws.close();
    return;
  }
  console.log(`Connected to OpenAI successfully!`);
  while (messageQueue.length) {
    messageHandler(messageQueue.shift());
  }
});

console.log(`WebSocket server listening on port ${WS_PORT}`);
