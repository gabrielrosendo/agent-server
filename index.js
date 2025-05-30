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

const WS_PORT = 3000;
const HTTP_PORT = 3001;

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

// Flags and transcript for RAG processing - these are global for simplicity in this example.
// In a multi-client app, these would need to be managed per-connection (e.g., in connectionStates).
let isProcessingRAG = false;
let userTranscriptForRAG = '';
let isRAGActiveThisTurn = false; // True if the current user speech turn is targeted for RAG

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
        console.log('RAG mode activated for all connections'); // Simplified: affects global RAG intent
        wsConnections.forEach(ws => {
          const state = connectionStates.get(ws);
          if (state) state.ragMode = true;
        });
      } else if (text.toLowerCase().includes('rag off')) {
        console.log('RAG mode deactivated for all connections'); // Simplified
        wsConnections.forEach(ws => {
          const state = connectionStates.get(ws);
          if (state) state.ragMode = false;
          // If RAG was active for a turn, but now turned off, cancel it.
          if (isRAGActiveThisTurn || isProcessingRAG) {
            console.log("RAG mode turned off during an active RAG turn/process. Resetting RAG state.");
            isRAGActiveThisTurn = false;
            isProcessingRAG = false;
            userTranscriptForRAG = '';
          }
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
  connectionStates.set(ws, { ragMode: false }); // Default RAG mode to OFF for new connections
  
  const client = new RealtimeClient({ apiKey: OPENAI_API_KEY });

  client.realtime.on("server.*", (event) => {
    // Primary RAG Blocking Logic:
    // If isProcessingRAG is true, we are in the middle of our custom RAG flow.
    // We must block OpenAI's default/streaming responses for the assistant.
    if (isProcessingRAG) {
      if (event.type.startsWith('response.') ||
          (event.type === 'conversation.item.created' && event.item?.role === 'assistant')) {
        console.log(`🚫 BLOCKING OpenAI event type "${event.type}" during RAG processing.`);
        return; // Stop this event from being relayed or processed further by default logic
      }
    }

    // Default relay action, can be overridden by specific handlers below
    let shouldRelayEvent = true;

    // console.log(`[OpenAI->S] Event: ${event.type}`); // Generic log for all events

    if (event.type === 'input_audio_buffer.speech_started') {
      console.log("🎤 User speech started.");
      userTranscriptForRAG = ''; // Reset for current speech
      const currentConnectionState = connectionStates.get(ws);
      if (currentConnectionState?.ragMode === true && !isProcessingRAG) {
        isRAGActiveThisTurn = true;
        console.log("  RAG mode ON for this turn. Capturing transcript.");
      } else {
        isRAGActiveThisTurn = false;
        if (currentConnectionState?.ragMode === true && isProcessingRAG) {
            console.log("  RAG mode ON, but another RAG process is already active.");
        }
      }
    }

    if (event.type === 'input_audio_buffer.speech_stopped') {
      console.log("🎤 User speech stopped.");
      if (isRAGActiveThisTurn) {
        console.log("  Waiting for full transcript to trigger RAG...");
      }
    }

    if (isRAGActiveThisTurn && event.type === 'response.audio_transcript.delta') {
      if (event.text) {
        userTranscriptForRAG += event.text;
      }
      // Deltas are part of a larger response, don't relay them individually if we're building for RAG
      // shouldRelayEvent = false; // Or let them through for client-side display if desired
    }

    if (isRAGActiveThisTurn && event.type === 'response.audio_transcript.done') {
      console.log(`🎤 Full transcript captured for RAG: "${userTranscriptForRAG}"`);
      isRAGActiveThisTurn = false; // Done with transcript capture for this specific turn

      if (userTranscriptForRAG.trim()) {
        console.log(`🚀 Triggering RAG process with transcript: "${userTranscriptForRAG.trim()}"`);
        isProcessingRAG = true; // CRITICAL: Start blocking default assistant responses NOW
        performRAGProcess(ws, client, userTranscriptForRAG.trim())
          .catch(error => {
            console.error('RAG process initiation failed:', error);
            isProcessingRAG = false; // Ensure reset on error during initiation
          });
        shouldRelayEvent = false; // Don't relay this "done" event if RAG is taking over
      } else {
        console.log("🎤 User transcript is empty. RAG not triggered.");
        isProcessingRAG = false; // Ensure this is false if RAG isn't triggered
      }
    }
    
    if (shouldRelayEvent) {
      // console.log(`Relaying "${event.type}" to Client`);
      ws.send(JSON.stringify(event));
    }
  });
  client.realtime.on("close", () => ws.close());

  // Relay: Browser Event -> OpenAI Realtime API Event
  const messageQueue = [];
  const messageHandler = async (data) => {
    try {
      const event = JSON.parse(data);
      
      // Secondary RAG Blocking Logic:
      // If RAG is active for this turn or already processing,
      // prevent the client from trying to force a new (default) response.
      if ((isRAGActiveThisTurn || isProcessingRAG) && event.type === 'response.create') {
        console.log(`🚫 BLOCKING client's "response.create" event - RAG is active/processing.`);
        return;
      }
      
      // Always send the original event (unless blocked above)
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

// New function to handle complete RAG process
async function performRAGProcess(ws, client, userQuery) {
  try {
    console.log(`[RAG] 🔍 Starting RAG search for user query: "${userQuery}"`);
    
    // Step 1: Perform search with actual user query
    const searchResults = await performRAGSearch(userQuery);
    
    if (searchResults.length === 0) {
      console.log(`[RAG] ❌ No search results found for "${userQuery}".`);
      const responseText = "I couldn't find specific information for that in my documents. How else can I assist you?";
      console.log(`[RAG] 🤖 Defaulting to: "${responseText}"`);
      
      isProcessingRAG = false; // Unblock before sending our controlled response

      client.realtime.send('conversation.item.create', {
          item: { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: responseText }] }
      });
      setTimeout(() => {
          client.realtime.send('response.create', { response: { modalities: ["audio"], instructions: "Speak the provided message naturally." } });
      }, 200);
      return;
    }
    
    console.log(`📄 Found ${searchResults.length} documents, preparing context...`);
    
    // Step 2: Prepare SHORTER context to avoid token limit
    const contextText = searchResults.map((doc, i) => {
      const content = doc.content || doc.text || JSON.stringify(doc);
      // Limit each document to 300 characters to avoid token limit
      const shortContent = content.substring(0, 300); // Keep this short
      console.log(`📄 Document ${i + 1} content: ${shortContent}...`);
      return `Document ${i + 1}:\n${shortContent}`;
    }).join('\n\n');
    
    // Step 3: Get AI response with SHORTER context
    console.log(`🤖 Querying AI with context and user question...`);
    const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo', // Keep gpt-3.5-turbo for shorter context
        messages: [
          {
            role: 'system',
            content: `You are a helpful assistant. Use this context to answer the question:\n\n${contextText}`
          },
          {
            role: 'user',
            content: userQuery
          }
        ],
        max_tokens: 200,
        temperature: 0.7
      })
    });
    
    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error(`❌ AI API Error: ${aiResponse.status} - ${errorText}`);
      throw new Error(`AI API failed: ${aiResponse.status}`);
    }
    
    const aiData = await aiResponse.json();
    
    if (!aiData.choices || aiData.choices.length === 0) {
      console.error(`❌ No AI response choices received:`, aiData);
      throw new Error('No AI response received');
    }
    
    const responseText = aiData.choices[0].message.content;
    console.log(`[RAG] 🤖 LLM Response: ${responseText}`);
    
    console.log(`[RAG] 🔊 Sending RAG response through OpenAI Realtime...`);
    
    isProcessingRAG = false; // Unblock *before* sending our controlled response
    
    // Add the AI response as a conversation item
    const responseMessage = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'input_text',
          text: responseText
        }]
      }
    };
    
    // Send the message and create response
    client.realtime.send(responseMessage.type, responseMessage);
    
    // Create response to make it speak
    setTimeout(() => {
      const createResponse = {
        type: 'response.create',
        response: {
          modalities: ["audio"],
          instructions: "Speak the provided message naturally."
        }
      };
      client.realtime.send(createResponse.type, createResponse);
    }, 200);
    
  } catch (error) {
    console.error('[RAG] Error in performRAGProcess:', error.message);
    
    isProcessingRAG = false; // Ensure unblocking on any error in the RAG pipeline
    
    // Attempt to send a spoken error message to the user
    try {
      const errorTextToSpeak = "I encountered an issue while trying to access my knowledge base. Please try again or ask something else.";
      console.log(`[RAG] 🔊 Sending spoken error: "${errorTextToSpeak}"`);
      client.realtime.send('conversation.item.create', {
          item: { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: errorTextToSpeak }] }
      });
      setTimeout(() => {
          client.realtime.send('response.create', { response: { modalities: ["audio"], instructions: "Speak the provided message naturally." } });
      }, 200);
    } catch (ttsError) {
        console.error("[RAG] Critical error: Failed to send spoken error message.", ttsError);
    }
    // Do not re-throw if we've attempted to inform the user.
  }
}
