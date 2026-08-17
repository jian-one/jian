import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { attachTerminalInputBuffer, isPasteShortcut } from '../../terminal-input-buffer';
import { terminalThemes, type TerminalTheme } from './themes';
import type { Kind } from '../../shared/model';

type MountOptions = {
  host: HTMLDivElement;
  inputBuffer: HTMLTextAreaElement | null;
  preview: HTMLSpanElement | null;
  terminalRef: { current: Terminal | null };
  socketRef: { current: WebSocket | null };
  sessionID: string;
  terminalPath: Kind | 'local';
  theme: TerminalTheme;
  focus: () => void;
  send: (data: string) => void;
  onStatus: (value: string) => void;
  onProgress: (value: string) => void;
};

export function mountTerminal(options: MountOptions) {
  const { host, inputBuffer, preview, terminalRef, socketRef, sessionID, terminalPath, theme, focus, send, onStatus, onProgress } = options;
  onProgress('正在建立终端连接…');
  const touchInput = window.matchMedia('(pointer: coarse), (hover: none)').matches;
  const term = new Terminal({ cursorBlink: true, disableStdin: true, theme: terminalThemes[theme], scrollback: 10000 });
  // A selected xterm range owns Ctrl+C: copy and clear the selection instead
  // of sending SIGINT. With no selection xterm keeps its normal control byte.
  term.attachCustomKeyEventHandler(event => {
    if (event.type === 'keydown' && event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'c' && term.hasSelection()) {
      const selected = term.getSelection();
      const clipboardWrite = navigator.clipboard?.writeText(selected);
      const fallbackCopy = () => {
        const copy = document.createElement('textarea');
        copy.value = selected;
        copy.style.position = 'fixed';
        copy.style.opacity = '0';
        document.body.append(copy);
        copy.select();
        try { document.execCommand('copy'); } catch {}
        copy.remove();
      };
      if (clipboardWrite) void clipboardWrite.catch(fallbackCopy); else fallbackCopy();
      term.clearSelection();
      return false;
    }
    return !isPasteShortcut(event);
  });
  terminalRef.current = term;
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  const xtermTextarea = term.textarea;
  if (xtermTextarea) {
    xtermTextarea.inputMode = touchInput ? 'none' : 'text';
    xtermTextarea.disabled = touchInput;
    xtermTextarea.readOnly = touchInput;
    xtermTextarea.tabIndex = touchInput ? -1 : 0;
    xtermTextarea.setAttribute('autocomplete', 'off');
    xtermTextarea.setAttribute('aria-label', '终端输入');
  }
  let frame = 0, lastSize = '', replayed = false, started = false, disposed = false, ended = false, reconnectDelay = 1000, reconnectTimer = 0, connectionTimer = 0, heartbeatTimer = 0, pongTimer = 0, hasConnected = false;
  const positionInput = () => {
    if (!touchInput || !inputBuffer || !preview) return;
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    const stage = host.parentElement;
    if (!screen || !stage || !term.cols || !term.rows) return;
    const screenBox = screen.getBoundingClientRect(), stageBox = stage.getBoundingClientRect();
    const left = screenBox.left - stageBox.left + term.buffer.active.cursorX * screenBox.width / term.cols;
    const top = screenBox.top - stageBox.top + term.buffer.active.cursorY * screenBox.height / term.rows;
    const height = Math.max(1, screenBox.height / term.rows);
    for (const element of [inputBuffer, preview]) {
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
      element.style.height = `${height}px`;
      element.style.lineHeight = `${height}px`;
    }
  };
  const resize = () => {
    frame = 0;
    fit.fit();
    positionInput();
    const size = `${term.cols}x${term.rows}`, ws = socketRef.current;
    if (size !== lastSize && ws?.readyState === WebSocket.OPEN) { lastSize = size; ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(resize); };
  const viewport = window.visualViewport;
  const conversation = host.closest<HTMLElement>('.conversation');
  const syncViewport = () => {
    if (touchInput && viewport && conversation) conversation.style.setProperty('--mobile-viewport-height', `${Math.max(1, Math.round(viewport.height))}px`);
    schedule();
  };
  const render = term.onRender(positionInput);
  const inputCleanup = touchInput && inputBuffer ? attachTerminalInputBuffer(inputBuffer, { send, preview: text => { if (preview) preview.textContent = text; } }) : undefined;
  syncViewport();
  const endpoint = sessionID.startsWith('local-') ? `/api/local/sessions/${encodeURIComponent(sessionID)}/terminal` : `/api/agents/${terminalPath}/sessions/${encodeURIComponent(sessionID)}/terminal`;
  const connect = () => {
    if (disposed || ended) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${endpoint}`);
    socketRef.current = ws;
    connectionTimer = window.setTimeout(() => ws.close(), 10000);
    ws.onopen = () => {
      window.clearTimeout(connectionTimer);
      if (hasConnected) { term.reset(); replayed = started = false; }
      hasConnected = true;
      reconnectDelay = 1000;
      lastSize = '';
      resize();
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
      if (message.type === 'session.started') { started = true; if (!replayed) term.options.disableStdin = false; onStatus('running'); onProgress('已连接'); focus(); }
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
  viewport?.addEventListener('scroll', syncViewport);
  return () => {
    disposed = true;
    window.clearTimeout(reconnectTimer);
    window.clearTimeout(connectionTimer);
    window.clearInterval(heartbeatTimer);
    window.clearTimeout(pongTimer);
    inputCleanup?.();
    input.dispose();
    render.dispose();
    if (frame) cancelAnimationFrame(frame);
    window.removeEventListener('resize', syncViewport);
    viewport?.removeEventListener('resize', syncViewport);
    viewport?.removeEventListener('scroll', syncViewport);
    conversation?.style.removeProperty('--mobile-viewport-height');
    socketRef.current?.close();
    term.dispose();
    terminalRef.current = null;
    socketRef.current = null;
  };
}
