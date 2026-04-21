// OpenClaw Chrome Control — Popup

(function () {
  'use strict';

  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const toggleBtn = document.getElementById('toggleBtn');
  const optionsBtn = document.getElementById('optionsBtn');

  function updateUI(state) {
    statusDot.className = 'status-dot ' + (state || 'disconnected');
    const labels = {
      disconnected: 'Disconnected',
      connecting: 'Connecting...',
      connected: 'Connected',
      error: 'Error',
    };
    statusText.textContent = labels[state] || 'Disconnected';

    const isConnected = state === 'connected' || state === 'connecting';
    toggleBtn.textContent = isConnected ? 'Disconnect' : 'Connect';
    toggleBtn.classList.toggle('active', isConnected);
  }

  // Get current state
  chrome.runtime.sendMessage({ type: 'getConnectionState' }, (response) => {
    if (response) updateUI(response.state);
  });

  // Toggle connection
  toggleBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'getConnectionState' }, (response) => {
      if (!response) return;
      const isConnected = response.state === 'connected' || response.state === 'connecting';
      chrome.runtime.sendMessage(
        { type: isConnected ? 'disconnect' : 'connect' },
        () => {
          updateUI(isConnected ? 'disconnected' : 'connecting');
          // Refresh state after a moment
          setTimeout(() => {
            chrome.runtime.sendMessage({ type: 'getConnectionState' }, (r) => {
              if (r) updateUI(r.state);
            });
          }, 1500);
        }
      );
    });
  });

  // Open options
  optionsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
})();
