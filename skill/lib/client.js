#!/usr/bin/env node
// OpenClaw Chrome Control — CLI Client
// Sends commands to the relay server which forwards them to the Chrome extension.

const http = require('http');
const fs = require('fs');
const path = require('path');

const RELAY_HOST = process.env.OCCC_HOST || 'localhost';
const RELAY_PORT = parseInt(process.env.OCCC_PORT || '9225', 10);
const AUTH_TOKEN = process.env.OCCC_AUTH_TOKEN || '';

// ── Parse Args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: client.js [options] <command>

Commands:
  read            Read page content
  click           Click an element
  type            Type text into an element
  select          Select a dropdown option
  scroll          Scroll the page
  press           Press a key
  wait            Wait for an element
  highlight       Highlight an element
  screenshot      Take a screenshot
  list_tabs       List open tabs
  switch_tab      Switch to a tab
  close_tab       Close a tab
  navigate        Navigate to a URL

Options:
  --status        Check relay server status
  --save          Save screenshot to PNG file
  --selector <s>  CSS selector
  --xpath <x>     XPath expression
  --text <t>      Text content to match
  --aria-label <l> ARIA label to match
  --value <v>     Value for type/select/press/scroll/navigate
  --format <f>    Output format for read (text|html|accessibility)
  --timeout <ms>  Timeout for wait command
  --no-clear      Don't clear field before typing
  --direction <d> Scroll direction (vertical|horizontal)
  --help, -h      Show this help
`);
  process.exit(0);
}

// ── Status Check ──────────────────────────────────────────────────────────

if (args.includes('--status')) {
  httpGet('/status', (err, data) => {
    if (err) {
      console.error('❌ Relay not reachable:', err.message);
      process.exit(1);
    }
    console.log('Relay Status:');
    console.log(`  Extension: ${data.extensionConnected ? '✅ Connected' : '❌ Not connected'}`);
    console.log(`  Agent:     ${data.agentConnected ? '✅ Connected' : '❌ Not connected'}`);
    console.log(`  Uptime:    ${formatUptime(data.uptime)}`);
  });
  process.exit(0);
}

// ── Parse Command & Options ──────────────────────────────────────────────

const action = args[0];
if (!action) {
  console.error('Usage: client.js [--status] <command> [options]');
  process.exit(1);
}

const options = {};
const target = {};
let value = null;

for (let i = 1; i < args.length; i++) {
  switch (args[i]) {
    case '--selector': target.selector = args[++i]; break;
    case '--xpath': target.xpath = args[++i]; break;
    case '--text': target.text = args[++i]; break;
    case '--aria-label': target.ariaLabel = args[++i]; break;
    case '--value': value = args[++i]; break;
    case '--format': options.format = args[++i]; break;
    case '--timeout': options.timeout = parseInt(args[++i], 10); break;
    case '--no-clear': options.clear = false; break;
    case '--direction': options.direction = args[++i]; break;
    case '--save': options.save = true; break;
    default:
      console.warn(`Unknown option: ${args[i]}`);
  }
}

// ── Send Command ──────────────────────────────────────────────────────────

const command = { action, target, value, options };
if (AUTH_TOKEN) command.auth = AUTH_TOKEN;

httpPost('/', command, (err, data) => {
  if (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }

  if (data.error) {
    console.error('❌ Command error:', data.error);
    process.exit(1);
  }

  // Handle screenshot
  if (action === 'screenshot' && data.screenshot) {
    if (options.save) {
      const filename = `screenshot-${Date.now()}.png`;
      fs.writeFileSync(filename, Buffer.from(data.screenshot, 'base64'));
      console.log(`📸 Screenshot saved to ${filename}`);
    } else {
      // Output base64
      console.log(data.screenshot);
    }
    return;
  }

  // Handle read
  if (action === 'read') {
    if (data.content) console.log(data.content);
    if (data.elements && data.elements.length > 0) {
      console.log('\n--- Elements ---');
      for (const el of data.elements.slice(0, 20)) {
        console.log(`[${el.index}] <${el.tag}> ${el.text?.substring(0, 60) || ''}${el.value ? ` [value="${el.value}"]` : ''}`);
        if (el.options) {
          for (const opt of el.options) {
            console.log(`    ${opt.selected ? '→ ' : '  '}${opt.text} (${opt.value})`);
          }
        }
      }
      if (data.elements.length > 20) {
        console.log(`... and ${data.elements.length - 20} more`);
      }
    }
    return;
  }

  // Handle list_tabs
  if (action === 'list_tabs' && data.tabs) {
    for (const tab of data.tabs) {
      console.log(`${tab.active ? '→' : ' '} [${tab.id}] ${tab.title?.substring(0, 60) || 'Untitled'}`);
      console.log(`   ${tab.url?.substring(0, 80) || ''}`);
    }
    return;
  }

  // Default: pretty print
  console.log(JSON.stringify(data, null, 2));
});

// ── HTTP Helpers ─────────────────────────────────────────────────────────

function httpGet(path, callback) {
  const req = http.get({
    hostname: RELAY_HOST,
    port: RELAY_PORT,
    path,
    headers: AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {},
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        callback(null, JSON.parse(body));
      } catch {
        callback(new Error('Invalid JSON response'));
      }
    });
  });
  req.on('error', callback);
}

function httpPost(path, data, callback) {
  const body = JSON.stringify(data);
  const req = http.request({
    hostname: RELAY_HOST,
    port: RELAY_PORT,
    path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
    },
  }, (res) => {
    let responseBody = '';
    res.on('data', (chunk) => { responseBody += chunk; });
    res.on('end', () => {
      try {
        callback(null, JSON.parse(responseBody));
      } catch {
        callback(new Error('Invalid JSON response'));
      }
    });
  });
  req.on('error', callback);
  req.write(body);
  req.end();
}

function formatUptime(seconds) {
  if (!seconds) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
