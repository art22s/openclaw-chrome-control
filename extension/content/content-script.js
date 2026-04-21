// OpenClaw Chrome Control — Content Script
// Handles DOM commands: read, click, type, select, scroll, press, wait, highlight

(function () {
  'use strict';

  if (window.__openclawContentScriptLoaded) return;
  window.__openclawContentScriptLoaded = true;

  // ── Element Resolution ────────────────────────────────────────────────

  function resolveElement(target) {
    if (!target) return null;

    // 1. CSS selector
    if (target.selector) {
      const el = document.querySelector(target.selector);
      if (el) return el;
    }

    // 2. XPath
    if (target.xpath) {
      const result = document.evaluate(target.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      if (result.singleNodeValue) return result.singleNodeValue;
    }

    // 3. Text content match
    if (target.text) {
      const els = document.querySelectorAll('*');
      for (const el of els) {
        if (el.textContent.trim().includes(target.text) && el.children.length === 0) {
          return el;
        }
      }
      // Also check elements with children but direct text match
      for (const el of els) {
        if (el.textContent.trim() === target.text.trim()) return el;
      }
    }

    // 4. ARIA role/label
    if (target.ariaRole || target.ariaLabel) {
      const els = document.querySelectorAll('*');
      for (const el of els) {
        if (target.ariaRole && el.getAttribute('role') === target.ariaRole) {
          if (!target.ariaLabel || el.getAttribute('aria-label') === target.ariaLabel) {
            return el;
          }
        }
        if (target.ariaLabel && el.getAttribute('aria-label')?.includes(target.ariaLabel)) {
          return el;
        }
      }
    }

    // 5. Coordinates
    if (target.coordinates) {
      const [x, y] = target.coordinates;
      const el = document.elementFromPoint(x, y);
      if (el) return el;
    }

    return null;
  }

  // ── Helper: Dispatch events ───────────────────────────────────────────

  function dispatchEvents(el, eventTypes) {
    for (const type of eventTypes) {
      el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    }
  }

  // ── Helper: Get unique selector ────────────────────────────────────────

  function getSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const path = [];
    while (el && el !== document.documentElement) {
      let selector = el.tagName.toLowerCase();
      if (el.id) {
        selector = `#${CSS.escape(el.id)}`;
        path.unshift(selector);
        break;
      }
      const siblings = Array.from(el.parentNode.children).filter((s) => s.tagName === el.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(el) + 1;
        selector += `:nth-of-type(${index})`;
      }
      path.unshift(selector);
      el = el.parentNode;
    }
    return path.join(' > ');
  }

  // ── Commands ──────────────────────────────────────────────────────────

  async function cmdRead(options = {}) {
    const format = options.format || 'text';

    if (format === 'html') {
      return { content: document.documentElement.outerHTML, format: 'html' };
    }

    if (format === 'accessibility') {
      // Simplified accessibility tree
      const tree = buildAccessibilityTree(document.body, 0, 3);
      return { content: tree, format: 'accessibility' };
    }

    // Default: text format with element markers
    const elements = [];
    let counter = 0;
    const body = document.body;

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        if (text) {
          counter++;
          const parent = node.parentElement;
          const elInfo = {
            index: counter,
            tag: parent?.tagName?.toLowerCase() || 'text',
            text: text.substring(0, 200),
            selector: parent ? getSelector(parent) : '',
          };
          // Include options for select elements
          if (parent?.tagName === 'SELECT') {
            elInfo.options = Array.from(parent.options).map((o) => ({
              value: o.value,
              text: o.text,
              selected: o.selected,
            }));
          }
          if (parent?.tagName === 'INPUT' || parent?.tagName === 'TEXTAREA') {
            elInfo.value = parent.value;
            elInfo.type = parent.type || 'text';
          }
          // Include attributes
          if (parent && parent.attributes.length > 0) {
            elInfo.attributes = {};
            for (const attr of parent.attributes) {
              if (['class', 'style', 'data-reactid'].includes(attr.name)) continue;
              elInfo.attributes[attr.name] = attr.value.substring(0, 100);
            }
            if (Object.keys(elInfo.attributes).length === 0) delete elInfo.attributes;
          }
          elements.push(elInfo);
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        for (const child of node.childNodes) {
          walk(child);
        }
      }
    }

    walk(body);

    // Build marked text
    let textContent = '';
    let idx = 0;
    function walkText(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        if (text) {
          idx++;
          textContent += `[${idx}] ${text} `;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        if (['br', 'hr'].includes(tag)) {
          textContent += '\n';
        }
        for (const child of node.childNodes) {
          walkText(child);
        }
        if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr'].includes(tag)) {
          textContent += '\n';
        }
      }
    }
    walkText(body);

    return { content: textContent.trim(), elements, format: 'text' };
  }

  function buildAccessibilityTree(node, depth, maxDepth) {
    if (!node || depth > maxDepth) return '';
    let result = '';
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      const role = node.getAttribute('role') || '';
      const label = node.getAttribute('aria-label') || node.getAttribute('alt') || node.getAttribute('title') || '';
      const text = (node.textContent || '').trim().substring(0, 100);
      const indent = '  '.repeat(depth);
      if (role || label || ['button', 'a', 'input', 'select', 'textarea', 'img', 'h1', 'h2', 'h3'].includes(tag)) {
        result += `${indent}<${tag}${role ? ` role="${role}"` : ''}${label ? ` aria-label="${label}"` : ''}> ${text}\n`;
      }
      for (const child of node.children) {
        result += buildAccessibilityTree(child, depth + 1, maxDepth);
      }
    }
    return result;
  }

  async function cmdClick(target, options = {}) {
    const timeout = options.timeout || 3000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const el = resolveElement(target);
      if (el) {
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        el.focus();
        el.click();
        dispatchEvents(el, ['mousedown', 'mouseup', 'click']);
        return { ok: true, element: describeElement(el) };
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    return { error: 'Element not found for click', target };
  }

  async function cmdType(target, value, options = {}) {
    const el = resolveElement(target);
    if (!el) return { error: 'Element not found for typing', target };

    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.focus();

    if (options.clear !== false) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.value = '';
        dispatchEvents(el, ['input', 'change']);
      } else {
        // contenteditable
        el.textContent = '';
      }
    }

    // Type character by character for more realistic input
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;

    if (el.tagName === 'INPUT' && nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else if (el.tagName === 'TEXTAREA' && nativeInputValueSetter) {
      const textareaSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;
      if (textareaSetter) {
        textareaSetter.call(el, value);
      } else {
        el.value = value;
      }
    } else if (el.contentEditable === 'true') {
      el.textContent = value;
    } else {
      el.value = value;
    }

    dispatchEvents(el, ['input', 'change', 'keyup']);
    return { ok: true, value, element: describeElement(el) };
  }

  async function cmdSelect(target, value) {
    const el = resolveElement(target);
    if (!el) return { error: 'Element not found for select', target };
    if (el.tagName !== 'SELECT') return { error: 'Element is not a select', element: describeElement(el) };

    // Find matching option
    const option = Array.from(el.options).find(
      (o) => o.value === value || o.text.trim().toLowerCase() === value.toLowerCase()
    );

    if (!option) {
      return {
        error: 'No matching option',
        available: Array.from(el.options).map((o) => ({ value: o.value, text: o.text })),
      };
    }

    el.value = option.value;
    dispatchEvents(el, ['input', 'change']);
    return { ok: true, value: option.value, text: option.text };
  }

  async function cmdScroll(target, value, options = {}) {
    const amount = parseInt(value, 10) || 0;
    const direction = options.direction || 'vertical';
    const el = target ? resolveElement(target) : null;

    if (el) {
      if (direction === 'horizontal') {
        el.scrollLeft += amount;
      } else {
        el.scrollTop += amount;
      }
    } else {
      if (direction === 'horizontal') {
        window.scrollBy(amount, 0);
      } else {
        window.scrollBy(0, amount);
      }
    }

    return { ok: true, scrolled: amount, direction };
  }

  async function cmdPress(target, value) {
    const key = value || target?.key;
    if (!key) return { error: 'No key specified' };

    // If there's a specific target, focus it first
    if (target && target.selector) {
      const el = resolveElement(target);
      if (el) el.focus();
    }

    const activeEl = document.activeElement;
    const eventInit = {
      key,
      code: `Key${key.charAt(0).toUpperCase()}${key.slice(1)}`,
      bubbles: true,
      cancelable: true,
    };

    activeEl?.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    activeEl?.dispatchEvent(new KeyboardEvent('keypress', eventInit));
    activeEl?.dispatchEvent(new KeyboardEvent('keyup', eventInit));

    return { ok: true, key };
  }

  async function cmdWait(target, options = {}) {
    const timeout = options.timeout || 10000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const el = resolveElement(target);
      if (el) return { ok: true, element: describeElement(el) };
      await new Promise((r) => setTimeout(r, 250));
    }

    return { error: 'Timeout waiting for element', target, timeout };
  }

  async function cmdHighlight(target, options = {}) {
    const el = resolveElement(target);
    if (!el) return { error: 'Element not found for highlight', target };

    el.scrollIntoView({ behavior: 'instant', block: 'center' });

    // Remove existing highlights
    document.querySelectorAll('.openclaw-highlight').forEach((h) => h.classList.remove('openclaw-highlight'));

    el.classList.add('openclaw-highlight');

    // Auto-remove after 3 seconds
    setTimeout(() => el.classList.remove('openclaw-highlight'), 3000);

    return { ok: true, element: describeElement(el) };
  }

  // ── Element description helper ─────────────────────────────────────────

  function describeElement(el) {
    return {
      tag: el.tagName?.toLowerCase(),
      id: el.id || undefined,
      classes: el.className?.toString()?.split(' ').filter(Boolean) || undefined,
      text: el.textContent?.trim().substring(0, 100) || undefined,
      selector: getSelector(el),
    };
  }

  // ── Message handler ────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const { action, target, value, options } = msg;

    (async () => {
      try {
        let result;
        switch (action) {
          case 'read':
            result = await cmdRead(options);
            break;
          case 'click':
            result = await cmdClick(target, options);
            break;
          case 'type':
            result = await cmdType(target, value, options);
            break;
          case 'select':
            result = await cmdSelect(target, value);
            break;
          case 'scroll':
            result = await cmdScroll(target, value, options);
            break;
          case 'press':
            result = await cmdPress(target, value);
            break;
          case 'wait':
            result = await cmdWait(target, options);
            break;
          case 'highlight':
            result = await cmdHighlight(target, options);
            break;
          default:
            result = { error: `Unknown action: ${action}` };
        }
        sendResponse(result);
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();

    return true; // async response
  });
})();
