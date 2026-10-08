import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { attachTerminalInputBuffer, isPasteShortcut } from '../../terminal-input-buffer';
import { terminalThemes, type TerminalTheme } from './themes';
import type { Kind, ConnectionFeedback } from '../../shared/model';

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
  send: (data: string) => boolean;
  sendText: (data: string) => boolean;
  onUnsentText?: (text: string) => void;
  onBufferChange: (behind: boolean) => void;
  onStatus: (value: 'running' | 'ended') => void;
  onConnectionChange: (value: ConnectionFeedback) => void;
  reconnectRequestRef: { current: (() => void) | null };
  onProgress: (value: string) => void;
  onSearchAddon: (addon: SearchAddon | null) => void;
};

export function mountTerminal(options: MountOptions) {
  const { host, inputBuffer, preview, terminalRef, socketRef, fitRequestRef, sessionID, terminalPath, theme, fontSize, focus, send, sendText, onUnsentText, onBufferChange, onStatus, onConnectionChange, reconnectRequestRef, onProgress, onSearchAddon } = options;
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
  let frame = 0, inputFrame = 0, lastSize = '', lastLayout = '', started = false, disposed = false, ended = false, reconnectDelay = 1000, reconnectTimer = 0, connectionTimer = 0, heartbeatTimer = 0, pongTimer = 0, hasConnected = false;
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
  const render = term.onRender(positionInput);
  const inputCleanup = touchInput && inputBuffer ? attachTerminalInputBuffer(inputBuffer, { send: sendText, onUnsentText, preview: text => { if (preview) preview.textContent = text; } }) : undefined;
  schedule();
  const endpoint = sessionID.startsWith('local-') ? `/api/local/sessions/${encodeURIComponent(sessionID)}/terminal` : `/api/agents/${terminalPath}/sessions/${encodeURIComponent(sessionID)}/terminal`;
  let attempt = 0;
  const clearConnectionTimers = () => {
    window.clearTimeout(reconnectTimer); window.clearTimeout(connectionTimer);
    window.clearInterval(heartbeatTimer); window.clearTimeout(pongTimer);
    reconnectTimer = connectionTimer = heartbeatTimer = pongTimer = 0;
  };
  const ping = (ws: WebSocket) => {
    if (ws.readyState !== WebSocket.OPEN || pongTimer || document.hidden || navigator.onLine === false) return;
    ws.send(JSON.stringify({ type: 'ping' }));
    pongTimer = window.setTimeout(() => ws.close(), 10000);
  };
  const startHeartbeat = (ws: WebSocket) => {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = window.setInterval(() => ping(ws), 15000);
  };
  const connect = () => {
    if (disposed || ended) return;
    if (navigator.onLine === false || document.hidden) {
      if (navigator.onLine === false) { onConnectionChange({ state: 'offline', attempt, retrying: false }); onProgress('已离线，联网后恢复连接'); }
      return;
    }
    const reconnecting = hasConnected;
    attempt++;
    onConnectionChange({ state: reconnecting || attempt > 1 ? 'reconnecting' : 'connecting', attempt, retrying: true });
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${endpoint}`);
    socketRef.current = ws;
    let resetReplay = false, pendingReplay = 0;
    const allowInput = () => {
      if (started && !pendingReplay && !ended && socketRef.current === ws) term.options.disableStdin = false;
    };
    const resetOutput = () => { if (resetReplay) { term.reset(); resetReplay = false; } };
    connectionTimer = window.setTimeout(() => ws.close(), 10000);
    ws.onopen = () => {
      if (disposed || socketRef.current !== ws) return;
      window.clearTimeout(connectionTimer);
      started = false; resetReplay = hasConnected;
      hasConnected = true;
      lastSize = '';
      resizeNow();
      onProgress('正在恢复终端输出…');
      startHeartbeat(ws);
    };
    ws.onmessage = event => {
      if (disposed || socketRef.current !== ws) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (message.type === 'pong') { window.clearTimeout(pongTimer); pongTimer = 0; return; }
      if (message.type === 'pty.output' && typeof message.payload === 'string') {
        resetOutput();
        if (!started) { pendingReplay++; term.write(message.payload, () => { pendingReplay--; allowInput(); }); }
        else term.write(message.payload);
      }
      if (message.type === 'pty.exit') {
        ended = true; term.options.disableStdin = true; clearConnectionTimers();
        onStatus('ended'); onConnectionChange({ state: 'ended', attempt: 0, retrying: false }); onProgress('终端已结束');
      }
      if (message.type === 'session.started' && !ended) {
        resetOutput(); started = true; reconnectDelay = 1000; attempt = 0;
        allowInput();
        onStatus('running'); onConnectionChange({ state: 'connected', attempt: 0, retrying: false }); onProgress('已连接');
        const active = document.activeElement;
        if (!reconnecting && !touchInput && !(active instanceof HTMLElement && active.matches('input, textarea, [contenteditable="true"]')) && !document.querySelector('[role="dialog"][aria-modal="true"], [role="dialog"][data-state="open"]')) focus();
      }
    };
    ws.onclose = () => {
      if (disposed || socketRef.current !== ws) return;
      clearConnectionTimers(); socketRef.current = null;
      if (ended) return;
      term.options.disableStdin = true;
      onConnectionChange({ state: navigator.onLine === false ? 'offline' : 'reconnecting', attempt, retrying: false });
      onProgress(navigator.onLine === false ? '已离线，联网后恢复连接' : '连接中断，正在重连…');
      if (!document.hidden && navigator.onLine !== false) reconnectTimer = window.setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    };
    ws.onerror = () => ws.close();
  };
  const retryNow = () => {
    if (disposed || ended || socketRef.current?.readyState === WebSocket.CONNECTING) return;
    clearConnectionTimers();
    const previous = socketRef.current; socketRef.current = null;
    if (previous) { previous.onopen = previous.onmessage = previous.onclose = previous.onerror = null; previous.close(); }
    term.options.disableStdin = true;
    connect();
  };
  const resume = () => {
    if (disposed || ended || document.hidden || navigator.onLine === false) return;
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) { startHeartbeat(ws); ping(ws); }
    else if (ws?.readyState === WebSocket.CONNECTING) {
      window.clearTimeout(connectionTimer); connectionTimer = window.setTimeout(() => ws.close(), 10000);
    } else retryNow();
  };
  const visibility = () => { if (document.hidden) clearConnectionTimers(); else resume(); };
  const offline = () => {
    if (disposed || ended) return;
    clearConnectionTimers(); term.options.disableStdin = true;
    onConnectionChange({ state: 'offline', attempt, retrying: false }); onProgress('已离线，联网后恢复连接');
    socketRef.current?.close();
  };
  let newOutput = false;
  const reading = (written = false) => {
    const buffer = term.buffer.active;
    if (buffer.type !== 'normal' || buffer.viewportY >= buffer.baseY) newOutput = false;
    else if (written) newOutput = true;
    onBufferChange(newOutput);
  };
  const scrolled = term.onScroll(() => reading()), written = term.onWriteParsed(() => reading(true));
  reconnectRequestRef.current = retryNow;
  connect();
  const input = term.onData(data => { send(data); });
  window.addEventListener('resize', schedule);
  window.addEventListener('online', resume); window.addEventListener('offline', offline);
  window.addEventListener('pageshow', resume); document.addEventListener('visibilitychange', visibility);
  return () => {
    disposed = true;
    if (reconnectRequestRef.current === retryNow) reconnectRequestRef.current = null;
    window.clearTimeout(reconnectTimer);
    window.clearTimeout(connectionTimer);
    window.clearInterval(heartbeatTimer);
    window.clearTimeout(pongTimer);
    inputCleanup?.();
    input.dispose(); scrolled.dispose(); written.dispose();
    render.dispose();
    resizeObserver?.disconnect();
    if (fitRequestRef.current === schedule) fitRequestRef.current = null;
    if (frame) cancelAnimationFrame(frame);
    if (inputFrame) cancelAnimationFrame(inputFrame);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('online', resume); window.removeEventListener('offline', offline);
    window.removeEventListener('pageshow', resume); document.removeEventListener('visibilitychange', visibility);
    socketRef.current?.close();
    onSearchAddon(null);
    term.dispose();
    terminalRef.current = null;
    socketRef.current = null;
  };
}
