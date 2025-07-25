// ============================================
// BACKEND: Node.js Express Server (server.js)
// ============================================

const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// In-memory storage (use database in production)
const conversations = new Map();
const humanAgents = new Map();
const waitingQueue = [];

// Knowledge Base - Replace with your actual knowledge base
const knowledgeBase = [
  {
    topic: "product_features",
    content: "Our platform offers real-time analytics, automated reporting, and customizable dashboards. It supports integration with over 50 third-party tools."
  },
  {
    topic: "pricing",
    content: "We offer three tiers: Basic ($29/month), Professional ($79/month), and Enterprise ($199/month). All plans include 24/7 support."
  },
  {
    topic: "support_hours",
    content: "Our support team is available Monday-Friday 9AM-6PM EST. Premium customers get 24/7 support access."
  },
  {
    topic: "integration",
    content: "We support integrations with Slack, Microsoft Teams, Salesforce, HubSpot, and many other popular business tools."
  }
];

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('New WebSocket connection');
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      await handleWebSocketMessage(ws, data);
    } catch (error) {
      console.error('WebSocket error:', error);
    }
  });

  ws.on('close', () => {
    // Clean up connections
    for (let [sessionId, session] of conversations) {
      if (session.customerWs === ws || session.agentWs === ws) {
        conversations.delete(sessionId);
        break;
      }
    }
  });
});

async function handleWebSocketMessage(ws, data) {
  const { type, sessionId, message, agentId } = data;

  switch (type) {
    case 'customer_message':
      await handleCustomerMessage(ws, sessionId, message);
      break;
    
    case 'agent_join':
      handleAgentJoin(ws, agentId);
      break;
    
    case 'agent_message':
      handleAgentMessage(sessionId, message);
      break;
    
    case 'request_human':
      await handleHumanRequest(sessionId);
      break;
  }
}

async function handleCustomerMessage(ws, sessionId, message) {
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, {
      customerWs: ws,
      messages: [],
      hasHuman: false,
      agentWs: null
    });
  }

  const conversation = conversations.get(sessionId);
  conversation.messages.push({ role: 'user', content: message });

  // If human agent is connected, forward message
  if (conversation.hasHuman && conversation.agentWs) {
    conversation.agentWs.send(JSON.stringify({
      type: 'customer_message',
      sessionId,
      message
    }));
    return;
  }

  // Otherwise, process with AI
  try {
    const aiResponse = await generateAIResponse(message, conversation.messages);
    
    conversation.messages.push({ role: 'assistant', content: aiResponse });
    
    ws.send(JSON.stringify({
      type: 'ai_response',
      message: aiResponse,
      sessionId
    }));
  } catch (error) {
    console.error('AI Response error:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Sorry, I encountered an error. Would you like to connect with a human agent?'
    }));
  }
}

async function generateAIResponse(userMessage, conversationHistory) {
  // Search knowledge base for relevant information
  const relevantKnowledge = searchKnowledgeBase(userMessage);
  
  // Prepare context for Gemini
  let context = "You are a helpful customer service AI assistant. ";
  
  if (relevantKnowledge.length > 0) {
    context += "Here's relevant information from our knowledge base:\n";
    relevantKnowledge.forEach(item => {
      context += `- ${item.content}\n`;
    });
  }
  
  context += `
Rules:
1. Answer based on the knowledge base when possible
2. If you cannot answer from the knowledge base, politely say so and offer to connect them with a human agent
3. Be helpful, friendly, and concise
4. If the user asks to speak with a human, respond with "HUMAN_REQUEST" exactly

User question: ${userMessage}`;

  const result = await model.generateContent(context);
  const response = result.response.text();
  
  // Check if AI wants to escalate to human
  if (response.includes("HUMAN_REQUEST") || 
      response.toLowerCase().includes("connect with a human") ||
      response.toLowerCase().includes("speak with a human")) {
    return "I'd be happy to connect you with one of our human agents who can better assist you. Please wait a moment while I find someone available.";
  }
  
  return response;
}

function searchKnowledgeBase(query) {
  const queryLower = query.toLowerCase();
  return knowledgeBase.filter(item => {
    const contentLower = item.content.toLowerCase();
    const topicLower = item.topic.toLowerCase();
    
    // Simple keyword matching - implement more sophisticated search as needed
    return contentLower.includes(queryLower.split(' ')[0]) || 
           topicLower.includes(queryLower.split(' ')[0]) ||
           queryLower.includes(topicLower.replace('_', ' '));
  });
}

function handleAgentJoin(ws, agentId) {
  humanAgents.set(agentId, ws);
  
  // Check if there are customers waiting
  if (waitingQueue.length > 0) {
    const sessionId = waitingQueue.shift();
    const conversation = conversations.get(sessionId);
    
    if (conversation) {
      conversation.hasHuman = true;
      conversation.agentWs = ws;
      
      // Notify both customer and agent
      conversation.customerWs.send(JSON.stringify({
        type: 'human_joined',
        message: 'A human agent has joined the chat!'
      }));
      
      ws.send(JSON.stringify({
        type: 'customer_assigned',
        sessionId,
        conversationHistory: conversation.messages
      }));
    }
  }
}

function handleAgentMessage(sessionId, message) {
  const conversation = conversations.get(sessionId);
  if (conversation && conversation.customerWs) {
    conversation.messages.push({ role: 'agent', content: message });
    
    conversation.customerWs.send(JSON.stringify({
      type: 'agent_message',
      message
    }));
  }
}

async function handleHumanRequest(sessionId) {
  const conversation = conversations.get(sessionId);
  if (!conversation) return;
  
  // Check if human agents are available
  const availableAgents = Array.from(humanAgents.values());
  
  if (availableAgents.length > 0) {
    // Assign first available agent
    const agentWs = availableAgents[0];
    conversation.hasHuman = true;
    conversation.agentWs = agentWs;
    
    conversation.customerWs.send(JSON.stringify({
      type: 'human_joined',
      message: 'A human agent has joined the chat!'
    }));
    
    agentWs.send(JSON.stringify({
      type: 'customer_assigned',
      sessionId,
      conversationHistory: conversation.messages
    }));
  } else {
    // Add to waiting queue
    waitingQueue.push(sessionId);
    
    conversation.customerWs.send(JSON.stringify({
      type: 'waiting_for_human',
      message: 'You have been added to the queue. A human agent will be with you shortly.'
    }));
  }
}

// REST API endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Admin endpoint to check queue status
app.get('/admin/status', (req, res) => {
  res.json({
    activeConversations: conversations.size,
    humanAgents: humanAgents.size,
    waitingQueue: waitingQueue.length
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

