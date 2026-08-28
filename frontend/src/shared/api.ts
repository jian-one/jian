type RpcResponse = { id: number; status: number; body: unknown };
type SocketMessage = Partial<RpcResponse> & { type?: string };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: number };

let socket: WebSocket | null = null;
let connecting: Promise<void> | null = null;
let reconnectTimer = 0;
let reconnectDelay = 1000;
let heartbeatTimer = 0;
let authRefreshTimer = 0;
let pongTimer = 0;
let nextID = 1;
let keepAlive = false;
const pending = new Map<number, Pending>();
const socketEvents = new Map<string, Set<(message: SocketMessage) => void>>();

export function onSocketEvent(type: string, listener: (message: SocketMessage) => void) {
  const listeners = socketEvents.get(type) || new Set();
  listeners.add(listener);
  socketEvents.set(type, listeners);
  return () => { listeners.delete(listener); if (!listeners.size) socketEvents.delete(type); };
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Request failed';

export function parseSocketMessage(data: string): SocketMessage | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== 'object') return null;
    return value as SocketMessage;
  } catch {
    return null;
  }
}

const wsURL = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;

function stopHeartbeat() {
  window.clearInterval(heartbeatTimer);
  window.clearInterval(authRefreshTimer);
  window.clearTimeout(pongTimer);
  heartbeatTimer = authRefreshTimer = pongTimer = 0;
}

function scheduleReconnect() {
  if (!keepAlive || reconnectTimer) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    void connect().catch(scheduleReconnect);
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

function connect(): Promise<void> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve();
  if (connecting) return connecting;
  keepAlive = true;
  connecting = new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsURL());
    socket = ws;
    const connectionTimeout = window.setTimeout(() => ws.close(), 10000);
    let opened = false;
    ws.onopen = () => {
      opened = true;
      window.clearTimeout(connectionTimeout);
      reconnectDelay = 1000;
      heartbeatTimer = window.setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN || pongTimer) return;
        ws.send(JSON.stringify({ type: 'ping' }));
        pongTimer = window.setTimeout(() => ws.close(), 10000);
      }, 15000);
      authRefreshTimer = window.setInterval(() => {
        void authRequest<{ authenticated: boolean }>('/auth/status', { method: 'GET' })
          .then(status => { if (!status.authenticated) ws.close(); })
          .catch(() => ws.close());
      }, 15 * 60 * 1000);
      resolve();
    };
    ws.onmessage = event => {
      const message = parseSocketMessage(event.data);
      if (!message) return;
      if (message.type === 'pong') {
        window.clearTimeout(pongTimer);
        pongTimer = 0;
        return;
      }
      if (message.type) {
        socketEvents.get(message.type)?.forEach(listener => listener(message));
        return;
      }
      if (typeof message.id !== 'number' || typeof message.status !== 'number') return;
      const request = pending.get(message.id);
      if (!request) return;
      window.clearTimeout(request.timeout);
      pending.delete(message.id);
      if (message.status >= 200 && message.status < 300) request.resolve(message.body);
      else request.reject(new Error((message.body as { error?: string } | null)?.error || 'Request failed'));
    };
    ws.onclose = () => {
      window.clearTimeout(connectionTimeout);
      stopHeartbeat();
      if (socket === ws) socket = null;
      connecting = null;
      const error = new Error('WebSocket 连接中断，请重试');
      for (const request of pending.values()) {
        window.clearTimeout(request.timeout);
        request.reject(error);
      }
      pending.clear();
      if (!opened) reject(error);
      scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }).finally(() => { connecting = null; });
  return connecting;
}

function closeSocket() {
  keepAlive = false;
  window.clearTimeout(reconnectTimer);
  reconnectTimer = 0;
  socket?.close();
  socket = null;
}

async function authRequest<T>(path: string, options: RequestInit): Promise<T> {
  const response = await fetch('/api' + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: 'Request failed' }))).error);
  return response.status === 204 ? null as T : response.json();
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (path === '/auth/login' || path === '/auth/status') return authRequest(path, options);
  await connect();
  const id = nextID++;
  const body = typeof options.body === 'string' && options.body ? JSON.parse(options.body) : undefined;
  const result = await new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error('WebSocket 请求超时，请重试'));
    }, 120000);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
    socket!.send(JSON.stringify({ id, method: options.method || 'GET', path, body }));
  });
  if (path === '/auth/logout') closeSocket();
  return result;
}
