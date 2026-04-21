// OpenClaw Chrome Control — Side Panel Chat

(function () {
  'use strict';

  const messagesEl = document.getElementById('messages');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const resetBtn = document.getElementById('resetBtn');
  const typingEl = document.getElementById('typing');

  let ws = null;

  // ── WebSocket Connection ──────────────────────────────────────────────

  function connect() {
    // Get relay URL from storage
    chrome.storage.local.get(['relayUrl'], (result) => {
      const relayUrl = result.relayUrl || 'ws://localhost:9224';
      try {
        ws = new WebSocket(relayUrl);
      } catch {
        addMessage('assistant', '⚠️ Could not connect to relay server.');
        return;
      }

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'identify', role: 'chat' }));
      };

      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch { return; }

        if (msg.type === 'chat_response') {
          if (msg.done) {
            setTyping(false);
          }
          // Appending handled by streaming below
        } else if (msg.type === 'chat_error') {
          setTyping(false);
          addMessage('assistant', '❌ Error: ' + (msg.error || 'Unknown error'));
        } else if (msg.type === 'chat_response' && msg.content) {
          appendToLastAssistant(msg.content);
        }
      };

      // Handle streaming responses
      let streamingMessage = null;
      const origOnMessage = ws.onmessage;
      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch { return; }

        if (msg.type === 'chat_response') {
          if (msg.content) {
            if (!streamingMessage) {
              streamingMessage = addMessage('assistant', msg.content);
            } else {
              streamingMessage.textContent += msg.content;
            }
            scrollToBottom();
          }
          if (msg.done) {
            setTyping(false);
            streamingMessage = null;
          }
        } else if (msg.type === 'chat_error') {
          setTyping(false);
          streamingMessage = null;
          addMessage('assistant', '❌ Error: ' + (msg.error || 'Unknown error'));
        }
      };

      ws.onclose = () => {
        ws = null;
      };

      ws.onerror = () => {
        addMessage('assistant', '⚠️ Connection error. Is the relay server running?');
        setTyping(false);
      };
    });
  }

  // ── Message Helpers ────────────────────────────────────────────────────

  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.textContent = text;
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
  }

  function appendToLastAssistant(text) {
    const msgs = messagesEl.querySelectorAll('.message.assistant');
    if (msgs.length > 0) {
      msgs[msgs.length - 1].textContent += text;
    }
  }

  function setTyping(show) {
    typingEl.classList.toggle('visible', show);
    if (show) scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  // ── Send Message ──────────────────────────────────────────────────────

  function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    addMessage('user', text);
    chatInput.value = '';

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addMessage('assistant', '⚠️ Not connected to relay. Attempting to reconnect...');
      connect();
      return;
    }

    setTyping(true);
    ws.send(JSON.stringify({ type: 'chat', message: text }));
  }

  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // ── Reset ──────────────────────────────────────────────────────────────

  resetBtn.addEventListener('click', () => {
    messagesEl.innerHTML = '';
    if (ws) {
      ws.close();
      ws = null;
    }
    connect();
  });

  // ── Init ────────────────────────────────────────────────────────────────

  connect();
})();
