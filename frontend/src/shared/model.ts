export type Kind = 'codex' | 'command';
export type Theme = 'console' | 'light' | 'black';

export type LocalSession = {
  id: string;
  kind: 'local';
  title: string;
  workspace: string;
  status: string;
  created_at?: string;
  updated_at?: string;
};

export type TerminalSession = { id: string };
export type BrowseResult = { path: string; parent: string; entries: { name: string; directory: boolean }[] };
export type EnvironmentVariable = { key: string; value: string };
export type CommandConfig = { id: string; name: string; program: string; args: string[]; env: EnvironmentVariable[] };
export type AgentSettings = { codex_bin: string; path: string; local_profiles: string[]; codex_args: string[]; codex_env: EnvironmentVariable[]; command_configs: CommandConfig[]; local_enabled: boolean; codex_enabled: boolean; command_enabled: boolean; agent_toggles_set?: boolean };
export type Host = { id: string; name: string; platform: string; home: string; connected: boolean; created_at: string };
export type SettingsResponse = { settings: AgentSettings; hosts: Host[] };
export type TerminalStatus = { id: string; label: 'local' | 'codex' | 'command'; title: string; workspace: string; running: boolean; busy: boolean; subscribers: number };
export type TerminalStatusResponse = { active_pool: TerminalStatus[] };
export type Session = {
  id: string;
  kind: Kind;
  native_id?: string;
  host_id?: string;
  agent_id?: string;
  yolo?: boolean;
  src?: string;
  source?: string;
  channel?: string;
  title: string;
  workspace: string;
  status: string;
  created_at?: string;
  updated_at?: string;
};

export const activeKindKey = 'jian.active_kind';
export const activeAreaKey = 'jian.active_area';
export const activeLocalSessionKey = 'jian.active_local_session';
export const themeKey = 'jian.theme';
export const interfaceThemeKey = 'jian.interface_theme';
export const terminalThemeKey = 'jian.terminal_theme';
export const terminalFontSizeKey = 'jian.terminal_font_size';
export const terminalFontSizeMin = 10;
export const terminalFontSizeMax = 24;
export const terminalFontSizeDefault = 15;
export const activeSessionKey = (kind: Kind) => `jian.active_${kind}_session`;
export const selectedSessionKey = (session: Pick<LocalSession, 'kind'> | Pick<Session, 'kind'>) => session.kind === 'local' ? activeLocalSessionKey : activeSessionKey(session.kind);
export const sessionCacheKey = (username: string, kind: Kind) => `jian.session_cache.${encodeURIComponent(username)}.${kind}`;
export const navScrollKey = (kind: Kind | 'local', profile: string) => `jian.nav_scroll_${kind}_${profile}`;

export const initialKind = (): Kind => ['codex', 'command'].includes(localStorage.getItem(activeKindKey) || '') ? localStorage.getItem(activeKindKey) as Kind : 'codex';
const readTheme = (key: string): Theme | null => {
  const value = localStorage.getItem(key);
  return value === 'light' || value === 'black' || value === 'console' ? value : null;
};
export const initialInterfaceTheme = (): Theme => readTheme(interfaceThemeKey) || readTheme(themeKey) || 'light';
export const initialTheme = initialInterfaceTheme;
export const clampTerminalFontSize = (value: number) => Math.min(terminalFontSizeMax, Math.max(terminalFontSizeMin, Math.round(value)));
export const initialTerminalFontSize = () => {
  const stored = localStorage.getItem(terminalFontSizeKey);
  const value = stored === null ? NaN : Number(stored);
  return Number.isFinite(value) ? clampTerminalFontSize(value) : terminalFontSizeDefault;
};

export const themeOptions: { id: Theme; label: string; description: string }[] = [
  { id: 'console', label: '深绿主题', description: '深绿信号与低照度工作台' },
  { id: 'light', label: '浅色主题', description: '日间阅读与清晰层级' },
  { id: 'black', label: '深色主题', description: '纯黑背景与中性高对比度' },
];


export const channelNames: Record<string, string> = { weixin: '微信', dingtalk: '钉钉', telegram: 'Telegram', discord: 'Discord', slack: 'Slack', whatsapp: 'WhatsApp', cli: 'CLI', acp: 'ACP', codex: 'Codex' };
export const displayTitle = (session?: { title?: string } | null) => {
  const title = session?.title?.trim() || '无标题';
  return title === '-' || title === '—' ? '无标题' : title;
};
export const rawChannel = (session?: { src?: string; source?: string; channel?: string; kind?: string } | null) => (session?.src || session?.source || session?.channel || (session?.kind === 'codex' ? 'codex' : '')).trim();
export const displayChannel = (session?: Session | null) => `通道：${channelNames[rawChannel(session).toLowerCase()] || rawChannel(session) || '未标注'}`;
export const displayWorkspacePath = (workspace?: string) => {
  const value = workspace?.trim() || '';
  return value === '/home/gaofei' ? '~' : value.startsWith('/home/gaofei/') ? `~${value.slice('/home/gaofei'.length)}` : value;
};
export const displayWorkspace = (session?: { workspace?: string } | null) => `工作目录：${displayWorkspacePath(session?.workspace) || '未知工作区'}`;
export const sessionTime = (session: Session) => Date.parse(session.updated_at || session.created_at || '') || 0;
export const byLastActiveDesc = (a: Session, b: Session) => sessionTime(b) - sessionTime(a);
export const activeView = (session: Session): Session => ({ ...session, title: displayTitle(session) });
export type OpenSession = Session | LocalSession;
export const openSessionKey = (session: OpenSession) =>
  `${session.kind}:${session.id}`;
export const openSessionTitle = (session: OpenSession) => session.kind === 'local' ? session.title || 'Bash' : displayTitle(session);
export const openSessionLabel = (session: Pick<OpenSession, 'kind'>) =>
  ({ local: 'Local', codex: 'Codex', command: '命令' })[session.kind];

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'ended' | 'offline';
export type ConnectionFeedback = { state: ConnectionState; attempt: number; retrying: boolean };
export const connectionView = (state: ConnectionState) => ({
  connecting: { tone: 'idle', label: '正在连接' },
  connected: { tone: 'running', label: '已连接' },
  reconnecting: { tone: 'waiting', label: '正在重连' },
  disconnected: { tone: 'idle', label: '已断开连接' },
  ended: { tone: 'ended', label: '进程已结束' },
  offline: { tone: 'waiting', label: '已离线' },
})[state];
export const statusView = (value?: string) => {
  const normalized = (value || 'unknown').toLowerCase();
  if (normalized === 'running') return { tone: 'running', label: '运行中' };
  if (normalized === 'ended') return { tone: 'ended', label: '已结束' };
  if (normalized === 'busy') return { tone: 'waiting', label: '忙碌中' };
  if (normalized === 'idle') return { tone: 'idle', label: '空闲' };
  if (normalized === 'error') return { tone: 'error', label: '失败' };
  return { tone: 'idle', label: value || '状态未知' };
};

export const mobileMedia = '(max-width: 800px), (max-width: 1199px) and (pointer: coarse)';
export const isMobile = () => window.matchMedia(mobileMedia).matches;
