import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { attachTerminalInputBuffer, isPasteShortcut } from '../../terminal-input-buffer';
import { terminalThemes, type TerminalTheme } from './themes';
import type { Kind } from '../../shared/model';

type MountOptions = {
  host: HTMLDivElement;
  inputBuffer: HTMLTextAreaElement | null;
  preview: HTMLSpanElement | null;
  terminalRef: { current: Terminal | null };
  socketRef: { current: WebSocket | null };
  fitRequestRef: { current: (() => void) | null };
  sessionID: string;
  terminalPath: Kind | 'local';
  theme: TerminalTheme;
  fontSize: number;
  focus: () => void;
  send: (data: string) => void;
  onStatus: (value: string) => void;
  onProgress: (value: string) => void;
  onSearchAddon: (addon: SearchAddon | null) => void;
};

export function mountTerminal(options: MountOptions) {
  const { host, inputBuffer, preview, terminalRef, socketRef, fitRequestRef, sessionID, terminalPath, theme, fontSize, focus, send, onStatus, onProgress, onSearchAddon } = options;
  onProgress('正在建立终端连接…');
  const touchInput = window.matchMedia('(pointer: coarse), (hover: none)').matches;
  const term = new Terminal({ cursorBlink: true, disableStdin: true, fontSize, theme: terminalThemes[theme], scrollback: 10000 });
  // A selected xterm range owns Ctrl+C: copy and clear the selection instead
  // of sending SIGINT. With no selection xterm keeps its normal control byte.
  term.attachCustomKeyEventHandler(event => {
    if (event.type === 'keydown' && event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'c' && term.hasSelection()) {
      const selected = term.getSelection();
      const clipboardWrite = navigator.clipboard?.writeText(selected);
      const fallbackCopy = () => {
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const copy = document.createElement('textarea');
        copy.value = selected;
        copy.readOnly = true;
        copy.style.position = 'fixed';
        copy.style.opacity = '0';
        document.body.append(copy);
        copy.select();
        try { document.execCommand('copy'); } catch {}
        copy.remove();
        if (previous?.isConnected) previous.focus({ preventScroll: true });
      };
      if (clipboardWrite) void clipboardWrite.catch(fallbackCopy); else fallbackCopy();
      term.clearSelection();
      return false;
    }
    return !isPasteShortcut(event);
  });
  terminalRef.current = term;
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_event, uri) => {
    try {
      const url = new URL(uri);
      if (url.protocol === 'http:' || url.protocol === 'https:') window.open(url.href, '_blank', 'noopener,noreferrer');
    } catch {}
  }));
  term.open(host);
  onSearchAddon(search);
  let webgl: WebglAddon | undefined;
  try {
    const addon = new WebglAddon();
    webgl = addon;
    addon.onContextLoss(() => addon.dispose());
    term.loadAddon(addon);
  } catch {
    webgl?.dispose();
    // Keep xterm's default renderer when WebGL2 is unavailable.
  }
  const xtermTextarea = term.textarea;
  if (xtermTextarea) {
    xtermTextarea.inputMode = touchInput ? 'none' : 'text';
    xtermTextarea.disabled = touchInput;
    xtermTextarea.readOnly = touchInput;
    xtermTextarea.tabIndex = touchInput ? -1 : 0;
    xtermTextarea.setAttribute('autocomplete', 'off');
    xtermTextarea.setAttribute('aria-label', '终端输入');
  }
  let frame = 0, inputFrame = 0, lastSize = '', lastLayout = '', replayed = false, started = false, disposed = false, ended = false, reconnectDelay = 1000, reconnectTimer = 0, connectionTimer = 0, heartbeatTimer = 0, pongTimer = 0, hasConnected = false;
  let inputGeometry: { left: number; top: number; cellWidth: number; cellHeight: number } | null = null;
  const measureInputGeometry = () => {
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    const stage = host.parentElement;
    if (!screen || !stage || !term.cols || !term.rows) { inputGeometry = null; return; }
    const screenBox = screen.getBoundingClientRect(), stageBox = stage.getBoundingClientRect();
    inputGeometry = {
      left: screenBox.left - stageBox.left,
      top: screenBox.top - stageBox.top,
      cellWidth: screenBox.width / term.cols,
      cellHeight: Math.max(1, screenBox.height / term.rows),
    };
  };
  const positionInput = () => {
    if (!touchInput || !inputBuffer || !preview) return;
    if (!inputGeometry) measureInputGeometry();
    if (!inputGeometry || inputFrame) return;
    inputFrame = requestAnimationFrame(() => {
      inputFrame = 0;
      const { left, top, cellWidth, cellHeight } = inputGeometry!;
      const styles = {
        left: `${left + term.buffer.active.cursorX * cellWidth}px`,
        top: `${top + term.buffer.active.cursorY * cellHeight}px`,
        height: `${cellHeight}px`,
        lineHeight: `${cellHeight}px`,
      };
      for (const element of [inputBuffer, preview])
        for (const [property, value] of Object.entries(styles))
          if (element.style[property as 'left' | 'top' | 'height' | 'lineHeight'] !== value)
            element.style[property as 'left' | 'top' | 'height' | 'lineHeight'] = value;
    });
  };
  const resize = () => {
    frame = 0;
    const width = host.clientWidth, height = host.clientHeight;
    if (width > 0 && height > 0) {
      const layout = `${width}x${height}:${term.options.fontSize}:${window.devicePixelRatio}`;
      if (layout !== lastLayout) {
        const dimensions = fit.proposeDimensions();
        if (dimensions) {
          if (dimensions.cols !== term.cols || dimensions.rows !== term.rows) fit.fit();
          lastLayout = layout;
          if (touchInput && inputBuffer && preview) {
            inputGeometry = null;
            measureInputGeometry();
            positionInput();
          }
        }
      }
    }
    const size = `${term.cols}x${term.rows}`, ws = socketRef.current;
    if (size !== lastSize && ws?.readyState === WebSocket.OPEN) { lastSize = size; ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(resize); };
  const resizeNow = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    resize();
  };
  fitRequestRef.current = schedule;
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  resizeObserver?.observe(host);
  const viewport = window.visualViewport;
  const workspace = host.closest<HTMLElement>('.workspace-view');
  const syncViewportHeight = () => {
    if (!touchInput || !viewport || !workspace) return;
    const height = `${Math.max(1, Math.round(viewport.height))}px`;
    if (workspace.style.getPropertyValue('--mobile-viewport-height') !== height)
      workspace.style.setProperty('--mobile-viewport-height', height);
  };
  const syncViewportOffset = () => {
    if (!touchInput || !viewport || !workspace) return;
    const offset = `${Math.round(viewport.offsetTop)}px`;
    if (workspace.style.getPropertyValue('--mobile-viewport-offset') !== offset)
      workspace.style.setProperty('--mobile-viewport-offset', offset);
  };
  const syncViewport = () => {
    syncViewportHeight();
    syncViewportOffset();
    schedule();
  };
  const render = term.onRender(positionInput);
  const inputCleanup = touchInput && inputBuffer ? attachTerminalInputBuffer(inputBuffer, { send, preview: text => { if (preview) preview.textContent = text; } }) : undefined;
  syncViewport();
  const endpoint = sessionID.startsWith('local-') ? `/api/local/sessions/${encodeURIComponent(sessionID)}/terminal` : `/api/agents/${terminalPath}/sessions/${encodeURIComponent(sessionID)}/terminal`;
  const connect = () => {
    if (disposed || ended) return;
    const reconnecting = hasConnected;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${endpoint}`);
    socketRef.current = ws;
    connectionTimer = window.setTimeout(() => ws.close(), 10000);
    ws.onopen = () => {
      window.clearTimeout(connectionTimer);
      if (hasConnected) { term.reset(); replayed = started = false; }
      hasConnected = true;
      reconnectDelay = 1000;
      lastSize = '';
      resizeNow();
      onProgress('正在恢复终端输出…');
      heartbeatTimer = window.setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN || pongTimer) return;
        ws.send(JSON.stringify({ type: 'ping' }));
        pongTimer = window.setTimeout(() => ws.close(), 10000);
      }, 15000);
    };
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.type === 'pong') { window.clearTimeout(pongTimer); pongTimer = 0; return; }
      if (message.type === 'pty.output') {
        if (!started) { replayed = true; term.write(message.payload, () => { term.options.disableStdin = false; }); }
        else term.write(message.payload);
      }
      if (message.type === 'pty.exit') { ended = true; onStatus('ended'); onProgress('终端已结束'); }
      if (message.type === 'session.started') {
        started = true;
        if (!replayed) term.options.disableStdin = false;
        onStatus('running');
        onProgress('已连接');
        const active = document.activeElement;
        if (!reconnecting && !touchInput && !(active instanceof HTMLElement && active.matches('input, textarea, [contenteditable="true"]')) && !document.querySelector('[role="dialog"][aria-modal="true"], [role="dialog"][data-state="open"]')) focus();
      }
    };
    ws.onclose = () => {
      window.clearTimeout(connectionTimer);
      window.clearInterval(heartbeatTimer);
      window.clearTimeout(pongTimer);
      heartbeatTimer = pongTimer = 0;
      if (socketRef.current === ws) socketRef.current = null;
      if (disposed || ended) return;
      term.options.disableStdin = true;
      onStatus('reconnecting');
      onProgress('连接中断，正在重连…');
      reconnectTimer = window.setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    };
    ws.onerror = () => ws.close();
  };
  connect();
  const input = term.onData(data => { if (!touchInput) send(data); });
  window.addEventListener('resize', syncViewport);
  viewport?.addEventListener('resize', syncViewport);
  viewport?.addEventListener('scroll', syncViewportOffset);
  return () => {
    disposed = true;
    window.clearTimeout(reconnectTimer);
    window.clearTimeout(connectionTimer);
    window.clearInterval(heartbeatTimer);
    window.clearTimeout(pongTimer);
    inputCleanup?.();
    input.dispose();
    render.dispose();
    resizeObserver?.disconnect();
    if (fitRequestRef.current === schedule) fitRequestRef.current = null;
    if (frame) cancelAnimationFrame(frame);
    if (inputFrame) cancelAnimationFrame(inputFrame);
    window.removeEventListener('resize', syncViewport);
    viewport?.removeEventListener('resize', syncViewport);
    viewport?.removeEventListener('scroll', syncViewportOffset);
    workspace?.style.removeProperty('--mobile-viewport-height');
    workspace?.style.removeProperty('--mobile-viewport-offset');
    socketRef.current?.close();
    onSearchAddon(null);
    term.dispose();
    terminalRef.current = null;
    socketRef.current = null;
  };
}
