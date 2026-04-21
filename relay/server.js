require('dotenv').config();
const { WebSocketServer } = require('ws');
const http = require('http');

const WS_PORT = parseInt(process.env.WS_PORT || '9224', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '9225', 10);
const OPENCLAW_API_URL = process.env.OPENCLAW_API_URL || 'http://localhost:18789';
const OPENCLAW_API_TOKEN = process.env.OPENCLAW_API_TOKEN || '';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

const startTime = Date.now();

// Named connections
const connections = {
  extension: null,
  agent: null,
  chat: null,
};

// ── WebSocket Server (for extension & chat) ──────────────────────────────

const wss = new WebSocketServer({ port: WS_PORT }, () => {
  console.log(`[relay] WebSocket server listening on ws://localhost:${WS_PORT}`);
});

function sendToConnection(name, data) {
  const ws = connections[name];
  if (ws && ws.readyState === 1) {
    ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    return true;
  }
  return false;
}

function broadcastStatus() {
  const status = {
    type: 'status',
    extensionConnected: !!connections.extension,
    agentConnected: !!connections.agent,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
  // Send to all connected clients
  for (const name of Object.keys(connections)) {
    sendToConnection(name, status);
  }
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[relay] New WebSocket connection from ${ip}`);

  // First message should identify the client
  let identified = false;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.warn('[relay] Invalid JSON from WebSocket client');
      return;
    }

    // ── Identification ──────────────────────────────────────────
    if (msg.type === 'identify' && !identified) {
      const role = msg.role; // 'extension', 'agent', 'chat'
      if (role && connections.hasOwnProperty(role)) {
        // Close existing connection of same role
        if (connections[role] && connections[role] !== ws) {
          console.log(`[relay] Replacing existing ${role} connection`);
          connections[role].close();
        }
        connections[role] = ws;
        ws._role = role;
        identified = true;
        console.log(`[relay] Client identified as: ${role}`);
        broadcastStatus();
        // Send current status back
        ws.send(JSON.stringify({
          type: 'status',
          extensionConnected: !!connections.extension,
          agentConnected: !!connections.agent,
          uptime: Math.floor((Date.now() - startTime) / 1000),
        }));
      }
      return;
    }

    if (!identified) {
      console.warn('[relay] Message from unidentified client, ignoring');
      return;
    }

    // ── Auth check ───────────────────────────────────────────────
    if (AUTH_TOKEN && msg.auth !== AUTH_TOKEN && ws._role !== 'extension') {
      ws.send(JSON.stringify({ type: 'error', error: 'Unauthorized' }));
      return;
    }

    // ── Command forwarding: agent → extension ────────────────────
    if (msg.type === 'command' && ws._role === 'agent') {
      if (connections.extension) {
        connections.extension.send(JSON.stringify(msg));
      } else {
        ws.send(JSON.stringify({ type: 'response', id: msg.id, payload: { error: 'Extension not connected' } }));
      }
      return;
    }

    // ── Response forwarding: extension → agent ───────────────────
    if (msg.type === 'response' && ws._role === 'extension') {
      if (connections.agent) {
        connections.agent.send(JSON.stringify(msg));
      }
      return;
    }

    // ── Extension status ─────────────────────────────────────────
    if (msg.type === 'status' && ws._role === 'extension') {
      broadcastStatus();
      return;
    }

    // ── Chat messages ────────────────────────────────────────────
    if (msg.type === 'chat' && ws._role === 'chat') {
      handleChat(ws, msg);
      return;
    }
  });

  ws.on('close', () => {
    if (ws._role) {
      console.log(`[relay] ${ws._role} disconnected`);
      connections[ws._role] = null;
      broadcastStatus();
    }
    chatSessions.delete(ws);
  });

  ws.on('error', (err) => {
    console.error(`[relay] WebSocket error (${ws._role || 'unknown'}):`, err.message);
  });
});

// ── Chat handler — command interpreter with optional LLM ─────────────────

const CHAT_SYSTEM_PROMPT = `You are a browser control assistant. When the user asks you to do something in their browser, respond with a JSON command in this exact format:

CMD: {"action":"...","url":"...","target":{...},"value":"..."}

Available actions: navigate, click, type, read, screenshot, scroll, press, select, wait, list_tabs, switch_tab, close_tab.

Examples:
- "go to google.com" → CMD: {"action":"navigate","url":"https://google.com"}
- "click the login button" → CMD: {"action":"click","target":{"text":"login"}}
- "type hello in the search box" → CMD: {"action":"type","target":{"selector":"input[type=search]"},"value":"hello"}
- "read the page" → CMD: {"action":"read"}
- "scroll down" → CMD: {"action":"scroll","value":"down","amount":300}
- "what tabs are open" → CMD: {"action":"list_tabs"}
- "press enter" → CMD: {"action":"press","value":"Enter"}

If the user is just chatting (not asking to control the browser), respond normally without CMD.
If you need to see the page first, use read. Keep responses concise.`;

const chatSessions = new Map(); // ws -> conversation history

async function handleChat(ws, msg) {
  try {
    // Maintain conversation history
    if (!chatSessions.has(ws)) {
      chatSessions.set(ws, [{ role: 'system', content: CHAT_SYSTEM_PROMPT }]);
    }
    const history = chatSessions.get(ws);
    history.push({ role: 'user', content: msg.message });

    // Keep history manageable
    if (history.length > 22) {
      const system = history[0];
      history.length = 0;
      history.push(system, ...history.slice(-21));
    }

    const headers = { 'Content-Type': 'application/json' };
    if (OPENCLAW_API_TOKEN) {
      headers['Authorization'] = `Bearer ${OPENCLAW_API_TOKEN}`;
    }

    // First, try to directly execute if user message matches a simple command pattern
    const directCmd = parseDirectCommand(msg.message);
    if (directCmd) {
      if (!connections.extension) {
        ws.send(JSON.stringify({ type: 'chat_response', content: '⚠️ Browser extension not connected.' }));
        ws.send(JSON.stringify({ type: 'chat_response', content: '', done: true }));
        return;
      }
      ws.send(JSON.stringify({ type: 'chat_response', content: `📎 Executing: ${directCmd.action}...\n` }));
      try {
        const result = await sendCommandToExtension(directCmd);
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        const shortResult = resultStr?.length > 500 ? resultStr.slice(0, 500) + '...' : resultStr;
        ws.send(JSON.stringify({ type: 'chat_response', content: `✅ Result: ${shortResult}\n` }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'chat_response', content: `❌ Error: ${err.message}\n` }));
      }
      ws.send(JSON.stringify({ type: 'chat_response', content: '', done: true }));
      return;
    }

    // Otherwise, use LLM to interpret the message
    const res = await fetch(OPENCLAW_API_URL + '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'openclaw',
        messages: history,
        stream: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      ws.send(JSON.stringify({ type: 'chat_error', error: `Gateway returned ${res.status}: ${errText}` }));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || '';
          if (content) {
            fullContent += content;
            // Don't stream CMD: lines to the client
            if (!content.match(/^CMD:/)) {
              ws.send(JSON.stringify({ type: 'chat_response', content }));
            }
          }
        } catch {
          // skip malformed chunks
        }
      }
    }

    // Check if the LLM response contains a CMD: to execute
    const cmdMatch = fullContent.match(/CMD:\s*({[\s\S]*?})/);
    if (cmdMatch && connections.extension) {
      try {
        const cmd = JSON.parse(cmdMatch[1]);
        // Strip the CMD line from what was streamed to the user
        ws.send(JSON.stringify({ type: 'chat_response', content: '\n📎 Executing: ' + cmd.action + '...\n' }));
        const result = await sendCommandToExtension(cmd);
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        const shortResult = resultStr?.length > 500 ? resultStr.slice(0, 500) + '...' : resultStr;
        ws.send(JSON.stringify({ type: 'chat_response', content: '✅ ' + shortResult + '\n' }));
        history.push({ role: 'assistant', content: fullContent });
        history.push({ role: 'user', content: `[Browser result for ${cmd.action}]: ${shortResult}` });
      } catch (err) {
        ws.send(JSON.stringify({ type: 'chat_response', content: `\n❌ Error: ${err.message}\n` }));
      }
    } else {
      history.push({ role: 'assistant', content: fullContent });
    }

    ws.send(JSON.stringify({ type: 'chat_response', content: '', done: true }));
  } catch (err) {
    ws.send(JSON.stringify({ type: 'chat_error', error: err.message }));
  }
}

// Parse simple direct commands from user message
function parseDirectCommand(message) {
  const msg = message.toLowerCase().trim();

  // Navigate
  const navMatch = msg.match(/^(?:go to|navigate to|open)\s+(https?:\/\/\S+|\S+\.\S+)/i);
  if (navMatch) {
    let url = navMatch[1];
    if (!url.startsWith('http')) url = 'https://' + url;
    return { action: 'navigate', url };
  }

  // Read page
  if (/^(?:read|show|what(?:'s| is) on) (?:the )?(?:page|tab|screen)/i.test(msg)) return { action: 'read' };
  if (/^read$/i.test(msg)) return { action: 'read' };

  // List tabs
  if (/(?:list|show|what) ?(?:tabs?|windows?)/i.test(msg)) return { action: 'list_tabs' };
  if (/^tabs$/i.test(msg)) return { action: 'list_tabs' };

  // Screenshot
  if (/^(?:screenshot|screen capture|capture)/i.test(msg)) return { action: 'screenshot' };

  // Scroll
  const scrollMatch = msg.match(/^scroll\s+(up|down|left|right)(?:\s+(\d+))?/i);
  if (scrollMatch) return { action: 'scroll', value: scrollMatch[1].toLowerCase(), amount: parseInt(scrollMatch[2]) || 300 };

  // Press key
  const pressMatch = msg.match(/^press\s+(enter|tab|escape|backspace|delete)/i);
  if (pressMatch) return { action: 'press', value: pressMatch[1].charAt(0).toUpperCase() + pressMatch[1].slice(1).toLowerCase() };

  // Click
  const clickMatch = msg.match(/^click\s+["']?(.+?)["']?$/i);
  if (clickMatch) return { action: 'click', target: { text: clickMatch[1] } };

  // Type
  const typeMatch = msg.match(/^type\s+["'](.+?)["']\s+(?:in|into|on)\s+["']?(.+?)["']?$/i);
  if (typeMatch) return { action: 'type', value: typeMatch[1], target: { text: typeMatch[2] } };

  return null;
}

// Send a command to the extension and wait for the response
function sendCommandToExtension(cmd) {
  return new Promise((resolve, reject) => {
    const id = Date.now().toString() + Math.random().toString(36).slice(2);
    const command = { type: 'command', id, ...cmd };

    const timeout = setTimeout(() => {
      connections.extension?.removeListener('message', responseHandler);
      reject(new Error('Extension response timeout'));
    }, 30000);

    function responseHandler(raw) {
      let resp;
      try { resp = JSON.parse(raw.toString()); } catch { return; }
      if (resp.type === 'response' && resp.id === id) {
        clearTimeout(timeout);
        connections.extension.removeListener('message', responseHandler);
        resolve(resp.payload);
      }
    }

    if (!connections.extension) {
      reject(new Error('Extension not connected'));
      return;
    }

    connections.extension.on('message', responseHandler);
    connections.extension.send(JSON.stringify(command));
  });
}

// ── HTTP Server (for CLI client & health checks) ─────────────────────────

const httpServer = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── GET /status ────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      extensionConnected: !!connections.extension,
      agentConnected: !!connections.agent,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    }));
    return;
  }

  // ── GET /gateway-test ──────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/gateway-test') {
    try {
      const gwRes = await fetch(OPENCLAW_API_URL + '/v1/models', {
        headers: OPENCLAW_API_TOKEN ? { 'Authorization': 'Bearer ' + OPENCLAW_API_TOKEN } : {},
      });
      if (gwRes.ok) {
        const data = await gwRes.json();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, modelCount: data.data?.length || 0 }));
      } else {
        const errText = await gwRes.text().catch(() => '');
        res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: false, error: 'Gateway returned ' + gwRes.status + ': ' + errText }));
      }
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // ── POST / — send command ──────────────────────────────────────
  if (req.method === 'POST' && req.url === '/') {
    // Auth check
    if (AUTH_TOKEN) {
      const authHeader = req.headers['authorization'];
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const bodyToken = await new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed.auth || null);
          } catch {
            resolve(null);
          }
        });
      });
      if (token !== AUTH_TOKEN && bodyToken !== AUTH_TOKEN) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let cmd;
      try {
        cmd = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      if (!connections.extension) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Extension not connected' }));
        return;
      }

      const id = cmd.id || Date.now().toString();
      const command = { type: 'command', id, ...cmd };

      // Set up a one-time listener for the response
      const timeout = setTimeout(() => {
        connections.extension?.removeListener('message', responseHandler);
        res.writeHead(504, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Timeout waiting for extension response' }));
      }, 30000);

      function responseHandler(raw) {
        let resp;
        try {
          resp = JSON.parse(raw.toString());
        } catch { return; }
        if (resp.type === 'response' && resp.id === id) {
          clearTimeout(timeout);
          connections.extension.removeListener('message', responseHandler);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(resp.payload));
        }
      }

      connections.extension.on('message', responseHandler);
      connections.extension.send(JSON.stringify(command));
    });
    return;
  }

  // ── 404 ───────────────────────────────────────────────────────
  res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`[relay] HTTP server listening on http://localhost:${HTTP_PORT}`);
});
