export type Kind = 'codex' | 'hermes' | 'pi';
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
export type AgentSettings = { codex_bin: string; path: string; hermes_home: string; hermes_bin: string; hermes_profiles: string[]; pi_bin: string; pi_agents: string[]; pi_args: string[]; pi_env: EnvironmentVariable[]; local_profiles: string[]; codex_args: string[]; hermes_args: string[]; codex_env: EnvironmentVariable[]; hermes_env: EnvironmentVariable[]; local_enabled: boolean; codex_enabled: boolean; hermes_enabled: boolean; pi_enabled: boolean; agent_toggles_set?: boolean };
export type SettingsResponse = { settings: AgentSettings; available_profiles: string[]; available_pi_agents: string[] };
export type TerminalStatus = { id: string; label: 'local' | 'codex' | 'hermes' | 'pi'; title: string; workspace: string; profile?: string; running: boolean; busy: boolean; subscribers: number };
export type TerminalStatusResponse = { active_pool: TerminalStatus[] };
export type Session = {
  id: string;
  kind: Kind;
  native_id?: string;
  profile?: string;
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
export const activeProfileKey = 'jian.active_hermes_profile';
export const activeLocalSessionKey = 'jian.active_local_session';
export const themeKey = 'jian.theme';
export const interfaceThemeKey = 'jian.interface_theme';
export const terminalThemeKey = 'jian.terminal_theme';
export const terminalFontSizeKey = 'jian.terminal_font_size';
export const terminalFontSizeMin = 10;
export const terminalFontSizeMax = 24;
export const terminalFontSizeDefault = 15;
export const activeSessionKey = (kind: Kind, profile?: string) => `jian.active_${kind}${kind === 'hermes' && profile ? `_${profile}` : ''}_session`;
export const selectedSessionKey = (session: Pick<LocalSession, 'kind'> | Pick<Session, 'kind' | 'profile'>, fallbackProfile = 'default') => session.kind === 'local' ? activeLocalSessionKey : activeSessionKey(session.kind, session.profile || fallbackProfile);
export const sessionCacheKey = (username: string, kind: Kind) => `jian.session_cache.${encodeURIComponent(username)}.${kind}`;
export const navScrollKey = (kind: Kind, profile: string) => `jian.nav_scroll_${kind}_${profile}`;

export const initialKind = (): Kind => ['codex', 'hermes', 'pi'].includes(localStorage.getItem(activeKindKey) || '') ? localStorage.getItem(activeKindKey) as Kind : 'codex';
const readTheme = (key: string): Theme | null => {
  const value = localStorage.getItem(key);
  return value === 'light' || value === 'black' || value === 'console' ? value : null;
};
export const initialInterfaceTheme = (): Theme => readTheme(interfaceThemeKey) || readTheme(themeKey) || 'console';
export const initialTheme = initialInterfaceTheme;
export const clampTerminalFontSize = (value: number) => Math.min(terminalFontSizeMax, Math.max(terminalFontSizeMin, Math.round(value)));
export const initialTerminalFontSize = () => {
  const stored = localStorage.getItem(terminalFontSizeKey);
  const value = stored === null ? NaN : Number(stored);
  return Number.isFinite(value) ? clampTerminalFontSize(value) : terminalFontSizeDefault;
};

export const themeOptions: { id: Theme; label: string; description: string }[] = [
  { id: 'console', label: '默认主题', description: '深绿信号与低照度工作台' },
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
export const displayWorkspace = (session?: { workspace?: string } | null) => `工作目录：${session?.workspace?.trim() || '未知工作区'}`;
export const sessionTime = (session: Session) => Date.parse(session.updated_at || session.created_at || '') || 0;
export const byLastActiveDesc = (a: Session, b: Session) => sessionTime(b) - sessionTime(a);
export const activeView = (session: Session): Session => ({ ...session, title: displayTitle(session) });
export const statusView = (value?: string) => {
  const normalized = (value || 'idle').toLowerCase();
  if (normalized === 'running' || normalized.includes('连接') || normalized.includes('恢复') || normalized.includes('加载')) return { tone: 'running', label: normalized === 'running' ? '运行中' : value! };
  if (normalized === 'ended' || normalized.includes('结束')) return { tone: 'ended', label: '已结束' };
  if (normalized.includes('失败') || normalized.includes('错误')) return { tone: 'error', label: value! };
  return { tone: 'idle', label: normalized === 'idle' ? '未启动' : value! };
};

export const isMobile = () => window.matchMedia('(max-width: 800px)').matches;
