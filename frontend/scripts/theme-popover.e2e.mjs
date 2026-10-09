import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const port = 18000 + Math.floor(Math.random() * 1000);
const chromePort = port + 1000;
const temporary = await mkdtemp(join(tmpdir(), 'jian-theme-e2e-'));
const config = join(temporary, 'config.json');
const processes = [];
const browser = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome';

const start = (command, args, options = {}) => {
  const child = spawn(command, args, { stdio: 'ignore', detached: true, ...options });
  processes.push(child);
  return child;
};

const waitFor = async (check, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
};

class CDP {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextID = 1;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
      this.socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      });
    });
  }

  send(method, params = {}) {
    const id = this.nextID++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}

try {
  await writeFile(config, JSON.stringify({ bind_ip: '127.0.0.1', listen_port: port }));
  start('cargo', ['run', '--quiet', '--', '--config', config], {
    cwd: root,
    env: {
      ...process.env,
      JIAN_DB: join(temporary, 'jian.db'),
      JIAN_ADMIN_USER: 'theme-test',
      JIAN_ADMIN_PASSWORD: 'theme-test-password',
      JIAN_CODEX_BIN: join(temporary, 'missing-codex'),
      JIAN_HERMES_BIN: join(temporary, 'missing-hermes'),
    },
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/auth/status`)).ok, 'Jian server');

  start(browser, [
    '--headless=new', '--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${join(temporary, 'chrome')}`,
    'about:blank',
  ]);
  const page = await waitFor(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json();
    return pages.find(item => item.type === 'page');
  }, 'Chrome DevTools');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  const screenshot = async name => {
    if (!process.env.JIAN_E2E_SCREENSHOTS) return;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(process.env.JIAN_E2E_SCREENSHOTS, name + '.png'), Buffer.from(data, 'base64'));
  };
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const NativeWebSocket = window.WebSocket;
    window.__terminalSockets = [];
    window.__rpcRequests = []; window.__rpcResponses = []; window.__rpcRules = []; window.__heldRPC = [];
    const nativeSend = NativeWebSocket.prototype.send;
    let rpcID = 1000000;
    window.__rpcCall = (path, method = 'GET', body) => new Promise((resolve, reject) => {
      const socket = window.__apiSocket, id = ++rpcID;
      const receive = event => {
        const response = JSON.parse(event.data);
        if (response.id !== id) return;
        socket.removeEventListener('message', receive);
        if (response.status >= 200 && response.status < 300) resolve(response.body); else reject(new Error(response.body?.error));
      };
      socket.addEventListener('message', receive);
      nativeSend.call(socket, JSON.stringify({ id, path, method, body }));
    });
    window.__releaseRPC = label => {
      const index = window.__heldRPC.findIndex(item => item.label === label);
      if (index < 0) throw new Error('held RPC missing: ' + label);
      window.__heldRPC.splice(index, 1)[0].send();
    };
    window.WebSocket = new Proxy(NativeWebSocket, { construct(target, args, receiver) {
      const socket = Reflect.construct(target, args, receiver);
      if (String(args[0]).includes('/terminal')) window.__terminalSockets.push(socket);
      if (String(args[0]).endsWith('/api/ws')) {
        window.__apiSocket = socket;
        socket.addEventListener('message', event => { try { const message = JSON.parse(event.data); if (message.id) window.__rpcResponses.push(message.id); } catch {} });
        socket.send = function(data) {
          let request; try { request = JSON.parse(data); } catch {}
          if (!request?.id) return nativeSend.call(socket, data);
          window.__rpcRequests.push(request);
          const index = window.__rpcRules.findIndex(rule => request.method === rule.method && (rule.path ? request.path === rule.path : request.path.startsWith(rule.prefix)));
          if (index < 0) return nativeSend.call(socket, data);
          const rule = window.__rpcRules.splice(index, 1)[0];
          const send = () => rule.error || rule.body !== undefined ? socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, status: rule.error ? 503 : 200, body: rule.error ? { error: rule.error } : rule.body }) })) : nativeSend.call(socket, data);
          if (rule.hold) window.__heldRPC.push({ ...request, label: rule.label, send }); else setTimeout(send, 0);
        };
      }
      return socket;
    } });
  })()` });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.login')`), 'initial page');
  await screenshot('login');
  await cdp.evaluate(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'theme-test', password: 'theme-test-password' }) }).then(response => { if (!response.ok) throw new Error('login failed'); location.reload(); })`);
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.context-actions')`), 'authenticated workspace');

  const clickSelector = async (selector, label) => {
    const clicked = await cdp.evaluate(`(() => { const button = document.querySelector(${JSON.stringify(selector)}); if (!button) return false; button.click(); return true; })()`);
    if (!clicked) throw new Error(`${label} is missing`);
  };
  const click = async label => {
    if (['界面主题', 'Terminal 配色'].includes(label) && !await cdp.evaluate(`!!document.querySelector('button[aria-label="${label}"]')`))
      await clickSelector('button[aria-label="外观与终端工具"]', 'workbench tools');
    return clickSelector(`button[aria-label="${label}"]`, `${label} button`);
  };
  const dismissUnavailableNotice = async () => {
    const message = await cdp.evaluate(`document.querySelector('[role="dialog"]')?.textContent || ''`);
    if (!message) return;
    if (!message.includes('Codex app-server exited')) throw new Error('unexpected terminal dialog: ' + message);
    await clickSelector('[role="dialog"][aria-describedby="error-dialog-description"] button', 'unavailable Codex notice');
    await waitFor(() => cdp.evaluate(`!document.querySelector('.dialog-overlay')`), 'unavailable Codex notice to close');
  };
  const popupSelector = label => `.theme-menu[aria-label="${label}"][data-state="open"]`;
  const waitUntilOpen = label => waitFor(() => cdp.evaluate(`document.querySelector('button[aria-label="${label}"]')?.getAttribute('aria-expanded') === 'true' && !!document.querySelector(${JSON.stringify(popupSelector(label))})`), `${label} popup`);
  const waitUntilClosed = label => waitFor(() => cdp.evaluate(`document.querySelector('button[aria-label="${label}"]')?.getAttribute('aria-expanded') === 'false' && !document.querySelector(${JSON.stringify(popupSelector(label))})`), `${label} popup to close`);
  const assertOpen = async (label, close = true) => {
    await click(label);
    await waitUntilOpen(label);
    await new Promise(resolve => setTimeout(resolve, 300));
    const state = await cdp.evaluate(`(() => { const trigger = document.querySelector('button[aria-label="${label}"]'); const popup = document.querySelector(${JSON.stringify(popupSelector(label))}); if (!trigger || !popup) return { expanded: trigger?.getAttribute('aria-expanded'), visible: false }; const box = popup.getBoundingClientRect(); return { expanded: trigger.getAttribute('aria-expanded'), role: popup.getAttribute('role'), visible: box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight }; })()`);
    if (state.expanded !== 'true' || state.role !== 'dialog' || !state.visible) throw new Error(`${label} popup disappeared: ${JSON.stringify(state)}`);
    if (close) { await click(label); await waitUntilClosed(label); }
  };

  await waitFor(() => cdp.evaluate(`document.querySelector('.desktop-session-context .codex-quota')?.textContent === '额度暂不可用'`), 'unavailable quota state');
  await cdp.evaluate(`window.__rpcRules.push({ method: 'GET', path: '/agents/codex/rate-limits', body: {
    rateLimits: { primary: { usedPercent: 75, windowDurationMins: 300 }, secondary: { usedPercent: 85, windowDurationMins: 10080 } },
    rateLimitResetCredits: { availableCount: 3 }
  } }); document.dispatchEvent(new Event('visibilitychange'));`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.desktop-session-context .codex-quota')?.textContent === '5h: 25% | weekly: 15% | Reset: 3'`), 'desktop quota');
  const quotaRequests = await cdp.evaluate(`window.__rpcRequests.filter(item => item.path === '/agents/codex/rate-limits').length`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: true });
  await waitFor(() => cdp.evaluate(`document.querySelector('.mobile-workbench-header .mobile-codex-quota')?.textContent === '5h: 25% | weekly: 15% | Reset: 3'`), 'mobile quota');
  if (!await cdp.evaluate(`window.__rpcRequests.filter(item => item.path === '/agents/codex/rate-limits').length === ${quotaRequests}`)) throw new Error('mobile header duplicated quota requests');
  await cdp.evaluate(`window.__rpcRules.push({ method: 'GET', path: '/agents/codex/rate-limits', error: 'quota test outage' }); document.dispatchEvent(new Event('visibilitychange'));`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.mobile-workbench-header .codex-quota')?.textContent === '额度暂不可用'`), 'quota refresh error');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  console.log('PASS Codex quota remaining percentages, reset count, shared desktop/mobile snapshot and refresh errors (fixture data)');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('nav.agent-rail button:first-child')`), 'desktop navigation after quota test');

  await clickSelector('nav.agent-rail button:first-child', 'Local agent');
  await waitFor(() => cdp.evaluate(`document.querySelector('.catalog-header strong')?.textContent === 'Local Bash'`), 'Local catalog');
  await click('新建会话');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.terminal .xterm-helper-textarea') && !!document.querySelector('.terminal-search-toggle')`), 'local terminal');
  try {
    await waitFor(() => cdp.evaluate(`!!document.querySelector('.terminal-status-menu .status.running')`), 'running terminal');
  } catch (error) {
    const state = await cdp.evaluate(`({ status: document.querySelector('.terminal-status-menu .status')?.outerHTML, progress: document.querySelector('.terminal-progress')?.textContent, terminal: !!document.querySelector('.terminal .xterm-helper-textarea') })`);
    throw new Error(`${error.message}; terminal state: ${JSON.stringify(state)}`);
  }
  await dismissUnavailableNotice();
  await cdp.evaluate(`new Promise((resolve, reject) => {
    const id = localStorage.getItem('jian.active_local_session');
    const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/local/sessions/' + encodeURIComponent(id) + '/terminal');
    const timer = setTimeout(() => reject(new Error('terminal output timed out')), 5000);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'input', data: 'echo JIAN_ADDON_SEARCH_MARKER; echo https://example.com\\n' }));
    socket.onmessage = event => { const message = JSON.parse(event.data); if (message.type === 'pty.output' && message.payload.includes('JIAN_ADDON_SEARCH_MARKER')) { clearTimeout(timer); socket.close(); resolve(true); } };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('terminal websocket failed')); };
  })`);
  await new Promise(resolve => setTimeout(resolve, 500));
  await cdp.evaluate(`(() => { window.__searchFocusOrigin = document.activeElement === document.body ? document.querySelector('.terminal-search-toggle') : document.activeElement; return true; })()`);
  await click('搜索终端输出');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.terminal-search-bar input[type="search"]')`), 'terminal search bar');
  await cdp.evaluate(`(() => { const input = document.querySelector('.terminal-search-bar input[type="search"]'); const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setValue.call(input, 'JIAN_ADDON_SEARCH_MARKER'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  try {
    await waitFor(() => cdp.evaluate(`document.querySelector('.terminal-search-bar [aria-live="polite"]')?.textContent === '已找到匹配项'`), 'terminal search result');
  } catch (error) {
    const state = await cdp.evaluate(`({ query: document.querySelector('.terminal-search-bar input[type="search"]')?.value, status: document.querySelector('.terminal-search-bar [aria-live="polite"]')?.textContent, rows: document.querySelector('.terminal .xterm-rows')?.innerText, statusButton: document.querySelector('.terminal-status-menu .status')?.outerHTML })`);
    throw new Error(`${error.message}; search state: ${JSON.stringify(state)}`);
  }
  const renderers = await cdp.evaluate(`({ webgl: !!document.querySelector('.terminal canvas.xterm-glyph-layer'), fallback: !!document.querySelector('.terminal .xterm') })`);
  if (!renderers.webgl && !renderers.fallback) throw new Error(`terminal has no active renderer: ${JSON.stringify(renderers)}`);
  await click('关闭搜索');
  await waitFor(() => cdp.evaluate(`!document.querySelector('.terminal-search-bar') && document.activeElement === window.__searchFocusOrigin`), 'terminal search close and focus restore');
  const restoredSearchFocus = await cdp.evaluate(`({ equal: document.activeElement === window.__searchFocusOrigin, active: { tag: document.activeElement.tagName, className: document.activeElement.className }, expected: { tag: window.__searchFocusOrigin?.tagName, className: window.__searchFocusOrigin?.className, connected: window.__searchFocusOrigin?.isConnected } })`);
  if (!restoredSearchFocus.equal) throw new Error('closing search did not restore the original focus: ' + JSON.stringify(restoredSearchFocus));
  console.log(`PASS local terminal output is searchable; renderer: ${renderers.webgl ? 'WebGL' : 'xterm fallback'}`);

  const searchToggleFocused = await cdp.evaluate(`(() => { const button = document.querySelector('.terminal-search-toggle'); button?.focus(); window.__searchFocusBeforeReconnect = document.activeElement; return document.activeElement === button; })()`);
  if (!searchToggleFocused) throw new Error('could not focus the search toggle before reconnect test');
  await cdp.evaluate(`(() => { const button = document.querySelector('.terminal-search-toggle'); button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); button.click(); return true; })()`);
  await waitFor(() => cdp.evaluate(`document.activeElement.matches('.terminal-search-bar input[type="search"]')`), 'focused search input');
  if (!await cdp.evaluate(`window.__terminalSockets.some(socket => socket.readyState === WebSocket.OPEN)`)) throw new Error('active terminal websocket was not captured');
  await cdp.evaluate(`(() => { window.__reconnectSockets = [...new Set(window.__terminalSockets)].filter(socket => socket.readyState === WebSocket.OPEN); window.__reconnectSockets.forEach(socket => socket.close()); })()`);
  await waitFor(() => cdp.evaluate(`window.__reconnectSockets.length > 0 && window.__reconnectSockets.every(socket => socket.readyState === WebSocket.CLOSED)`), 'terminal websocket close', 5000);
  await waitFor(() => cdp.evaluate(`window.__terminalSockets.some(socket => !window.__reconnectSockets.includes(socket) && socket.readyState === WebSocket.OPEN)`), 'terminal websocket reconnect', 10000);
  await waitFor(() => cdp.evaluate(`document.querySelector('.terminal-status-menu .status')?.textContent.trim() === '已连接' && document.activeElement.matches('.terminal-search-bar input[type="search"]')`), 'search focus after terminal reconnect');
  await click('关闭搜索');
  await waitFor(() => cdp.evaluate(`!document.querySelector('.terminal-search-bar') && document.activeElement === window.__searchFocusBeforeReconnect`), 'search toggle focus restore after reconnect test', 5000);
  console.log('PASS search focus restores correctly and survives terminal reconnect');
  const retryOrigin = await cdp.evaluate(`(() => {
    window.__retryTerminal = document.querySelector('.terminal .xterm');
    window.__regularRetryTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => window.__regularRetryTimeout(callback, delay === 1000 ? 15000 : delay, ...args);
    const socket = window.__terminalSockets.findLast(socket => socket.readyState === WebSocket.OPEN);
    const count = window.__terminalSockets.length; socket.close(); return count;
  })()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.terminal-connection-feedback')?.getAttribute('data-state') === 'reconnecting' && !!document.querySelector('.terminal-connection-feedback button')`), 'inline connection recovery');
  await cdp.evaluate(`(() => { const button = document.querySelector('.terminal-connection-feedback button'); button.click(); button.click(); })()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.terminal-status-menu .status')?.textContent.trim() === '已连接'`), 'manual reconnect success');
  if (!await cdp.evaluate(`window.__terminalSockets.length === ${retryOrigin + 1} && document.querySelector('.terminal .xterm') === window.__retryTerminal`)) throw new Error('manual reconnect duplicated a socket or replaced xterm');
  await cdp.evaluate(`window.setTimeout = window.__regularRetryTimeout`);
  console.log('PASS inline manual retry reuses xterm and sends one connection');


  await assertOpen('Terminal 配色');
  await assertOpen('界面主题');
  await click('界面主题');
  await waitUntilOpen('界面主题');
  const interfaceCount = await cdp.evaluate(`document.querySelectorAll('.theme-menu[aria-label="界面主题"] button.theme-option').length`);
  if (interfaceCount !== 3) throw new Error(`unexpected interface theme count: ${interfaceCount}`);
  await click('Terminal 配色');
  await waitUntilOpen('Terminal 配色');
  const terminalCount = await cdp.evaluate(`document.querySelectorAll('.theme-menu[aria-label="Terminal 配色"] button.theme-option').length`);
  if (terminalCount !== 4) throw new Error(`unexpected Terminal theme count: ${terminalCount}`);
  await new Promise(resolve => setTimeout(resolve, 300));
  const switched = await cdp.evaluate(`document.querySelector('button[aria-label="Terminal 配色"]')?.getAttribute('aria-expanded') === 'true' && !document.querySelector(${JSON.stringify(popupSelector('界面主题'))})`);
  if (!switched) throw new Error('switching directly between theme popovers did not keep the second popup open');
  await click('Terminal 配色');
  await waitUntilClosed('Terminal 配色');

  await assertOpen('界面主题', false);
  await clickSelector(`${popupSelector('界面主题')} button[data-theme-preview="light"]`, 'light interface theme option');
  await waitUntilClosed('界面主题');
  await assertOpen('Terminal 配色', false);
  await clickSelector(`${popupSelector('Terminal 配色')} button[data-theme-preview="atom-one-dark"]`, 'Atom One Dark Terminal theme option');
  await waitUntilClosed('Terminal 配色');
  const persisted = await cdp.evaluate(`({ interfaceTheme: localStorage.getItem('jian.interface_theme'), terminalTheme: localStorage.getItem('jian.terminal_theme') })`);
  if (persisted.interfaceTheme !== 'light' || persisted.terminalTheme !== 'atom-one-dark') throw new Error(`themes did not persist independently: ${JSON.stringify(persisted)}`);

  await cdp.evaluate(`window.__jianThemeTestDocument = true`);
  await cdp.send('Page.reload');
  await waitFor(() => cdp.evaluate(`!window.__jianThemeTestDocument && !!document.querySelector('.context-actions') && document.documentElement.dataset.theme === 'light'`), 'persisted themes after reload');
  await assertOpen('界面主题');
  await assertOpen('Terminal 配色');
  await cdp.evaluate(`window.__migrationReload = true; localStorage.setItem('jian.terminal_theme', 'black'); location.reload()`);
  await waitFor(() => cdp.evaluate(`!window.__migrationReload && !!document.querySelector('.context-actions') && document.documentElement.dataset.theme === 'light' && localStorage.getItem('jian.terminal_theme') === 'console'`), 'legacy Terminal theme migration');
  await assertOpen('Terminal 配色', false);
  if (!await cdp.evaluate(`!!document.querySelector('.theme-menu[aria-label="Terminal 配色"] button[data-theme-preview="console"].selected')`)) throw new Error('legacy black Terminal theme was not migrated to console');
  console.log('PASS homepage theme popovers stay open and persist independently');

  await click('Terminal 配色');
  await waitUntilClosed('Terminal 配色');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await cdp.evaluate(`window.__desktopDocument = true; location.reload()`);
  await waitFor(() => cdp.evaluate(`!window.__desktopDocument && !!document.querySelector('.context-actions') && matchMedia('(pointer: coarse)').matches`), 'mobile workspace');
  await dismissUnavailableNotice();
  await click('打开导航');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.nav-drawer')`), 'mobile navigation');
  await clickSelector('nav.agent-rail button:first-child', 'mobile Local agent');
  await waitFor(() => cdp.evaluate(`document.querySelector('.catalog-header strong')?.textContent === 'Local Bash'`), 'mobile Local catalog');
  await click('新建会话');
  await waitFor(() => cdp.evaluate(`document.querySelector('.terminal-status-menu .status')?.textContent.trim() === '已连接'`), 'mobile terminal connection');
  if (await cdp.evaluate(`document.activeElement.classList.contains('terminal-input-buffer')`)) throw new Error('mobile terminal auto-focused its input on connect');
  await dismissUnavailableNotice();
  await cdp.evaluate(`(() => {
    const getRect = Element.prototype.getBoundingClientRect;
    const getStyle = window.getComputedStyle;
    window.__terminalGeometryReads = 0;
    window.__terminalFitReads = 0;
    Element.prototype.getBoundingClientRect = function(...args) {
      if (this.matches?.('.terminal-stage, .xterm-screen')) window.__terminalGeometryReads++;
      return getRect.apply(this, args);
    };
    window.getComputedStyle = function(element, ...args) {
      if (element.matches?.('.terminal, .xterm')) window.__terminalFitReads++;
      return getStyle.call(this, element, ...args);
    };
  })()`);
  const perfCommand = "for i in {1..1200}; do printf 'JIAN_PERF_%04d\\n' \"$i\"; done; printf 'JIAN_PERF_DONE\\n'\n";
  await cdp.evaluate(`new Promise((resolve, reject) => {
    const id = localStorage.getItem('jian.active_local_session');
    const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/local/sessions/' + encodeURIComponent(id) + '/terminal');
    const timer = setTimeout(() => reject(new Error('terminal performance output timed out')), 10000);
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.type === 'session.started') socket.send(JSON.stringify({ type: 'input', data: ${JSON.stringify(perfCommand)} }));
      if (message.type === 'pty.output' && message.payload.includes('JIAN_PERF_DONE')) { clearTimeout(timer); socket.close(); resolve(true); }
    };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('terminal performance websocket failed')); };
  })`);
  await new Promise(resolve => setTimeout(resolve, 250));
  const outputGeometryReads = await cdp.evaluate(`window.__terminalGeometryReads`);
  if (outputGeometryReads > 2) throw new Error(`terminal output caused excessive geometry reads: ${outputGeometryReads}`);
  console.log(`PASS mobile output coalesces terminal geometry reads (${outputGeometryReads})`);
  const fitReadsBeforeUnchangedResize = await cdp.evaluate(`window.__terminalFitReads`);
  await cdp.evaluate(`window.dispatchEvent(new Event('resize'))`);
  await new Promise(resolve => setTimeout(resolve, 100));
  const fitReadsAfterUnchangedResize = await cdp.evaluate(`window.__terminalFitReads`);
  if (fitReadsAfterUnchangedResize !== fitReadsBeforeUnchangedResize) throw new Error('unchanged viewport resize remeasured the terminal');
  await cdp.evaluate(`window.dispatchEvent(new CustomEvent('jian-terminal-font-size', { detail: 16 }))`);
  await new Promise(resolve => setTimeout(resolve, 100));
  if (await cdp.evaluate(`window.__terminalFitReads`) < fitReadsAfterUnchangedResize + 2) throw new Error('font-size change did not refit the terminal');
  console.log('PASS terminal fit skips unchanged resizes and updates for font-size changes');
  const tap = async selector => {
    await cdp.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await cdp.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node?.closest('.mobile-control-scroll')) node.scrollIntoView({ block: 'nearest', inline: 'nearest' }); })()`);
    const point = await cdp.evaluate(`(() => { const target = document.querySelector(${JSON.stringify(selector)}); const box = target.getBoundingClientRect(); const x = box.x + box.width / 2, y = box.y + box.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, hit: target === hit || target.contains(hit), actual: hit?.outerHTML.slice(0, 300), disabled: target.disabled }; })()`);
    if (!point.hit || point.disabled) throw new Error('button not actionable: ' + selector + '; ' + JSON.stringify(point));
    delete point.hit; delete point.actual; delete point.disabled;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise(resolve => setTimeout(resolve, 100));
  };
  const terminalScreen = async () => {
    const clip = await cdp.evaluate(`(() => { const { x, y, width, height } = document.querySelector('.terminal .xterm-screen').getBoundingClientRect(); return { x, y, width, height, scale: 1 }; })()`);
    return (await cdp.send('Page.captureScreenshot', { format: 'png', clip })).data;
  };
  const terminalPoint = await cdp.evaluate(`(() => { const box = document.querySelector('.terminal .xterm-screen').getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`);
  await cdp.evaluate(`document.querySelectorAll('.terminal .xterm-cursor-layer').forEach(element => { element.style.visibility = 'hidden'; })`);
  const outputBeforeSwipe = await terminalScreen();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [terminalPoint] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...terminalPoint, y: terminalPoint.y + 35 }] });
  await new Promise(resolve => setTimeout(resolve, 800));
  const outputAfterHoldDelay = await terminalScreen();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...terminalPoint, y: terminalPoint.y + 115 }] });
  await new Promise(resolve => setTimeout(resolve, 200));
  const outputAfterContinuedSwipe = await terminalScreen();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  if (outputAfterHoldDelay === outputBeforeSwipe || outputAfterContinuedSwipe === outputAfterHoldDelay) throw new Error('mobile terminal swipe stopped scrolling after the long-press delay');
  if (await cdp.evaluate(`document.activeElement.classList.contains('terminal-input-buffer')`)) throw new Error('ending a swipe opened terminal input');
  await cdp.evaluate(`document.activeElement.blur()`);
  await tap('.terminal .xterm-screen');
  if (await cdp.evaluate(`document.activeElement.classList.contains('terminal-input-buffer')`)) throw new Error('reading output opened mobile input');
  await tap('.mobile-workbench-dock button[aria-label="输入终端"]');
  await cdp.evaluate(`[...document.querySelectorAll('.mobile-input-modes button')].find(button => button.textContent === '实时终端').click()`);
  if (!await cdp.evaluate(`document.activeElement.classList.contains('terminal-input-buffer')`)) throw new Error('explicit input entry failed');
  await tap('.mobile-workbench-dock button[aria-label="收起输入"]');
  await cdp.evaluate(`document.activeElement.blur()`);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [terminalPoint] });
  await new Promise(resolve => setTimeout(resolve, 750));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  if (await cdp.evaluate(`document.activeElement.classList.contains('terminal-input-buffer')`)) throw new Error('a long press opened terminal input');

  const selectedText = await cdp.evaluate(`(() => {
    // WebGL renders terminal rows to canvas; use a real DOM selection to exercise the shared focus guard.
    const target = document.querySelector('.mobile-workbench-dock button:first-child');
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return !selection.isCollapsed;
  })()`);
  if (!selectedText) throw new Error('text selection fixture is unavailable');
  await tap('.terminal .xterm-screen');
  if (await cdp.evaluate(`document.activeElement.classList.contains('terminal-input-buffer')`)) throw new Error('tapping selected terminal text opened input');
  await cdp.evaluate(`window.getSelection()?.removeAllRanges()`);
  console.log('PASS mobile terminal keeps scrolling during a long swipe and requires explicit input entry');
  await cdp.evaluate(`(() => {
    document.activeElement.blur();
    window.__shortcutInputs = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) { const message = JSON.parse(data); if (message.type === 'input') window.__shortcutInputs.push(message.data); return send.call(this, data); };
  })()`);
  await tap('.mobile-workbench-dock button[aria-label="输入终端"]');
  await cdp.evaluate(`[...document.querySelectorAll('.mobile-input-modes button')].find(button => button.textContent === '实时终端').click()`);
  await tap('.mobile-control-scroll button:first-child');
  if (!await cdp.evaluate(`document.activeElement.classList.contains('terminal-input-buffer')`)) throw new Error('mobile shortcut lost input focus');
  if (!await cdp.evaluate(`window.__shortcutInputs.at(-1) === String.fromCharCode(27)`)) throw new Error('mobile shortcut did not send Escape');
  // Headless Chrome has no software keyboard: reproduce its visual viewport
  // resize and pan while retaining the actual terminal input focus.
  await cdp.evaluate(`(() => {
    document.querySelector('.terminal-input-buffer').focus();
    Object.defineProperties(visualViewport, { height: { configurable: true, value: 430 }, offsetTop: { configurable: true, value: 60 } });
    visualViewport.dispatchEvent(new Event('resize'));
    window.__shortcutInputs = [];
  })()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  await cdp.evaluate(`(() => {
    window.__terminalGeometryReads = 0;
    Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 75 });
    for (let i = 0; i < 8; i++) visualViewport.dispatchEvent(new Event('scroll'));
  })()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  const scrollState = await cdp.evaluate(`({ reads: window.__terminalGeometryReads, height: document.documentElement.style.getPropertyValue('--mobile-viewport-height'), offset: document.documentElement.style.getPropertyValue('--mobile-viewport-offset') })`);
  if (scrollState.reads !== 0 || scrollState.height !== '430px' || scrollState.offset !== '75px') throw new Error(`visual viewport scroll changed terminal layout or lost its offset: ${JSON.stringify(scrollState)}`);
  const geometry = await cdp.evaluate(`(() => { const box = document.querySelector('.mobile-control-bar').getBoundingClientRect(); return { top: box.top, bottom: box.bottom, viewportTop: visualViewport.offsetTop, viewportBottom: visualViewport.offsetTop + visualViewport.height }; })()`);
  if (geometry.top < geometry.viewportTop || geometry.bottom > geometry.viewportBottom + 1) throw new Error('mobile toolbar is behind keyboard: ' + JSON.stringify(geometry));
  await tap('.mobile-control-scroll button[aria-label="Shift"]');
  await tap('.mobile-control-scroll button[aria-label="方向键左"]');
  await tap('.mobile-control-scroll button[aria-label="方向键左"]');
  const shortcuts = await cdp.evaluate(`({ inputs: window.__shortcutInputs, focused: document.activeElement.classList.contains('terminal-input-buffer'), shifted: document.querySelector('button[aria-label="Shift"]').getAttribute('aria-pressed') })`);
  if (JSON.stringify(shortcuts.inputs) !== JSON.stringify(['\u001b[1;2D', '\u001b[1;2D']) || !shortcuts.focused || shortcuts.shifted !== 'true') throw new Error('mobile Shift shortcuts or focus failed: ' + JSON.stringify(shortcuts));
  await tap('.mobile-control-scroll button[aria-label="Shift"]');
  await tap('.mobile-control-scroll button[aria-label="方向键左"]');
  if (!await cdp.evaluate(`window.__shortcutInputs.at(-1) === String.fromCharCode(27) + '[D'`)) throw new Error('mobile Shift did not toggle off');
  await cdp.evaluate(`(() => {
    document.activeElement.blur();
    delete visualViewport.height;
    delete visualViewport.offsetTop;
    visualViewport.dispatchEvent(new Event('resize'));
    visualViewport.dispatchEvent(new Event('scroll'));
  })()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  await tap('.mobile-workbench-dock button[aria-label="收起输入"]');
  if (await cdp.evaluate(`document.activeElement.matches('textarea, input')`)) throw new Error('input remained focused after dismissal');
  console.log('PASS mobile toolbar preserves focus, stays above keyboard viewport, and sends Shift+Left');

  const mouseClick = async selector => {
    await cdp.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })`);
    await cdp.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const point = await cdp.evaluate(`(() => { const target = document.querySelector(${JSON.stringify(selector)}); const box = target.getBoundingClientRect(); const x = box.x + box.width / 2, y = box.y + box.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, hit: target === hit || target.contains(hit), actual: hit?.outerHTML.slice(0, 300), disabled: target.disabled }; })()`);
    if (!point.hit || point.disabled) throw new Error('button not actionable: ' + selector + '; ' + JSON.stringify(point));
    delete point.hit; delete point.actual; delete point.disabled;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const keyPress = async key => {
    const virtualKey = { Enter: 13, Tab: 9, Escape: 27, ArrowLeft: 37 }[key];
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, text: key === 'Enter' ? '\r' : undefined, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey });
  };
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 801, height: 844, deviceScaleFactor: 1, mobile: false });
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.sidebar') && !document.querySelector('.nav-drawer')`), 'desktop sidebar after breakpoint');
  for (let i = 0; i < 13; i++) {
    const count = await cdp.evaluate(`document.querySelectorAll('.session-tabs [role="tab"]').length`);
    await mouseClick('button[aria-label="新建会话"]');
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.session-tabs [role="tab"]').length === ${count + 1} && document.querySelector('.terminal-status-menu .status')?.textContent.trim() === '已连接'`), 'additional tab');
  }
  const activeKey = await cdp.evaluate(`document.querySelector('.session-tabs [data-state="active"] [data-tab-key]').dataset.tabKey`);
  if (!await cdp.evaluate(`(() => { const list = document.querySelector('.session-tabs-list').getBoundingClientRect(); const tab = document.querySelector('.session-tabs [data-state="active"]').parentElement.getBoundingClientRect(); return tab.left >= list.left - 1 && tab.right <= list.right + 1; })()`)) throw new Error('active tab is outside the horizontal viewport');
  const socketCount = await cdp.evaluate(`window.__terminalSockets.length`);
  await cdp.evaluate(`document.querySelector('.session-tabs [data-state="active"]').focus()`);
  await keyPress('ArrowLeft');
  if (!await cdp.evaluate(`document.querySelector('.session-tabs [data-state="active"] [data-tab-key]').dataset.tabKey === ${JSON.stringify(activeKey)} && window.__terminalSockets.length === ${socketCount}`)) throw new Error('arrow navigation activated a terminal');
  const closeable = await cdp.evaluate(`document.querySelector('.session-tab-close').tabIndex >= 0 && !document.querySelector('[role="tab"] .session-tab-close')`);
  if (!closeable) throw new Error('close controls are not independent keyboard-accessible buttons');
  await mouseClick('button[aria-label="设置"]');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.settings-page')`), 'independent settings');
  if (!await cdp.evaluate(`!document.querySelector('.context-bar') && !document.querySelector('.session-tabs')`)) throw new Error('settings retained terminal context or tabs');
  await mouseClick('button[aria-label="返回工作台"]');
  await waitFor(() => cdp.evaluate(`document.querySelector('.session-tabs [data-state="active"] [data-tab-key]')?.dataset.tabKey === ${JSON.stringify(activeKey)}`), 'previous terminal restored');
  const dragKey = await cdp.evaluate(`document.querySelector('.session-tab:last-child [data-tab-key]').dataset.tabKey`);
  const neighborKey = await cdp.evaluate(`document.querySelector('.session-tab:nth-last-child(2) [data-tab-key]').dataset.tabKey`);
  await mouseClick('.session-tab:last-child .session-tab-trigger');
  const target = await cdp.evaluate(`(() => { const box = document.querySelector('.session-tab:nth-last-child(2)').getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`);
  const dragData = { items: [{ mimeType: 'text/plain', data: dragKey }], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, data: dragData, ...target });
  await waitFor(() => cdp.evaluate(`document.querySelector('.session-tab:nth-last-child(2) [data-tab-key]').dataset.tabKey === ${JSON.stringify(dragKey)}`), 'session reorder');
  await mouseClick('.session-tab:nth-last-child(2) .session-tab-close');
  await waitFor(() => cdp.evaluate(`document.querySelector('.session-tabs [data-state="active"] [data-tab-key]')?.dataset.tabKey !== ${JSON.stringify(dragKey)}`), 'adjacent close');
  await waitFor(() => cdp.evaluate(`document.querySelector('.terminal-status-menu .status')?.textContent.trim() === '已连接'`), 'neighbor terminal ready');
  const selectedBeforeClose = await cdp.evaluate(`document.querySelector('.session-tabs [data-state="active"] [data-tab-key]').dataset.tabKey`);
  const inactiveClosedID = await cdp.evaluate(`document.querySelectorAll('.session-tab')[2].querySelector('[data-tab-key]').dataset.tabKey.replace('local:', '')`);
  const countBeforeKeyboardClose = await cdp.evaluate(`document.querySelectorAll('.session-tab-close').length`);
  await cdp.evaluate(`document.querySelectorAll('.session-tab-close')[2].focus()`);
  await keyPress('Enter');
  await waitFor(() => cdp.evaluate(`document.querySelectorAll('.session-tab-close').length === ${countBeforeKeyboardClose - 1}`), 'keyboard close');
  if (!await cdp.evaluate(`document.querySelector('.session-tabs [data-state="active"] [data-tab-key]').dataset.tabKey === ${JSON.stringify(selectedBeforeClose)}`)) throw new Error('closing inactive tab changed selection');
  if (!await cdp.evaluate(`localStorage.getItem('jian.active_local_session') === ${JSON.stringify(selectedBeforeClose.replace('local:', ''))}`)) throw new Error('closing inactive tab cleared the current restore key');
  await cdp.evaluate(`new Promise((resolve, reject) => {
    const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/local/sessions/' + encodeURIComponent(${JSON.stringify(inactiveClosedID)}) + '/terminal');
    const timer = setTimeout(() => { socket.close(); reject(new Error('closed tab lost its process')); }, 5000);
    socket.onmessage = event => { if (JSON.parse(event.data).type === 'session.started') { clearTimeout(timer); socket.close(); resolve(true); } };
    socket.onerror = () => { clearTimeout(timer); socket.close(); reject(new Error('closed tab process unavailable')); };
  })`);
  console.log('PASS desktop tab keyboard navigation, session drag, adjacent close, and inactive close');

  await cdp.evaluate(`document.querySelector('.session-tabs-list').scrollLeft = document.querySelector('.session-tabs-list').scrollWidth`);
  await mouseClick('.session-tab:last-child .session-tab-trigger');
  await waitFor(() => cdp.evaluate(`document.querySelector('.terminal-status-menu .status')?.textContent.trim() === '已连接'`), 'last terminal tab');
  for (const width of [1440, 800, 430, 390, 360, 320, 844]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width === 844 ? 390 : 844, deviceScaleFactor: 1, mobile: width <= 800 });
    await waitFor(() => cdp.evaluate(`!!document.querySelector('.sidebar') === ${width > 800}`), 'responsive navigation');
    if (!await cdp.evaluate(`document.querySelector('.workspace-view').getBoundingClientRect().right <= innerWidth + 1`)) throw new Error('workspace overflow at ' + width);
    if (width > 800) await waitFor(() => cdp.evaluate(`(() => { const list = document.querySelector('.session-tabs-list').getBoundingClientRect(); const tab = document.querySelector('.session-tabs [data-state="active"]').parentElement.getBoundingClientRect(); return tab.left >= list.left - 1 && tab.right <= list.right + 1; })()`), 'active tab visible at ' + width);
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await waitFor(() => cdp.evaluate(`!document.querySelector('.sidebar')`), 'closed mobile drawer');
  const mobileMore = async label => {
    if (label === '文本编辑') { await tap('.mobile-workbench-dock button[aria-label="输入终端"]'); return; }
    await tap('.mobile-workbench-dock button[aria-label="更多工作台操作"]');
    await waitFor(() => cdp.evaluate(`!!document.querySelector('.mobile-workbench-sheet')`), 'mobile menu');
    const group = ['会话目录与管理', '新建会话', '重新连接', '关闭当前会话显示', '重启当前会话', '释放当前会话'].includes(label) ? '会话管理' : ['选择输出文本', '搜索终端输出', '粘贴到终端'].includes(label) ? '输出' : '工作台';
    await mouseClick('.mobile-tool-groups [role="tab"]:nth-child(' + (group === '输出' ? 1 : group === '会话管理' ? 2 : 3) + ')');
    await cdp.evaluate(`[...document.querySelectorAll('.mobile-workbench-sheet button')].find(button => button.textContent === ${JSON.stringify(label)}).click()`);
  };
  const openMobileNavigation = () => mobileMore('会话目录与管理');
  const beforeDrawer = await cdp.evaluate(`({ count: window.__terminalSockets.length, width: document.querySelector('.terminal-stage').getBoundingClientRect().width })`);
  await openMobileNavigation();
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.nav-drawer') && document.activeElement.getAttribute('aria-label') === '关闭导航'`), 'drawer close-button focus');
  await keyPress('Tab');
  if (!await cdp.evaluate(`!!document.activeElement.closest('.nav-drawer') && !document.activeElement.matches('input, textarea')`)) throw new Error('drawer did not contain keyboard focus');
  await cdp.evaluate(`document.querySelector('.catalog-list').scrollTop = 220; document.querySelector('.catalog-list').dispatchEvent(new Event('scroll', { bubbles: true }))`);
  await new Promise(resolve => setTimeout(resolve, 100));
  const savedScroll = await cdp.evaluate(`document.querySelector('.catalog-list').scrollTop`);
  if (savedScroll <= 0) throw new Error('catalog did not scroll');
  await keyPress('Escape');
  await waitFor(() => cdp.evaluate(`!document.querySelector('.nav-drawer') && document.activeElement.getAttribute('aria-label') === '更多工作台操作'`), 'drawer focus restore');
  await openMobileNavigation();
  try {await waitFor(() => cdp.evaluate(`Math.abs(document.querySelector('.catalog-list').scrollTop - ${savedScroll}) <= 1`), 'catalog scroll restore'); } catch (error) { throw new Error(error.message + '; ' + JSON.stringify(await cdp.evaluate(`({ saved: ${savedScroll}, actual: document.querySelector('.catalog-list')?.scrollTop, storage: Object.fromEntries(Object.keys(localStorage).filter(key => key.includes('scroll')).map(key => [key,localStorage.getItem(key)])), drawer: !!document.querySelector('.nav-drawer'), focused: document.activeElement.outerHTML })`))); }
  await tap('button[aria-label="关闭导航"]');
  const afterDrawer = await cdp.evaluate(`({ count: window.__terminalSockets.length, width: document.querySelector('.terminal-stage').getBoundingClientRect().width })`);
  if (JSON.stringify(beforeDrawer) !== JSON.stringify(afterDrawer)) throw new Error('drawer changed terminal connection or width');
  const hitSize = await cdp.evaluate(`(() => { const box = document.querySelector('.mobile-workbench-dock button').getBoundingClientRect(); return { width: box.width, height: box.height }; })()`);
  if (hitSize.width < 44 || hitSize.height < 44) throw new Error('mobile close hit target is too small');
  await openMobileNavigation();
  await tap('button[aria-label="local 设置"]');
  await waitFor(() => cdp.evaluate(`!document.querySelector('.nav-drawer') && !!document.querySelector('.settings-page') && document.activeElement.getAttribute('aria-label') === '返回工作台'`), 'drawer handoff to independent settings');
  await screenshot('mobile-settings');
  if (!await cdp.evaluate(`(() => { const nav = document.querySelector('button[aria-label="打开导航"]').getBoundingClientRect(); const back = document.querySelector('.settings-back').getBoundingClientRect(); return back.left >= nav.right; })()`)) throw new Error('mobile navigation overlaps settings back button');
  const settingsTop = await cdp.evaluate(`document.querySelector('.settings-content').getBoundingClientRect().top`);
  if (settingsTop > 220) throw new Error('mobile settings chrome uses too much space: ' + settingsTop);
  await tap('button[aria-label="返回工作台"]');
  await waitFor(() => cdp.evaluate(`!document.querySelector('.settings-page') && !!document.querySelector('.terminal')`), 'return to workspace');
  console.log('PASS mobile drawer focus, scroll restore, breakpoint layout, touch targets, and unchanged terminal connection');

  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await screenshot('desktop-workbench');
  const operationCount = await cdp.evaluate(`window.__rpcRequests.filter(r => /release/.test(r.path) && r.method === 'POST').length`);
  await cdp.evaluate(`window.__rpcRules.push({ method: 'POST', prefix: '/settings/terminals/', error: '测试释放失败' })`);
  await mouseClick('.terminal-status-menu > button, .terminal-status-menu button.status');
  await cdp.evaluate(`[...document.querySelectorAll('.status-menu button')].find(b => b.textContent.includes('释放会话')).click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('[aria-describedby="error-dialog-description"]')?.textContent.includes('测试释放失败')`), 'direct release error');
  if (await cdp.evaluate(`!!document.querySelector('[aria-describedby="confirm-dialog-description"]') || window.__rpcRequests.filter(r => /release/.test(r.path) && r.method === 'POST').length !== ${operationCount + 1}`)) throw new Error('release requested confirmation or submitted more than once');
  await cdp.evaluate(`document.querySelector('[aria-describedby="error-dialog-description"] button').click()`);
  await cdp.evaluate(`window.__rpcRules.push({ method: 'POST', prefix: '/settings/terminals/', error: '测试标签释放失败' })`);
  await mouseClick('.session-tab-menu');
  if (!await cdp.evaluate(`[...document.querySelectorAll('.session-actions [role="menuitem"]')].some(item => item.textContent === '关闭')`)) throw new Error('tab close label missing');
  await cdp.evaluate(`[...document.querySelectorAll('.session-actions [role="menuitem"]')].find(item => item.textContent === '释放').click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('[aria-describedby="error-dialog-description"]')?.textContent.includes('测试标签释放失败')`), 'tab direct release');
  if (await cdp.evaluate(`!!document.querySelector('[aria-describedby="confirm-dialog-description"]')`)) throw new Error('tab release requested confirmation');
  await cdp.evaluate(`document.querySelector('[aria-describedby="error-dialog-description"] button').click()`);
  await mouseClick('.terminal-status-menu button.status');
  await cdp.evaluate(`[...document.querySelectorAll('.status-menu button')].find(b => b.textContent.includes('重启会话')).click()`);
  await waitFor(() => cdp.evaluate(`!!document.querySelector('[aria-describedby="confirm-dialog-description"]')`), 'restart confirmation');
  await cdp.evaluate(`[...document.querySelectorAll('[aria-describedby="confirm-dialog-description"] footer button')].find(b => b.textContent === '确认重启').click()`);
  await waitFor(() => cdp.evaluate(`!document.querySelector('[aria-describedby="confirm-dialog-description"]') && document.querySelector('.terminal-status-menu .status')?.textContent.trim() === '已连接'`), 'confirmed restart reconnects');
  if (await cdp.evaluate(`window.__rpcRequests.filter(r => /restart/.test(r.path) && r.method === 'POST').length`) !== 1) throw new Error('restart did not send exactly one operation');
  console.log('PASS direct status/tab release, failure retention, and confirmed restart');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const sharedID = await cdp.evaluate(`localStorage.getItem('jian.active_local_session')`);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  try {
    const targetPage = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json()).find(item => item.id === targetId), 'second browser page');
    const desktop = new CDP(targetPage.webSocketDebuggerUrl);
    await desktop.open();
    await desktop.send('Page.enable');
    await desktop.send('Runtime.enable');
    await desktop.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await desktop.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitFor(() => desktop.evaluate(`!!document.querySelector('.session-list .session-row')`), 'second page local catalog');
    await desktop.evaluate(`window.dispatchEvent(new CustomEvent('jian-enter-terminal', { detail: { id: ${JSON.stringify(sharedID)} } }))`);
    await waitFor(() => desktop.evaluate(`document.querySelector('.terminal-status-menu .status')?.textContent.trim() === '已连接'`), 'second page shared terminal');
    await desktop.send('Page.bringToFront');
    await desktop.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const desktopWidth = await desktop.evaluate(`document.querySelector('.xterm-screen').getBoundingClientRect().width`);
    await cdp.send('Page.bringToFront');
    await cdp.evaluate(`(() => {
      window.__ownResize = null;
      const original = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        try { const message = JSON.parse(data); if (this.url.includes('/terminal') && message.type === 'resize') window.__ownResize = message; } catch {}
        return original.call(this, data);
      };
    })()`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: true });
    await waitFor(() => cdp.evaluate(`!!window.__ownResize`), 'mobile own terminal resize');
    await cdp.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const mobileWidth = await cdp.evaluate(`document.querySelector('.xterm-screen').getBoundingClientRect().width`);
    if (await desktop.evaluate(`document.querySelector('.xterm-screen').getBoundingClientRect().width`) !== desktopWidth || desktopWidth <= mobileWidth || mobileWidth > 360) throw new Error('mobile attach/resize changed desktop terminal width');
    await desktop.send('Page.bringToFront');
    await desktop.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor(() => desktop.evaluate(`document.querySelector('.xterm-screen').getBoundingClientRect().width !== ${desktopWidth}`), 'desktop own terminal resize');
    await desktop.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const afterDesktopResize = await cdp.evaluate(`({ width: document.querySelector('.xterm-screen').getBoundingClientRect().width, container: document.querySelector('.terminal-stage').getBoundingClientRect().width, viewport: innerWidth, font: localStorage.getItem('jian.terminal_font_size'), style: document.querySelector('.xterm-screen').style.width })`);
    if (afterDesktopResize.width !== mobileWidth) throw new Error('desktop resize changed mobile terminal width: ' + JSON.stringify({ before: mobileWidth, after: afterDesktopResize }));
    console.log('PASS simultaneous desktop/mobile displays retain independent terminal widths');
  } finally {
    await cdp.send('Target.closeTarget', { targetId });
    await cdp.send('Page.bringToFront');
  }

  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const input = async (selector, value) => cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('input missing: ' + ${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const rule = value => cdp.evaluate(`window.__rpcRules.push(${JSON.stringify(value)})`);
  const releaseRPC = async label => {
    const id = await cdp.evaluate(`window.__heldRPC.find(item => item.label === ${JSON.stringify(label)}).id`);
    await cdp.evaluate(`window.__releaseRPC(${JSON.stringify(label)})`);
    await waitFor(() => cdp.evaluate(`window.__rpcResponses.includes(${id})`), label + ' response');
  };
  const roster = kind => `.agent-roster-item:has([aria-label="${kind}设置，展开或收起详细配置"])`;
  const pushed = await cdp.evaluate(`window.__rpcCall('/local/sessions', 'POST', {})`);
  await waitFor(() => cdp.evaluate(`(JSON.parse(localStorage.getItem('jian.session_cache.theme-test.local') || '[]')).some(row => row.id === ${JSON.stringify(pushed.id)})`), 'server catalog push updates shared cache');
  await cdp.evaluate(`window.__rpcCall('/local/sessions/' + ${JSON.stringify(pushed.id)}, 'DELETE')`);
  await waitFor(() => cdp.evaluate(`!(JSON.parse(localStorage.getItem('jian.session_cache.theme-test.local') || '[]')).some(row => row.id === ${JSON.stringify(pushed.id)})`), 'server deletion push removes cached row');
  const catalogAccess = await cdp.evaluate(`Promise.all([fetch('/api/sessions/catalog', { credentials: 'omit' }).then(r => r.status), fetch('/api/sessions/catalog?areas=invalid').then(r => r.status)])`);
  if (catalogAccess[0] !== 401 || catalogAccess[1] !== 400) throw new Error('catalog authentication or area validation failed: ' + JSON.stringify(catalogAccess));
  console.log('PASS real catalog push synchronizes creation/deletion and snapshot access stays authenticated');
  const cachedFixture = (kind, profile) => ({ id: 'same-native-id', kind, profile, title: 'Build service', workspace: '/work/team', status: 'idle' });
  const fixtureCatalog = await cdp.evaluate(`window.__rpcCall('/sessions/catalog')`);
  fixtureCatalog.areas.codex.error = '测试缓存读取失败';
  fixtureCatalog.areas.hermes.rows = [cachedFixture('hermes', 'ops')];
  fixtureCatalog.areas.hermes.error = null;
  fixtureCatalog.areas.pi.rows = [cachedFixture('pi', 'ops'), cachedFixture('pi', 'research')];
  fixtureCatalog.areas.pi.error = null;
  for (const slice of Object.values(fixtureCatalog.areas)) slice.revision += 100;
  await rule({ method: 'GET', prefix: '/sessions/catalog', body: fixtureCatalog });
  await cdp.evaluate(`window.__apiSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'sessions.catalog.resync' }) }))`);
  await waitFor(() => cdp.evaluate(`!window.__rpcRules.length`), 'shared catalog fixture loaded');
  const beforeSwitcherSockets = await cdp.evaluate(`window.__terminalSockets.length`);
  await mouseClick('.session-tabs .session-switcher-trigger');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.switcher-error') && !document.querySelector('.switcher-feedback')?.textContent.includes('正在') && document.activeElement.getAttribute('aria-label') === '搜索全部会话'`), 'switcher partial results and desktop focus');
  await input('.switcher-search input', 'PI TEAM');
  await waitFor(() => cdp.evaluate(`document.querySelectorAll('.switcher-result').length === 2`), 'same ID Pi roles remain distinct');
  await input('.switcher-search input', 'PI ops TEAM');
  if (!await cdp.evaluate(`document.querySelectorAll('.switcher-result').length === 1 && document.querySelector('.switcher-result').textContent.includes('ops')`)) throw new Error('switcher role search failed');
  fixtureCatalog.areas.codex.error = null; fixtureCatalog.areas.codex.revision++;
  await rule({ method: 'POST', path: '/agents/codex/sessions/refresh', body: [] });
  await rule({ method: 'GET', prefix: '/sessions/catalog', body: fixtureCatalog });
  await mouseClick('.switcher-error button');
  await waitFor(() => cdp.evaluate(`!document.querySelector('.switcher-error')`), 'partial cache retry');
  await input('.switcher-search input', 'no-such-session');
  if (!await cdp.evaluate(`!!document.querySelector('.switcher-empty') && !document.querySelector('.switcher-result')`)) throw new Error('switcher missing empty state');
  await input('.switcher-search input', '');
  await mouseClick('.switcher-scope button:last-child');
  if (!await cdp.evaluate(`[...document.querySelectorAll('.switcher-result')].every(row => row.textContent.includes('当前') || row.textContent.includes('已打开')) && window.__terminalSockets.length === ${beforeSwitcherSockets}`)) throw new Error('opened filter created a terminal connection');
  await keyPress('Escape');
  await waitFor(() => cdp.evaluate(`!document.querySelector('.session-switcher') && document.activeElement.matches('.session-tabs .session-switcher-trigger')`), 'switcher focus restore');
  await mouseClick('.session-tabs .session-switcher-trigger');
  await input('.switcher-search input', sharedID);
  await keyPress('Enter');
  await waitFor(() => cdp.evaluate(`!document.querySelector('.session-switcher') && localStorage.getItem('jian.active_local_session') === ${JSON.stringify(sharedID)}`), 'switcher Enter activates local session');
  if (await cdp.evaluate(`window.__rpcRequests.filter(request => request.method === 'POST' && request.path.endsWith('/sessions/refresh')).length !== 1`)) throw new Error('switcher triggered native discovery');
  console.log('PASS unified switcher preserves role identity, partial results, keyboard focus and cached discovery');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.focus-mode-trigger') && document.querySelector('.terminal-status-menu .status')?.textContent.trim() === '已连接'`), 'mobile focus entry');
  await cdp.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.workspace-view').getBoundingClientRect().height <= 845 && document.body.style.pointerEvents !== 'none'`), 'mobile layout settled');
  const normalHeight = await cdp.evaluate(`(() => { window.__focusTerminal = document.querySelector('.terminal'); window.__focusSocketCount = window.__terminalSockets.length; return document.querySelector('.terminal-stage').getBoundingClientRect().height; })()`);
  await mobileMore('进入专注模式');
  try { await waitFor(() => cdp.evaluate(`!!document.querySelector('.workbench-focused') && document.querySelector('.terminal-stage').getBoundingClientRect().height >= ${normalHeight + 44}`), 'focus mode adds terminal space'); }
  catch (error) { throw new Error(error.message + '; ' + JSON.stringify(await cdp.evaluate(`({normalHeight:${normalHeight}, focused:!!document.querySelector('.workbench-focused'), height:document.querySelector('.terminal-stage').getBoundingClientRect().height, focusBar:document.querySelector('.focus-bar').getBoundingClientRect().height, context:document.querySelector('.context-bar').getBoundingClientRect().height, tabs:getComputedStyle(document.querySelector('.session-tabs')).display})`))); }
  if (!await cdp.evaluate(`document.querySelector('.terminal') === window.__focusTerminal && window.__terminalSockets.length === window.__focusSocketCount && getComputedStyle(document.querySelector('.session-tabs')).display === 'none'`)) throw new Error('focus mode changed terminal mount or socket');
  await screenshot('focus-mode');
  await tap('.mobile-workbench-dock button[aria-label="切换会话"]');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.session-switcher') && document.activeElement.getAttribute('aria-label') === '关闭会话切换器'`), 'mobile switcher avoids keyboard autofocus');
  await cdp.evaluate(`(() => { Object.defineProperties(visualViewport, { height: { configurable: true, value: 380 }, offsetTop: { configurable: true, value: 50 } }); visualViewport.dispatchEvent(new Event('resize')); })()`);
  await waitFor(() => cdp.evaluate(`(() => { const box = document.querySelector('.session-switcher').getBoundingClientRect(); return box.top >= 50 && box.bottom <= 430; })()`), 'switcher fits keyboard viewport');
  if (!await cdp.evaluate(`document.querySelector('.switcher-results').getBoundingClientRect().height >= 60`)) throw new Error('mobile keyboard viewport hides session results: ' + JSON.stringify(await cdp.evaluate(`[...document.querySelector('.session-switcher').children].map(node => ({ className: node.className, height: node.getBoundingClientRect().height, text: node.textContent.slice(0, 60) }))`)));
  await screenshot('switcher-mobile');
  await keyPress('Escape');
  await cdp.evaluate(`(() => { delete visualViewport.height; delete visualViewport.offsetTop; visualViewport.dispatchEvent(new Event('resize')); })()`);
  await waitFor(() => cdp.evaluate(`!document.querySelector('.session-switcher') && document.body.style.pointerEvents !== 'none'`), 'mobile switcher cleanup');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  if (!await cdp.evaluate(`!!document.querySelector('.workbench-focused')`)) throw new Error('phone rotation left focus mode');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await mobileMore('设置');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.settings-page')`), 'focus settings entry');
  await tap('button[aria-label="返回工作台"]');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.workbench-focused') && !!document.querySelector('.terminal')`), 'settings returns to focus mode');
  await mobileMore('退出专注模式');
  await waitFor(() => cdp.evaluate(`!document.querySelector('.workbench-focused')`), 'explicit focus exit');

  await mobileMore('文本编辑');
  await waitFor(() => cdp.evaluate(`document.activeElement.getAttribute('aria-label') === '编辑终端文本'`), 'native composer focus');
  const editDraft = text => cdp.evaluate(`(() => {
    const node = document.querySelector('#mobile-terminal-editor');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, ${JSON.stringify(text)});
    node.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await editDraft('移动草稿\n第二行');
  await keyPress('Enter');
  if (!await cdp.evaluate(`document.querySelector('#mobile-terminal-editor').value.includes('\\n')`)) throw new Error('composer Enter did not retain a multiline draft');
  await tap('.mobile-workbench-dock button[aria-label="收起输入"]');
  await mobileMore('文本编辑');
  if (!await cdp.evaluate(`document.querySelector('#mobile-terminal-editor').value.includes('移动草稿') && Object.keys(sessionStorage).some(key => key.startsWith('jian.terminal-draft.'))`)) throw new Error('composer draft did not persist');
  await editDraft('printf mobile-compose');
  await cdp.evaluate(`window.__shortcutInputs = []`);
  await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('.mobile-composer button')].find(b => b.textContent === '发送文本'); b.click(); b.click(); })()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('#mobile-terminal-editor').value === ''`), 'submitted draft cleared');
  if (!await cdp.evaluate(`window.__shortcutInputs.length === 1 && window.__shortcutInputs[0].replaceAll(String.fromCharCode(27) + '[200~', '').replaceAll(String.fromCharCode(27) + '[201~', '') === 'printf mobile-compose'`)) throw new Error('paste-only submit duplicated or added Enter: ' + JSON.stringify(await cdp.evaluate(`window.__shortcutInputs`)));
  await clickSelector('.mobile-composer-actions button:first-child', 'restore last submission');
  await cdp.evaluate(`window.__shortcutInputs = []`);
  await cdp.evaluate(`[...document.querySelectorAll('.mobile-composer button')].find(b => b.textContent === '发送并回车').click()`);
  if (!await cdp.evaluate(`window.__shortcutInputs.length === 2 && window.__shortcutInputs[0].replaceAll(String.fromCharCode(27) + '[200~', '').replaceAll(String.fromCharCode(27) + '[201~', '') === 'printf mobile-compose' && window.__shortcutInputs[1] === '\\r'`)) throw new Error('composer did not send exactly one Enter');
  await editDraft('离线保留');
  await cdp.evaluate(`Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline'))`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.mobile-workbench-header .status').textContent.includes('离线')`), 'offline state');
  if (!await cdp.evaluate(`document.querySelector('#mobile-terminal-editor').value === '离线保留' && [...document.querySelectorAll('.mobile-composer button')].find(b => b.textContent === '发送文本').disabled`)) throw new Error('offline composer lost draft or allowed submission');
  await cdp.evaluate(`delete navigator.onLine; window.dispatchEvent(new Event('online'))`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.mobile-workbench-header .status').textContent.includes('已连接')`), 'online reconnect');
  if (!await cdp.evaluate(`document.querySelector('#mobile-terminal-editor').value === '离线保留'`)) throw new Error('reconnect replayed draft automatically');
  await tap('.mobile-workbench-dock button[aria-label="收起输入"]');
  await mobileMore('选择输出文本');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.terminal-copy-dialog textarea')`), 'selectable output snapshot');
  const frozen = await cdp.evaluate(`document.querySelector('.terminal-copy-dialog textarea').value`);
  if (!frozen) throw new Error('output snapshot empty');
  await keyPress('Escape');
  console.log('PASS mobile composer multiline drafts, one-shot paste, explicit Enter, offline recovery and output snapshot');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  console.log('PASS mobile focus preserves terminal identity, keyboard viewport and settings return');

  await mouseClick('button[aria-label="设置"]');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.agent-toggle-list')`), 'settings form');
  for (const kind of ['Codex', 'Hermes', 'Pi']) await mouseClick(`${roster(kind)} .agent-roster-trigger`);
  await mouseClick(`${roster('Codex')} button[aria-label="添加启动参数"]`);
  await input(`${roster('Codex')} input[aria-label="启动参数 1"]`, ' --model ');
  await mouseClick(`${roster('Hermes')} button[aria-label="添加启动参数"]`);
  await input(`${roster('Hermes')} input[aria-label="启动参数 1"]`, 'hermes-draft');
  await mouseClick(`${roster('Pi')} button[aria-label="添加角色"]`);
  await rule({ method: 'PUT', path: '/settings', hold: true, label: 'save-codex' });
  await cdp.evaluate(`(() => { const form = document.querySelector(${JSON.stringify(roster('Codex'))} + ' form'); form.requestSubmit(); form.requestSubmit(); })()`);
  await waitFor(() => cdp.evaluate(`window.__heldRPC.some(item => item.label === 'save-codex')`), 'delayed Codex save');
  const locked = await cdp.evaluate(`(() => {
    const request = window.__heldRPC.find(item => item.label === 'save-codex');
    return { count: window.__rpcRequests.filter(item => item.method === 'PUT' && item.path === '/settings').length, own: request.body.codex_args, other: request.body.hermes_args, roles: request.body.pi_roles, formLocked: document.querySelector(${JSON.stringify(roster('Codex'))} + ' fieldset').disabled, tabLocked: document.querySelector('[aria-label="返回工作台"]').disabled, navLocked: document.querySelector('.agent-rail').inert, logoutAvailable: !document.querySelector('[aria-label="退出登录"]').disabled };
  })()`);
  if (locked.count !== 1 || JSON.stringify(locked.own) !== JSON.stringify([' --model ']) || locked.other.length || locked.roles.length || !locked.formLocked || !locked.tabLocked || !locked.navLocked || !locked.logoutAvailable) throw new Error('scoped save/lock failed: ' + JSON.stringify(locked));
  await cdp.evaluate(`window.dispatchEvent(new CustomEvent('jian-enter-terminal', { detail: { id: ${JSON.stringify(sharedID)} } }))`);
  if (!await cdp.evaluate(`!!document.querySelector('.settings-page')`)) throw new Error('pending save allowed leaving settings');
  await releaseRPC('save-codex');
  await waitFor(() => cdp.evaluate(`document.querySelector('.settings-save-status')?.textContent.includes('已保存') && !document.querySelector('[aria-label="返回工作台"]').disabled`), 'save success and unlock');
  if (!await cdp.evaluate(`document.querySelector(${JSON.stringify(roster('Codex'))} + ' input[aria-label="启动参数 1"]').value === '--model' && document.querySelector(${JSON.stringify(roster('Hermes'))} + ' input[aria-label="启动参数 1"]').value === 'hermes-draft' && !!document.querySelector(${JSON.stringify(roster('Pi'))} + ' input[placeholder="角色名称"]')`)) throw new Error('save response replaced unsaved drafts');
  await rule({ method: 'PUT', path: '/settings', hold: true, label: 'toggle-hermes' });
  await mouseClick('button[aria-label="启用 Hermes"]');
  await waitFor(() => cdp.evaluate(`window.__heldRPC.some(item => item.label === 'toggle-hermes')`), 'toggle save');
  if (!await cdp.evaluate(`window.__heldRPC.find(item => item.label === 'toggle-hermes').body.hermes_args.length === 0`)) throw new Error('toggle submitted edited launch arguments');
  await releaseRPC('toggle-hermes');
  await waitFor(() => cdp.evaluate(`document.querySelector('[aria-label="启用 Hermes"]').getAttribute('aria-checked') === 'false' && !Array.from(document.querySelectorAll('.agent-rail button span')).some(span => span.textContent === 'Hermes')`), 'disabled Hermes');
  await mouseClick('button[aria-label="启用 Hermes"]');
  await waitFor(() => cdp.evaluate(`document.querySelector('[aria-label="启用 Hermes"]').getAttribute('aria-checked') === 'true' && !document.querySelector('[aria-label="返回工作台"]').disabled`), 'Hermes restored');
  await rule({ method: 'PUT', path: '/settings', error: '测试保存失败' });
  await mouseClick(`${roster('Hermes')} button[type="submit"]`);
  try { await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('.general-settings-content [role="alert"]')].some(node => node.textContent.includes('测试保存失败')) && !document.querySelector('[aria-label="返回工作台"]').disabled`), 'save failure and unlock'); } catch (error) { throw new Error(error.message + '; ' + JSON.stringify(await cdp.evaluate(`({ text: document.querySelector('.general-settings-content')?.textContent, rules: window.__rpcRules, requests: window.__rpcRequests.slice(-6) })`))); }
  if (!await cdp.evaluate(`document.querySelector(${JSON.stringify(roster('Hermes'))} + ' input[aria-label="启动参数 1"]').value === 'hermes-draft'`)) throw new Error('save failure erased input');
  await mouseClick(`${roster('Hermes')} button[type="submit"]`);
  await waitFor(() => cdp.evaluate(`document.querySelector(${JSON.stringify(roster('Hermes'))} + ' .settings-save-status')?.textContent.includes('Hermes 设置已保存')`), 'save retry');
  const persistedSettings = await cdp.evaluate(`window.__rpcCall('/settings')`);
  if (JSON.stringify(persistedSettings.settings.codex_args) !== JSON.stringify(['--model']) || JSON.stringify(persistedSettings.settings.hermes_args) !== JSON.stringify(['hermes-draft']) || persistedSettings.settings.pi_roles.length) throw new Error('real server did not persist only submitted fields');
  await cdp.evaluate(`(() => { const trigger = document.querySelector(${JSON.stringify(roster('Local'))} + ' .agent-roster-trigger'); if (trigger.getAttribute('data-state') !== 'open') trigger.click(); })()`);
  const profileSaveCount = await cdp.evaluate(`window.__rpcRequests.filter(item => item.method === 'PUT' && item.path === '/settings').length`);
  await mouseClick(`${roster('Local')} button[aria-label="添加 profile 文件"]`);
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.profile-file-picker') && document.activeElement.getAttribute('aria-label') === '关闭文件选择器'`), 'profile picker focus');
  await input('.profile-file-picker input[aria-label="文件目录路径"]', root);
  await cdp.evaluate(`document.querySelector('.profile-file-picker .workspace-path').requestSubmit()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.profile-file-picker > footer span').textContent === ${JSON.stringify(root)}`), 'profile directory browse');
  if (!await cdp.evaluate(`window.__rpcRequests.filter(item => item.method === 'PUT' && item.path === '/settings').length === ${profileSaveCount} && Number(getComputedStyle(document.querySelector('.profile-file-picker')).zIndex) > Number(getComputedStyle(document.querySelector('.profile-file-overlay')).zIndex)`)) throw new Error('profile browse saved settings or appeared below its overlay');
  await keyPress('Escape');
  await waitFor(() => cdp.evaluate(`!document.querySelector('.profile-file-picker') && document.activeElement.getAttribute('aria-label') === '添加 profile 文件'`), 'profile picker return focus');
  if (!await cdp.evaluate(`document.querySelector(${JSON.stringify(roster('Codex'))} + ' button[type="submit"]').disabled && !document.querySelector(${JSON.stringify(roster('Codex'))} + ' .settings-dirty-badge')`)) throw new Error('unchanged card remains saveable');
  await input(`${roster('Codex')} input[aria-label="启动参数 1"]`, '--review-draft');
  await mouseClick(`${roster('Codex')} .settings-reset`);
  if (!await cdp.evaluate(`document.querySelector(${JSON.stringify(roster('Codex'))} + ' input[aria-label="启动参数 1"]').value === '--model' && !!document.querySelector(${JSON.stringify(roster('Pi'))} + ' .settings-dirty-badge')`)) throw new Error('single-card reset changed other drafts');
  console.log('PASS card dirty markers and individual reset preserve other drafts');
  await input(`${roster('Codex')} input[aria-label="启动参数 1"]`, '--model-timeout');
  await rule({ method: 'GET', path: '/settings', hold: true, label: 'save-timeout' });
  await cdp.evaluate(`(() => { window.__regularTimeout = window.setTimeout; window.setTimeout = (callback, duration, ...args) => window.__regularTimeout(callback, duration === 120000 ? 100 : duration, ...args); })()`);
  await mouseClick(`${roster('Codex')} button[type="submit"]`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.general-settings-content [role="alert"]')?.textContent.includes('请求超时') && !document.querySelector('[aria-label="返回工作台"]').disabled`), 'real RPC timeout unlock');
  await cdp.evaluate(`window.setTimeout = window.__regularTimeout`);
  await releaseRPC('save-timeout');
  console.log('PASS scoped settings saves, switch-only writes, delayed locks, normalization, and failure retry');

  await mouseClick('.settings-navigation-item:last-child');
  await mouseClick('.settings-navigation-item:first-child');
  if (!await cdp.evaluate(`!!document.querySelector(${JSON.stringify(roster('Pi'))} + ' input[placeholder="角色名称"]')`)) throw new Error('subsection change discarded settings drafts');
  await mouseClick('button[aria-label="返回工作台"]');
  await waitFor(() => cdp.evaluate(`document.querySelector('[aria-describedby="confirm-dialog-description"]')?.textContent.includes('放弃')`), 'unsaved draft confirmation');
  await mouseClick('[aria-describedby="confirm-dialog-description"] footer button:last-child');
  await cdp.evaluate(`window.__rpcCall('/settings', 'PUT', ${JSON.stringify({ ...persistedSettings.settings, pi_default: join(temporary, 'missing-pi'), pi_args: ['--model'] })})`);
  await mouseClick('.agent-rail button:has(.agent-icon-pi)');
  await waitFor(() => cdp.evaluate(`document.querySelector('.catalog-header strong')?.textContent === 'Pi' && window.__rpcRequests.filter(item => item.path.startsWith('/sessions/catalog')).every(item => window.__rpcResponses.includes(item.id))`), 'Pi catalog response');
  if (await cdp.evaluate(`!!document.querySelector('[aria-describedby="error-dialog-description"]')`)) await clickSelector('[aria-describedby="error-dialog-description"] button', 'fixture cache notice');
  await rule({ method: 'GET', path: '/settings', error: '测试参数读取失败' });
  await mouseClick('button[aria-label="新建会话"]');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.workspace-picker')`), 'workspace picker opens');
  await waitFor(() => cdp.evaluate(`document.querySelector('.workspace-picker [role="alert"]')?.textContent.includes('测试参数读取失败')`), 'launch-argument load error');
  if (!await cdp.evaluate(`document.querySelector('.workspace-picker > footer button').disabled && document.activeElement.getAttribute('aria-label') === '关闭目录选择器'`)) throw new Error('picker allowed missing parameters or stole input focus');
  await mouseClick('.workspace-picker [role="alert"] button');
  await waitFor(() => cdp.evaluate(`!document.querySelector('.workspace-picker > footer button').disabled`), 'argument retry');
  await mouseClick('.workspace-advanced > button');
  await rule({ method: 'GET', prefix: '/workspaces/browse?', hold: true, label: 'old-directory' });
  await mouseClick('.workspace-picker button[aria-label="用户主目录"]');
  await waitFor(() => cdp.evaluate(`window.__heldRPC.some(item => item.label === 'old-directory')`), 'old directory request');
  await input('.workspace-picker input[aria-label="文件目录路径"]', root);
  await cdp.evaluate(`document.querySelector('.workspace-path').requestSubmit()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.workspace-picker > footer span').textContent === ${JSON.stringify(root)} && !document.querySelector('.workspace-picker > footer button').disabled`), 'latest directory');
  await releaseRPC('old-directory');
  await cdp.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  if (!await cdp.evaluate(`document.querySelector('.workspace-picker > footer span').textContent === ${JSON.stringify(root)}`)) throw new Error('old directory response overwrote newer selection');
  await rule({ method: 'POST', path: '/agents/pi/sessions', hold: true, label: 'create-agent' });
  await cdp.evaluate(`(() => { const button = document.querySelector('.workspace-picker > footer button'); button.click(); button.click(); })()`);
  await waitFor(() => cdp.evaluate(`window.__heldRPC.some(item => item.label === 'create-agent')`), 'delayed agent creation');
  await keyPress('Escape');
  if (!await cdp.evaluate(`!!document.querySelector('.workspace-picker') && document.querySelector('[aria-label="关闭目录选择器"]').disabled && window.__rpcRequests.filter(item => item.method === 'POST' && item.path === '/agents/pi/sessions').length === 1`)) throw new Error('pending creation dismissed or submitted twice');
  await releaseRPC('create-agent');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.workspace-picker [role="alert"]') && !document.querySelector('.workspace-picker > footer button').disabled`), 'real unavailable Pi create failure');
  if (!await cdp.evaluate(`document.querySelector('.workspace-picker input[aria-label="启动参数 1"]').value === '--model' && document.querySelector('.workspace-picker > footer span').textContent === ${JSON.stringify(root)}`)) throw new Error('creation failure lost launch input');
  await rule({ method: 'POST', path: '/agents/pi/sessions', error: '测试创建重试失败' });
  await mouseClick('.workspace-picker > footer button');
  await waitFor(() => cdp.evaluate(`document.querySelector('.workspace-picker [role="alert"]')?.textContent.includes('测试创建重试失败') && !document.querySelector('.workspace-picker > footer button').disabled`), 'creation retry');
  await keyPress('Escape');
  await waitFor(() => cdp.evaluate(`!document.querySelector('.workspace-picker') && document.activeElement.getAttribute('aria-label') === '新建会话'`), 'picker return focus');
  console.log('PASS workspace parameter retry, out-of-order browse, duplicate creation guard, and real server failure recovery');

  await mouseClick('.agent-rail button:has(.agent-icon-codex)');
  await waitFor(() => cdp.evaluate(`document.querySelector('.catalog-header strong')?.textContent === 'Codex' && window.__rpcRequests.filter(item => item.path.startsWith('/sessions/catalog')).every(item => window.__rpcResponses.includes(item.id))`), 'Codex catalog response');
  await dismissUnavailableNotice();
  await mouseClick('button[aria-label="codex 设置"]');
  await waitFor(() => cdp.evaluate(`!!document.querySelector(${JSON.stringify(roster('Codex'))} + ' .agent-roster-content')`), 'shortcut opens Codex configuration');
  await input(`${roster('Codex')} input[aria-label="启动参数 1"]`, '--shortcut-retry');
  await rule({ method: 'PUT', path: '/settings', hold: true, error: '测试快捷保存失败', label: 'shortcut-save' });
  await mouseClick(`${roster('Codex')} button[type="submit"]`);
  await waitFor(() => cdp.evaluate(`window.__heldRPC.some(item => item.label === 'shortcut-save')`), 'shortcut delayed save');
  if (!await cdp.evaluate(`document.querySelector('.settings-back').disabled`)) throw new Error('shortcut save was not locked');
  await releaseRPC('shortcut-save');
  await waitFor(() => cdp.evaluate(`document.querySelector('.general-settings-content [role="alert"]')?.textContent.includes('测试快捷保存失败')`), 'shortcut failure feedback');
  await mouseClick(`${roster('Codex')} button[type="submit"]`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.settings-save-status')?.textContent.includes('Codex 设置已保存')`), 'shortcut save retry');
  await mouseClick('button[aria-label="返回工作台"]');

  const selectFixtureAgent = async kind => {
    await mouseClick(`.agent-rail button:has(.agent-icon-${kind})`);
    await waitFor(() => cdp.evaluate(`document.querySelector('.catalog-header strong')?.textContent.toLowerCase() === ${JSON.stringify(kind)} && window.__rpcRequests.filter(item => item.path.startsWith('/sessions/catalog')).every(item => window.__rpcResponses.includes(item.id))`), kind + ' catalog settled');
    if (await cdp.evaluate(`!!document.querySelector('[aria-describedby="error-dialog-description"]')`)) await clickSelector('[aria-describedby="error-dialog-description"] button', kind + ' fixture cache notice');
  };
  for (const kind of ['codex', 'hermes']) {
    await selectFixtureAgent(kind);
    await mouseClick('button[aria-label="新建会话"]');
    await waitFor(() => cdp.evaluate(`!!document.querySelector('.workspace-picker') && !document.querySelector('.workspace-picker > footer button').disabled`), kind + ' picker ready');
    const before = await cdp.evaluate(`window.__rpcRequests.filter(item => item.method === 'POST' && item.path === '/agents/${kind}/sessions').length`);
    await rule({ method: 'POST', path: `/agents/${kind}/sessions`, hold: true, error: `测试 ${kind} 创建失败`, label: 'typed-create' });
    await cdp.evaluate(`(() => { const button = document.querySelector('.workspace-picker > footer button'); button.click(); button.click(); })()`);
    await waitFor(() => cdp.evaluate(`window.__heldRPC.some(item => item.label === 'typed-create')`), kind + ' create snapshot');
    if (!await cdp.evaluate(`window.__rpcRequests.filter(item => item.method === 'POST' && item.path === '/agents/${kind}/sessions').length === ${before + 1} && window.__heldRPC.find(item => item.label === 'typed-create').body.launch_args[0] === ${JSON.stringify(kind === 'codex' ? '--shortcut-retry' : 'hermes-draft')}`)) throw new Error(kind + ' creation routing or snapshot failed');
    await releaseRPC('typed-create');
    await waitFor(() => cdp.evaluate(`document.querySelector('.workspace-picker [role="alert"]')?.textContent.includes('测试 ${kind} 创建失败') && !document.querySelector('.workspace-picker > footer button').disabled`), kind + ' create failure unlock');
    await keyPress('Escape');
  }
  await cdp.evaluate(`window.__rpcCall('/settings').then(value => window.__rpcCall('/settings', 'PUT', { ...value.settings, pi_roles: [{ name: 'e2e-role', entry: ${JSON.stringify(join(temporary, 'missing-role'))}, home: ${JSON.stringify(root)} }] }))`);
  await selectFixtureAgent('pi');
  await waitFor(() => cdp.evaluate(`Array.from(document.querySelectorAll('.role-strip [role="tab"]')).some(tab => tab.textContent === 'e2e-role')`), 'Pi fixture role');
  await mouseClick('.role-strip [role="tab"]:last-child');
  await waitFor(() => cdp.evaluate(`document.querySelector('.role-strip [data-state="active"]')?.textContent === 'e2e-role' && window.__rpcRequests.filter(item => item.path.startsWith('/sessions/catalog')).every(item => window.__rpcResponses.includes(item.id))`), 'Pi role selected');
  if (await cdp.evaluate(`!!document.querySelector('[aria-describedby="error-dialog-description"]')`)) await clickSelector('[aria-describedby="error-dialog-description"] button', 'Pi role cache notice');
  await rule({ method: 'GET', path: '/settings', hold: true, label: 'role-preflight' });
  await rule({ method: 'POST', path: '/agents/pi/sessions', error: '测试 Pi 角色创建失败' });
  await cdp.evaluate(`(() => { const button = document.querySelector('[aria-label="新建会话"]'); button.click(); button.click(); })()`);
  await waitFor(() => cdp.evaluate(`window.__heldRPC.some(item => item.label === 'role-preflight')`), 'Pi role preflight guard');
  await cdp.evaluate(`window.dispatchEvent(new CustomEvent('jian-enter-terminal', { detail: { id: ${JSON.stringify(sharedID)} } }))`);
  if (!await cdp.evaluate(`document.querySelector('.catalog-header strong').textContent === 'Pi' && window.__heldRPC.filter(item => item.label === 'role-preflight').length === 1 && !document.querySelector('.workspace-picker')`)) throw new Error('Pi role preflight lost routing or duplicated');
  await releaseRPC('role-preflight');
  await waitFor(() => cdp.evaluate(`document.querySelector('[aria-describedby="error-dialog-description"]')?.textContent.includes('测试 Pi 角色创建失败') && !document.querySelector('.session-catalog').inert`), 'Pi role failure unlock');
  if (!await cdp.evaluate(`(() => { const request = window.__rpcRequests.filter(item => item.method === 'POST' && item.path === '/agents/pi/sessions').at(-1); return request.body.profile === 'e2e-role' && request.body.workspace === ${JSON.stringify(root)}; })()`)) throw new Error('Pi role request used stale kind, profile or directory');
  await clickSelector('[aria-describedby="error-dialog-description"] button', 'Pi role failure notice');
  await selectFixtureAgent('codex');
  console.log('PASS Codex/Hermes creation routes and Pi role preflight retain their captured targets');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await openMobileNavigation();
  await tap('button[aria-label="新建会话"]');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.workspace-picker') && document.activeElement.getAttribute('aria-label') === '关闭目录选择器'`), 'mobile picker non-input focus');
  await cdp.evaluate(`(() => {
    Object.defineProperties(visualViewport, { height: { configurable: true, value: 380 }, offsetTop: { configurable: true, value: 50 } });
    visualViewport.dispatchEvent(new Event('resize'));
  })()`);
  await waitFor(() => cdp.evaluate(`document.documentElement.style.getPropertyValue('--dialog-viewport-height') === '380px'`), 'dialog keyboard viewport');
  await waitFor(() => cdp.evaluate(`document.querySelector('.workspace-picker').getBoundingClientRect().bottom <= 430`), 'picker layout uses keyboard viewport');
  const dialogGeometry = await cdp.evaluate(`(() => { const dialog = document.querySelector('.workspace-picker').getBoundingClientRect(), footer = document.querySelector('.workspace-picker > footer').getBoundingClientRect(), close = document.querySelector('[aria-label="关闭目录选择器"]').getBoundingClientRect(); return { top: dialog.top, bottom: dialog.bottom, footerBottom: footer.bottom, pageWidth: document.documentElement.scrollWidth, closeWidth: close.width, closeHeight: close.height }; })()`);
  if (dialogGeometry.top < 50 || dialogGeometry.bottom > 430 || dialogGeometry.footerBottom > 430 || dialogGeometry.pageWidth > 360 || dialogGeometry.closeWidth < 44 || dialogGeometry.closeHeight < 44) throw new Error('mobile keyboard dialog overflow: ' + JSON.stringify(dialogGeometry));
  await keyPress('Tab');
  if (!await cdp.evaluate(`!!document.activeElement.closest('.workspace-picker')`)) throw new Error('picker focus escaped');
  await keyPress('Escape');
  await waitFor(() => cdp.evaluate(`!document.querySelector('.workspace-picker') && document.activeElement.getAttribute('aria-label') === '更多工作台操作'`), 'mobile picker fallback focus');
  await cdp.evaluate(`(() => { delete visualViewport.height; delete visualViewport.offsetTop; visualViewport.dispatchEvent(new Event('resize')); })()`);
  console.log('PASS shortcut save locks/focus and mobile dialog keyboard viewport/touch targets');

  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await mouseClick('.agent-rail button:first-child');
  const localCount = await cdp.evaluate(`window.__rpcRequests.filter(item => item.method === 'POST' && item.path === '/local/sessions').length`);
  await rule({ method: 'POST', path: '/local/sessions', hold: true, label: 'local-create' });
  await cdp.evaluate(`(() => { const button = document.querySelector('[aria-label="新建会话"]'); button.click(); button.click(); })()`);
  await waitFor(() => cdp.evaluate(`window.__heldRPC.some(item => item.label === 'local-create')`), 'Local create pending');
  if (!await cdp.evaluate(`window.__rpcRequests.filter(item => item.method === 'POST' && item.path === '/local/sessions').length === ${localCount + 1}`)) throw new Error('Local creation duplicated');
  await releaseRPC('local-create');
  await waitFor(() => cdp.evaluate(`document.querySelector('.terminal-status-menu .status')?.textContent.trim() === '已连接' && !document.querySelector('.session-tab-close').disabled`), 'real Local created and attached');
  console.log('PASS repeated Local clicks create one real server-owned session');
  const paneCatalog = await cdp.evaluate(`window.__rpcCall('/sessions/catalog')`);
  paneCatalog.areas.codex.rows = [{ id: 'unavailable-e2e-pane', kind: 'codex', title: 'Unavailable pane', workspace: root, status: 'idle' }];
  paneCatalog.areas.codex.revision += 1000;
  await rule({ method: 'GET', prefix: '/sessions/catalog', body: paneCatalog });
  await mouseClick('.agent-rail button:has(.agent-icon-codex)');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.session-row .session-menu')`), 'secondary fixture catalog');
  await mouseClick('.session-row .session-menu button');
  await cdp.evaluate(`[...document.querySelectorAll('.session-actions button')].find(button => button.textContent.includes('在右侧打开')).click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.secondary-pane .terminal-connection-feedback')?.getAttribute('data-state') === 'reconnecting'`), 'secondary failed connection');
  const primarySocket = await cdp.evaluate(`(() => { window.__primaryPaneSocket = window.__terminalSockets.findLast(socket => socket.readyState === WebSocket.OPEN); window.__paneRetryTimeout = window.setTimeout; window.setTimeout = (callback, delay, ...args) => window.__paneRetryTimeout(callback, delay === 1000 ? 15000 : delay, ...args); return window.__terminalSockets.length; })()`);
  await mouseClick('.secondary-pane .terminal-connection-feedback button');
  await waitFor(() => cdp.evaluate(`window.__terminalSockets.length > ${primarySocket}`), 'secondary manual retry');
  if (!await cdp.evaluate(`window.__primaryPaneSocket.readyState === WebSocket.OPEN && document.querySelector('.terminal-status-menu .status')?.textContent.trim() === '已连接'`)) throw new Error('secondary retry affected primary display');
  await mouseClick('button[aria-label="关闭右侧终端"]');
  await cdp.evaluate(`window.setTimeout = window.__paneRetryTimeout`);
  await waitFor(() => cdp.evaluate(`!document.querySelector('.secondary-pane')`), 'secondary detached');
  console.log('PASS secondary connection recovery leaves the primary terminal connected');

  await cdp.evaluate(`window.__primaryPaneSocket.send(JSON.stringify({ type: 'input', data: ${JSON.stringify('exit\n')} }))`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.primary-pane .terminal-connection-feedback')?.getAttribute('data-state') === 'ended'`), 'real PTY ended');
  const endedSockets = await cdp.evaluate(`window.__terminalSockets.length`);
  await new Promise(resolve => setTimeout(resolve, 1200));
  if (await cdp.evaluate(`window.__terminalSockets.length`) !== endedSockets) throw new Error('ended PTY automatically reconnected');
  await mouseClick('.primary-pane .terminal-connection-feedback button');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('[aria-describedby="confirm-dialog-description"]')`), 'ended PTY restart confirmation');
  await mouseClick('[aria-describedby="confirm-dialog-description"] footer button:last-child');
  await waitFor(() => cdp.evaluate(`document.querySelector('.terminal-status-menu .status')?.textContent.trim() === '已连接'`), 'ended PTY confirmed restart');
  console.log('PASS ended PTY stops reconnecting and restarts only after confirmation');


  while (await cdp.evaluate(`document.querySelectorAll('.session-tab-close').length > 0`)) {
    if (await cdp.evaluate(`document.querySelectorAll('.session-tab-close').length === 1`)) {
      await cdp.evaluate(`document.querySelector('.session-tab-close').focus()`);
      await keyPress('Enter');
    } else {
      await cdp.evaluate(`document.querySelector('.session-tab-close').click()`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!await cdp.evaluate(`!!document.querySelector('.empty-state') && !document.querySelector('.settings-page')`)) throw new Error('last tab close did not show home');
  if (!await cdp.evaluate(`document.activeElement.matches('.empty-state button')`)) throw new Error('last keyboard close did not restore home focus');
  await cdp.evaluate(`window.__tabsReload = true`);
  await cdp.send('Page.reload');
  await waitFor(() => cdp.evaluate(`!window.__tabsReload && !!document.querySelector('.context-actions')`), 'reload after closing tabs');
  if (!await cdp.evaluate(`!document.querySelector('button[aria-label="返回工作台"]') && sessionStorage.getItem('jian.settings-tab-open') === null`)) throw new Error('closed settings tab returned after reload');
  console.log('PASS closing all tabs shows home and closed settings stays absent after reload');

  await mouseClick('button[aria-label="快速记事本"]');
  await waitFor(() => cdp.evaluate(`document.querySelector('.note-sync-status')?.textContent.includes('已保存')`), 'note hydration');
  await rule({ method: 'PUT', path: '/quick-note', error: 'temporary note sync failure' });
  await cdp.evaluate(`(() => { const input = document.querySelector('#quick-note-body'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'UX_SYNC_RETRY'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.note-sync-status')?.textContent.includes('同步失败')`), 'note failure state');
  if (!await cdp.evaluate(`JSON.parse(localStorage.getItem('jian.quick-note.theme-test')).pending.length > 0`)) throw new Error('failed note update was not retained');
  await mouseClick('.note-sync-status button');
  await waitFor(() => cdp.evaluate(`document.querySelector('.note-sync-status')?.textContent.includes('已保存') && !JSON.parse(localStorage.getItem('jian.quick-note.theme-test')).pending.length`), 'note retry persisted');
  await keyPress('Escape');
  console.log('PASS note sync failure retains local edits and retry persists them');

  await waitFor(() => cdp.evaluate(`window.__rpcRequests.filter(item => item.path.startsWith('/sessions/catalog')).every(item => window.__rpcResponses.includes(item.id))`), 'reload catalogs settled');
  await dismissUnavailableNotice();
  await mouseClick('button[aria-label="设置"]');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.settings-navigation')`), 'settings reopened before logout');
  await mouseClick('.settings-navigation-item:first-child');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.agent-toggle-list')`), 'settings before logout race');
  await cdp.evaluate(`(() => { const trigger = document.querySelector(${JSON.stringify(roster('Codex'))} + ' .agent-roster-trigger'); if (trigger.getAttribute('data-state') !== 'open') trigger.click(); })()`);
  await input(`${roster('Codex')} input[aria-label="启动参数 1"]`, '--logout-race');
  const beforeLogoutPuts = await cdp.evaluate(`window.__rpcRequests.filter(item => item.method === 'PUT' && item.path === '/settings').length`);
  const logoutSettings = await cdp.evaluate(`window.__rpcCall('/settings')`);
  await rule({ method: 'GET', path: '/settings', hold: true, body: logoutSettings, label: 'stale-save' });
  await rule({ method: 'POST', path: '/auth/logout', hold: true, label: 'logout' });
  await mouseClick(`${roster('Codex')} button[type="submit"]`);
  await waitFor(() => cdp.evaluate(`window.__heldRPC.some(item => item.label === 'stale-save')`), 'save before logout');
  await mouseClick('.settings-account button[aria-label="退出登录"]');
  await waitFor(() => cdp.evaluate(`window.__heldRPC.some(item => item.label === 'logout') && !document.querySelector('.settings-page')`), 'logout while saving');
  await releaseRPC('stale-save');
  await cdp.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  if (!await cdp.evaluate(`window.__rpcRequests.filter(item => item.method === 'PUT' && item.path === '/settings').length === ${beforeLogoutPuts} && !document.querySelector('.settings-page') && !document.querySelector('[aria-describedby="error-dialog-description"]')`)) throw new Error('late settings response mutated a logged-out workflow');
  await releaseRPC('logout');
  await waitFor(() => cdp.evaluate(`!!document.querySelector('input[type="password"]') && !document.querySelector('.context-actions')`), 'logout finished');
  console.log('PASS logout remains available while saving and stale replies never issue a settings write');

} finally {
  const exits = [];
  for (const child of processes.reverse()) {
    if (!child.pid) continue;
    exits.push(new Promise(resolve => child.once('exit', resolve)));
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  }
  await Promise.race([Promise.all(exits), new Promise(resolve => setTimeout(resolve, 3000))]);
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
