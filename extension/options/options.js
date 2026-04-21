// OpenClaw Chrome Control — Options Page (Onboarding Wizard + Settings)

(function () {
  'use strict';

  // ── Elements ──────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);

  const wizard = $('wizard');
  const settings = $('settings');
  const settingsToggle = $('settingsToggle');

  const stepIndicator = $('stepIndicator');
  const steps = [1, 2, 3, 4];
  let currentStep = 1;

  const relayUrlInput = $('relayUrlInput');
  const settingsRelayUrl = $('settingsRelayUrl');

  // ── Step Navigation ────────────────────────────────────────────────────

  function showStep(n) {
    currentStep = n;
    steps.forEach((s) => {
      const el = $(`step${s}`);
      if (el) el.classList.toggle('hidden', s !== n);
    });
    // Update dots
    stepIndicator.querySelectorAll('.step-dot').forEach((dot) => {
      const s = parseInt(dot.dataset.step, 10);
      dot.classList.toggle('active', s === n);
      dot.classList.toggle('done', s < n);
    });
  }

  // Step 1
  $('btnNext1')?.addEventListener('click', () => showStep(2));

  // Step 2 — Relay Test
  $('btnBack2')?.addEventListener('click', () => showStep(1));
  $('btnTestRelay')?.addEventListener('click', async () => {
    const resultEl = $('relayTestResult');
    resultEl.innerHTML = '';
    try {
      const relayWs = relayUrlInput?.value.trim() || 'ws://localhost:9224';
      const relayHttp = relayWs.replace(/^ws/, 'http').replace(/:\d+$/, ':9225');
      const res = await fetch(relayHttp + '/status');
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      resultEl.innerHTML = `<div class="test-result success">✅ Relay connected!${data.extensionConnected ? ' Extension is online.' : ' Extension not connected yet.'}</div>`;
      $('btnNext2').disabled = false;
    } catch (err) {
      resultEl.innerHTML = `<div class="test-result failure">❌ Could not reach relay server. Is it running?</div>`;
    }
  });

  // Step 3 — Gateway Test
  $('btnBack3')?.addEventListener('click', () => showStep(2));
  $('btnTestGateway')?.addEventListener('click', async () => {
    const resultEl = $('gatewayTestResult');
    resultEl.innerHTML = '';
    try {
      const data = await testGatewayViaRelay();
      if (data.ok) {
        resultEl.innerHTML = `<div class="test-result success">✅ Gateway connected! ${data.modelCount} model(s) available.</div>`;
        $('btnNext3').disabled = false;
      } else {
        resultEl.innerHTML = `<div class="test-result failure">❌ Gateway error: ${data.error}</div>`;
      }
    } catch (err) {
      resultEl.innerHTML = `<div class="test-result failure">❌ ${err.message}</div>`;
    }
  });

  // Step 4
  $('btnFinish')?.addEventListener('click', async () => {
    // Save settings and close
    const relayUrl = relayUrlInput?.value.trim() || 'ws://localhost:9224';
    await chrome.storage.local.set({ relayUrl, setupComplete: true });
    chrome.runtime.sendMessage({ type: 'settings_updated' });
    showSettings();
  });

  // ── Gateway Test via Relay ───────────────────────────────────────────────

  function testGatewayViaRelay() {
    return new Promise((resolve, reject) => {
      const relayWs = (relayUrlInput ? relayUrlInput.value.trim() : '') || (settingsRelayUrl ? settingsRelayUrl.value.trim() : '') || 'ws://localhost:9224';
      const relayHttp = relayWs.replace(/^ws/, 'http').replace(/:\d+$/, ':9225');
      fetch(relayHttp + '/gateway-test')
        .then(res => { if (!res.ok) throw new Error('Relay not reachable'); return res.json(); })
        .then(data => resolve(data))
        .catch(err => reject(new Error(err.message || 'Relay not reachable — test relay first')));
      setTimeout(() => reject(new Error('timeout')), 6000);
    });
  }

  // ── Settings View ───────────────────────────────────────────────────────

  function showSettings() {
    wizard.classList.add('hidden');
    settings.classList.remove('hidden');
    settingsToggle.classList.remove('hidden');

    // Load current settings
    chrome.storage.local.get(['relayUrl'], (result) => {
      if (result.relayUrl) settingsRelayUrl.value = result.relayUrl;
    });
  }

  function showWizard() {
    settings.classList.add('hidden');
    wizard.classList.remove('hidden');
  }

  settingsToggle?.addEventListener('click', () => {
    if (settings.classList.contains('hidden')) {
      showSettings();
    } else {
      showWizard();
    }
  });

  // Settings — Relay test
  $('btnTestRelaySettings')?.addEventListener('click', async () => {
    const resultEl = $('settingsRelayTestResult');
    resultEl.innerHTML = '';
    try {
      const relayWs = settingsRelayUrl?.value.trim() || 'ws://localhost:9224';
      const relayHttp = relayWs.replace(/^ws/, 'http').replace(/:\d+$/, ':9225');
      const res = await fetch(relayHttp + '/status');
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      resultEl.innerHTML = `<div class="test-result success">✅ Relay connected!</div>`;
    } catch {
      resultEl.innerHTML = `<div class="test-result failure">❌ Could not reach relay server.</div>`;
    }
  });

  // Settings — Gateway test
  $('btnTestGatewaySettings')?.addEventListener('click', async () => {
    const resultEl = $('settingsGatewayTestResult');
    resultEl.innerHTML = '';
    try {
      const data = await testGatewayViaRelay();
      if (data.ok) {
        resultEl.innerHTML = `<div class="test-result success">✅ Gateway connected! ${data.modelCount} model(s) available.</div>`;
      } else {
        resultEl.innerHTML = `<div class="test-result failure">❌ Gateway error: ${data.error}</div>`;
      }
    } catch (err) {
      resultEl.innerHTML = `<div class="test-result failure">❌ ${err.message}</div>`;
    }
  });

  // Settings — Save
  $('btnSaveSettings')?.addEventListener('click', async () => {
    const relayUrl = settingsRelayUrl?.value.trim() || 'ws://localhost:9224';
    await chrome.storage.local.set({ relayUrl, setupComplete: true });
    chrome.runtime.sendMessage({ type: 'settings_updated' });
    const saveBtn = $('btnSaveSettings');
    const origText = saveBtn.textContent;
    saveBtn.textContent = '✅ Saved!';
    setTimeout(() => { saveBtn.textContent = origText; }, 2000);
  });

  // ── Init ────────────────────────────────────────────────────────────────

  chrome.storage.local.get(['setupComplete'], (result) => {
    if (result.setupComplete) {
      showSettings();
    }
  });
})();
