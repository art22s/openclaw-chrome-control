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

// ── Chat handler — agent loop with browser control ────────────────────────

const BROWSER_SYSTEM_PROMPT = `You are an AI assistant that can control the user's Chrome browser in real time. You have access to the following tools:

- navigate: Go to a URL. {"action":"navigate","url":"https://..."}
- click: Click an element. {"action":"click","target":{"text":"Sign in"}} or {"action":"click","target":{"selector":"button.submit"}}
- type: Type text into an input. {"action":"type","target":{"selector":"input[name=q]"},"value":"search term"}
- read: Read the current page content. {"action":"read"}
- screenshot: Take a screenshot. {"action":"screenshot"}
- scroll: Scroll the page. {"action":"scroll","value":"down","amount":300}
- press: Press a key. {"action":"press","value":"Enter"}
- select: Select a dropdown option. {"action":"select","target":{"selector":"select.country"},"value":"US"}
- wait: Wait for an element. {"action":"wait","target":{"text":"Results"},"timeout":5000}
- list_tabs: List open tabs. {"action":"list_tabs"}
- switch_tab: Switch to a tab. {"action":"switch_tab","tabId":123}
- close_tab: Close a tab. {"action":"close_tab","tabId":123}

When the user asks you to do something in the browser, use these tools to accomplish it. To decide what to do, first read the page or list tabs to understand the current state. Then take actions step by step.

Respond in tool_call format when you want to use a tool, and plain text when talking to the user. Keep responses concise.`;

const chatSessions = new Map(); // ws -> conversation history

async function handleChat(ws, msg) {
  try {
    // Maintain conversation history
    if (!chatSessions.has(ws)) {
      chatSessions.set(ws, [{ role: 'system', content: BROWSER_SYSTEM_PROMPT }]);
    }
    const history = chatSessions.get(ws);
    history.push({ role: 'user', content: msg.message });

    // Keep history manageable (last 20 messages + system)
    if (history.length > 22) {
      const system = history[0];
      history.length = 0;
      history.push(system, ...history.slice(-21));
    }

    // Agent loop: call LLM, execute tool calls, repeat
    let loopCount = 0;
    const MAX_LOOPS = 10;
    let lastAssistantMsg = null;

    while (loopCount < MAX_LOOPS) {
      loopCount++;

      const headers = { 'Content-Type': 'application/json' };
      if (OPENCLAW_API_TOKEN) {
        headers['Authorization'] = `Bearer ${OPENCLAW_API_TOKEN}`;
      }

      const res = await fetch(OPENCLAW_API_URL + '/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'openclaw',
          messages: history,
          stream: true,
          tools: [
            {
              type: 'function',
              function: {
                name: 'browser_action',
                description: 'Execute a browser action. Available actions: navigate, click, type, read, screenshot, scroll, press, select, wait, list_tabs, switch_tab, close_tab. Pass the action and its parameters.',
                parameters: {
                  type: 'object',
                  properties: {
                    action: { type: 'string', description: 'The action to perform' },
                    url: { type: 'string', description: 'URL for navigate action' },
                    target: { type: 'object', description: 'Element target (selector, text, xpath, coordinates)' },
                    value: { type: 'string', description: 'Value for type/select/press/scroll actions' },
                    amount: { type: 'number', description: 'Amount for scroll' },
                    options: { type: 'object', description: 'Additional options' },
                    tabId: { type: 'number', description: 'Tab ID for switch_tab/close_tab' },
                  },
                  required: ['action'],
                },
              },
            },
          ],
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        ws.send(JSON.stringify({ type: 'chat_error', error: `Gateway returned ${res.status}: ${errText}` }));
        return;
      }

      // Collect the full response (streaming to client in parallel)
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';
      let toolCalls = [];
      let currentToolCall = null;

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
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            // Text content
            if (delta.content) {
              fullContent += delta.content;
              ws.send(JSON.stringify({ type: 'chat_response', content: delta.content }));
            }

            // Tool calls
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.index !== undefined) {
                  if (!toolCalls[tc.index]) {
                    toolCalls[tc.index] = { id: tc.id, function: { name: '', arguments: '' } };
                  }
                  if (tc.id) toolCalls[tc.index].id = tc.id;
                  if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
                  if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                }
              }
            }
          } catch {
            // skip malformed chunks
          }
        }
      }

      // Add assistant message to history
      const assistantMsg = { role: 'assistant', content: fullContent || null };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.filter(Boolean);
      }
      history.push(assistantMsg);

      // No tool calls — we're done
      if (toolCalls.length === 0) {
        ws.send(JSON.stringify({ type: 'chat_response', content: '', done: true }));
        return;
      }

      // Execute tool calls
      for (const tc of toolCalls.filter(Boolean)) {
        try {
          const args = JSON.parse(tc.function.arguments);
          const action = args.action || tc.function.name;

          // Check extension is connected
          if (!connections.extension) {
            const errMsg = { role: 'tool', tool_call_id: tc.id, content: 'Error: Browser extension not connected' };
            history.push(errMsg);
            ws.send(JSON.stringify({ type: 'chat_response', content: '\n⚠️ Browser extension not connected.\n' }));
            continue;
          }

          // Send command to extension and wait for response
          const result = await sendCommandToExtension(args);
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
          history.push({ role: 'tool', tool_call_id: tc.id, content: resultStr || 'Done' });

          // Show brief action indicator in chat
          const shortResult = resultStr?.length > 200 ? resultStr.slice(0, 200) + '...' : resultStr;
          ws.send(JSON.stringify({ type: 'chat_response', content: `\n📎 [${action}] ${shortResult}\n\n` }));
        } catch (err) {
          history.push({ role: 'tool', tool_call_id: tc.id, content: `Error: ${err.message}` });
          ws.send(JSON.stringify({ type: 'chat_response', content: `\n❌ Tool error: ${err.message}\n` }));
        }
      }

      // Clear toolCalls for next iteration
      toolCalls = [];
    }

    // Hit max loops
    ws.send(JSON.stringify({ type: 'chat_response', content: '\n⚠️ Reached maximum action limit. Stopping.', done: true }));
  } catch (err) {
    ws.send(JSON.stringify({ type: 'chat_error', error: err.message }));
  }
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
