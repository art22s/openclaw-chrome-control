# 🦞 OpenClaw Chrome Control

Control a real Chrome browser from an OpenClaw AI agent. Click, type, read, navigate — all through a Chrome extension + WebSocket relay.

## How It Works

```
┌──────────────┐     HTTP      ┌──────────────┐    WebSocket    ┌──────────────────┐   Content    ┌──────────┐
│  OpenClaw    │ ──────────→  │  Relay        │ ─────────────→ │  Chrome Extension  │ ──────────→ │  Web      │
│  Agent       │              │  Server       │ ←───────────── │  (Service Worker)  │ ←────────── │  Page     │
│  (or CLI)    │ ←──────────  │  :9225 HTTP   │                │                    │             │          │
│              │              │  :9224 WS     │                │                    │             │          │
└──────────────┘              └──────────────┘                 └──────────────────┘             └──────────┘
```

1. The **Chrome extension** connects to the relay server via WebSocket and identifies itself
2. The **relay server** brokers messages between the AI agent and the extension
3. The **content script** executes DOM commands (click, type, read, etc.) in web pages
4. The **CLI client** (or OpenClaw agent) sends commands via HTTP to the relay

## Features

- 🖱️ **Click** — multi-strategy element resolution (selector, xpath, text, ARIA, coordinates)
- ⌨️ **Type** — realistic input with event dispatch
- 📖 **Read** — structured page content with element metadata
- 📸 **Screenshot** — capture visible tab as PNG
- 🔽 **Select** — dropdown/selector interaction
- 📜 **Scroll** — page or element scrolling
- ⌨️ **Press** — keyboard events (Enter, Tab, Escape, etc.)
- ⏳ **Wait** — wait for element appearance
- 🎯 **Highlight** — visual element debugging
- 🗂️ **Tab Management** — list, switch, close tabs
- 🧭 **Navigate** — go to URLs
- 💬 **Chat** — side panel chat with OpenClaw agent
- 🔌 **Auto-reconnect** — resilient WebSocket with backoff
- 🛡️ **Auth** — optional token-based authentication

## Installation

### Prerequisites

- Chrome or Chromium-based browser
- Node.js 18+

### Relay Server

```bash
cd relay
npm install
cp .env.example .env
# Edit .env with your OpenClaw gateway token
npm start
```

### Chrome Extension (Developer Mode)

> **Note:** A Chrome Web Store release is planned. For now, use Developer Mode.

1. Open `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. The 🦞 icon should appear in your toolbar

**Generating PNG icons:** The extension includes an SVG icon (`extension/icons/icon.svg`). For proper icons at all sizes, generate PNGs from the SVG:

```bash
# Using Inkscape:
inkscape icon.svg -w 16 -h 16 -o icon-16.png
inkscape icon.svg -w 48 -h 48 -o icon-48.png
inkscale icon.svg -w 128 -h 128 -o icon-128.png
```

Placeholder 1x1 PNGs are included so the manifest loads without errors.

## Quick Start

### 1. Start the relay

```bash
cd relay
npm install
npm start
```

You should see:
```
[relay] WebSocket server listening on ws://localhost:9224
[relay] HTTP server listening on http://localhost:9225
```

### 2. Install the extension

Load the `extension/` folder in Chrome (see Installation above).

### 3. Complete onboarding

The extension options page opens automatically with a 3-step wizard:
1. **Welcome** — intro screen
2. **Relay test** — verify connection to relay server
3. **Gateway test** — verify OpenClaw gateway works (tested via relay, no direct config needed)

### 4. Use it

From a terminal:
```bash
# Read the current page
node skill/lib/client.js read

# Click a button
node skill/lib/client.js click --selector "#submit-btn"

# Take a screenshot
node skill/lib/client.js screenshot --save
```

Or let OpenClaw control Chrome directly — commands are sent from the agent through the relay to the extension.

## Commands

| Command | Description | Key Options |
|---------|-------------|-------------|
| `read` | Read page content with element markers | `--format text\|html\|accessibility` |
| `click` | Click an element | `--selector`, `--xpath`, `--text`, `--aria-label` |
| `type` | Type text into an element | `--selector`, `--value`, `--no-clear` |
| `select` | Select a dropdown option | `--selector`, `--value` |
| `scroll` | Scroll the page | `--value <pixels>`, `--direction vertical\|horizontal` |
| `press` | Press a keyboard key | `--value Enter\|Tab\|Escape` |
| `wait` | Wait for element to appear | `--selector`, `--timeout <ms>` |
| `highlight` | Visually highlight an element | `--selector` |
| `screenshot` | Capture the visible tab | `--save` (write to PNG file) |
| `list_tabs` | List all open tabs | |
| `switch_tab` | Switch to a specific tab | `--value <tabId>` |
| `close_tab` | Close a tab | `--value <tabId>` |
| `navigate` | Navigate to a URL | `--value <url>` |

### Element Targeting

Commands that target elements support multiple resolution strategies, tried in order:

1. **`--selector`** — CSS selector (`#my-btn`, `.card .title`)
2. **`--xpath`** — XPath expression (`//button[@type='submit']`)
3. **`--text`** — Text content match ("Sign In", "Submit")
4. **`--aria-label`** — ARIA label match
5. **`--coordinates`** — X,Y pixel coordinates

## Configuration

### Relay Server (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_PORT` | `9224` | WebSocket port (extension & chat connect here) |
| `HTTP_PORT` | `9225` | HTTP port (CLI client and health checks) |
| `OPENCLAW_API_URL` | `http://localhost:18789` | OpenClaw gateway URL |
| `OPENCLAW_API_TOKEN` | — | Gateway API token |
| `AUTH_TOKEN` | — | Optional auth token for relay connections |

### Extension Settings

Configured via the options page (right-click extension → Options):

- **Relay URL** — WebSocket URL for the relay server (default: `ws://localhost:9224`)
- **Gateway test** — Verified through the relay server, no direct configuration needed

## Remote Access

### SSH Tunnel

If the relay server is on a remote machine:

```bash
ssh -L 9224:localhost:9224 -L 9225:localhost:9225 user@remote-host
```

Then point the extension at `ws://localhost:9224` as usual.

### LAN Access

The relay server binds to `localhost` by default. To allow LAN connections, set the relay URL in extension settings to the machine's LAN IP (e.g., `ws://192.168.1.100:9224`).

> ⚠️ **Security:** Use `AUTH_TOKEN` in the relay `.env` when exposing beyond localhost.

## License

MIT
