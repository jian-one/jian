import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const port = 18000 + Math.floor(Math.random() * 1000);
const chromePort = port + 1000;
const temporary = await mkdtemp(join(tmpdir(), 'jian-theme-e2e-'));
const processes = [];

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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
}

try {
  start('cargo', ['run', '--quiet'], {
    cwd: root,
    env: {
      ...process.env,
      JIAN_ADDR: `127.0.0.1:${port}`,
      JIAN_DB: join(temporary, 'jian.db'),
      JIAN_ADMIN_USER: 'theme-test',
      JIAN_ADMIN_PASSWORD: 'theme-test-password',
      JIAN_CODEX_BIN: join(temporary, 'missing-codex'),
      JIAN_HERMES_BIN: join(temporary, 'missing-hermes'),
    },
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/auth/status`)).ok, 'Jian server');

  start('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu',
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
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await waitFor(() => cdp.evaluate(`document.readyState === 'complete'`), 'initial page');
  await cdp.evaluate(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'theme-test', password: 'theme-test-password' }) }).then(response => { if (!response.ok) throw new Error('login failed'); location.reload(); })`);
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.context-actions')`), 'authenticated workspace');

  const clickSelector = async (selector, label) => {
    const point = await cdp.evaluate(`(() => { const button = document.querySelector(${JSON.stringify(selector)}); if (!button) return null; const box = button.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
    if (!point) throw new Error(`${label} is missing`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const click = label => clickSelector(`button[aria-label="${label}"]`, `${label} button`);
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
  await cdp.evaluate(`localStorage.setItem('jian.terminal_theme', 'black'); location.reload()`);
  await waitFor(() => cdp.evaluate(`document.documentElement.dataset.theme === 'light' && localStorage.getItem('jian.terminal_theme') === 'console'`), 'legacy Terminal theme migration');
  await assertOpen('Terminal 配色', false);
  if (!await cdp.evaluate(`!!document.querySelector('.theme-menu[aria-label="Terminal 配色"] button[data-theme-preview="console"].selected')`)) throw new Error('legacy black Terminal theme was not migrated to console');
  console.log('PASS homepage theme popovers stay open and persist independently');
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
