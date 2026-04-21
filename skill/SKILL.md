# OpenClaw Chrome Control — Skill

Control a real Chrome browser from OpenClaw via the Chrome Control extension and relay server.

## Setup

1. Install the Chrome extension (Developer Mode → Load Unpacked)
2. Start the relay server: `cd relay && npm start`
3. Complete the onboarding wizard in the extension options

## Usage

Use `client.js` to send commands to the browser through the relay server:

```bash
# Read page content
node skill/lib/client.js read

# Click an element
node skill/lib/client.js click --selector "#search-btn"

# Type into a field
node skill/lib/client.js type --selector "#search-input" --value "hello world"

# Take a screenshot
node skill/lib/client.js screenshot

# Save screenshot to file
node skill/lib/client.js screenshot --save

# List open tabs
node skill/lib/client.js list_tabs

# Check relay status
node skill/lib/client.js --status
```

## Commands

| Command | Description | Key Options |
|---------|-------------|-------------|
| `read` | Read page content | `--format text\|html\|accessibility` |
| `click` | Click an element | `--selector`, `--xpath`, `--text`, `--aria-label` |
| `type` | Type text into element | `--selector`, `--value`, `--no-clear` |
| `select` | Select dropdown option | `--selector`, `--value` |
| `scroll` | Scroll page | `--value <pixels>`, `--direction vertical\|horizontal` |
| `press` | Press a key | `--value Enter\|Tab\|Escape` |
| `wait` | Wait for element | `--selector`, `--timeout 10000` |
| `highlight` | Highlight element | `--selector` |
| `screenshot` | Capture visible tab | `--save` (write to PNG) |
| `list_tabs` | List open tabs | |
| `switch_tab` | Switch to tab | `--value <tabId>` |
| `close_tab` | Close a tab | `--value <tabId>` |
| `navigate` | Navigate to URL | `--value <url>` |

## Element Targeting

Commands accept multiple targeting strategies (tried in order):
1. `--selector` — CSS selector
2. `--xpath` — XPath expression
3. `--text` — Text content match
4. `--aria-label` — ARIA label match
5. `--coordinates` — X,Y coordinates

## Architecture

```
OpenClaw Agent → (HTTP POST) → Relay Server → (WebSocket) → Chrome Extension → (Content Script) → Web Page
```
