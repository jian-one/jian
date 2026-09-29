import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Bot, Check, ChevronDown, LogOut, Plus, RefreshCw, Search, Settings2, Trash2 } from 'lucide-react';
import { Select } from 'radix-ui';
import { SessionList } from '../session-catalog/SessionList';
import { byLastActiveDesc, displayWorkspacePath, statusView, type Kind, type LocalSession, type Session } from '../../shared/model';
import { AgentIcon } from '../../shared/ui/AgentIcon';

type ActiveSession = Session | LocalSession | null;
type Area = Kind | 'local';
type Props = {
  active: ActiveSession; currentKind: Area; profile: string; profiles: string[]; piAgents?: string[]; sessions: Session[]; localSessions: LocalSession[];
  sidebarRef: RefObject<HTMLElement | null>; onScroll: (scrollTop: number) => void; onAreaChange: (area: Area) => void; onProfileChange: (profile: string) => void;
  onSelectSession: (session: Session) => void; onSelectLocal: (session: LocalSession) => void; onCreateLocal: () => void; onRemoveLocal: (session: LocalSession) => void;
  onOpenWorkspace: (kind: Kind, profile?: string) => void; onRefresh: (kind: Kind) => void; refreshingKind?: Kind | null; onSettings: (kind: Area) => void;
  onDialog: (mode: 'rename' | 'delete', session: Session) => void; onRelease: (session: Session) => void; connectedSessionID?: string | null; onDisconnect: (session: Session) => void;
  onOpenSecondary: (session: Session) => void;
  visibleCount: (kind: Kind, profile?: string) => number; onShowMore: (kind: Kind, profile?: string) => void; username: string; onLogout: () => void; settingsOpen: boolean; onSettingsPage: () => void;
};

const rowsFor = (sessions: Session[], kind: Kind, profile?: string) => sessions
  .filter(session => session.kind === kind && (kind !== 'hermes' && kind !== 'pi' || (session.profile || 'default') === profile) && session.title.trim().toLowerCase() !== `new ${kind} session`)
  .sort(byLastActiveDesc);
const matches = (query: string, value: { title: string; workspace: string; id: string }) => !query || `${value.title} ${value.workspace} ${value.id}`.toLowerCase().includes(query);

export function SidebarNavigation({ active, currentKind, profile, profiles, piAgents = profiles, sessions, localSessions, sidebarRef, onScroll, onAreaChange, onProfileChange, onSelectSession, onSelectLocal, onCreateLocal, onRemoveLocal, onOpenWorkspace, onRefresh, refreshingKind, onSettings, onDialog, onRelease, connectedSessionID, onDisconnect, onOpenSecondary, visibleCount, onShowMore, username, onLogout, settingsOpen, onSettingsPage }: Props) {
  const [agentEnabled, setAgentEnabled] = useState({ codex: localStorage.getItem('jian.codex-enabled') !== 'false', hermes: localStorage.getItem('jian.hermes-enabled') !== 'false', pi: localStorage.getItem('jian.pi-enabled') !== 'false' });
  const [query, setQuery] = useState('');
  const [workspace, setWorkspace] = useState('');
  useEffect(() => { const update = (event: Event) => { const next = (event as CustomEvent<Partial<typeof agentEnabled>>).detail; setAgentEnabled(next ? { codex: next.codex !== false, hermes: next.hermes !== false, pi: next.pi !== false } : { codex: localStorage.getItem('jian.codex-enabled') !== 'false', hermes: localStorage.getItem('jian.hermes-enabled') !== 'false', pi: localStorage.getItem('jian.pi-enabled') !== 'false' }); }; window.addEventListener('jian-agent-settings', update); return () => window.removeEventListener('jian-agent-settings', update); }, []);
  useEffect(() => setWorkspace(''), [currentKind, profile]);
  const roles = currentKind === 'hermes' ? (profiles.length ? profiles : ['default']) : currentKind === 'pi' ? (piAgents.length ? piAgents : ['default']) : [];
  const rows = useMemo(() => currentKind === 'local' ? [] : rowsFor(sessions, currentKind, currentKind === 'hermes' || currentKind === 'pi' ? profile : undefined), [sessions, currentKind, profile]);
  const workspaces = useMemo(() => Array.from(new Set(rows.map(session => displayWorkspacePath(session.workspace) || '未知工作区'))), [rows]);
  const filtered = rows.filter(session => (workspace === '' || (displayWorkspacePath(session.workspace) || '未知工作区') === workspace) && matches(query, session));
  const filteredLocal = localSessions.filter(session => matches(query, session));
  const selectAgent = (area: Area) => { setQuery(''); onAreaChange(area); };
  const create = () => currentKind === 'local' ? onCreateLocal() : onOpenWorkspace(currentKind, currentKind === 'hermes' || currentKind === 'pi' ? profile : undefined);
  return <aside ref={sidebarRef} className="sidebar" onScroll={event => onScroll(event.currentTarget.scrollTop)}>
    <div className="brand"><span className="brand-mark"><Bot /></span><span className="brand-copy"><strong>Jian</strong><small>LOCAL AGENT CONTROL</small></span></div>
    <nav className="agent-rail" aria-label="Agent">
      <button className={currentKind === 'local' ? 'active' : ''} onClick={() => selectAgent('local')}><AgentIcon /><span>Local</span></button>
      {agentEnabled.codex && <button className={currentKind === 'codex' ? 'active' : ''} onClick={() => selectAgent('codex')}><AgentIcon kind="codex" /><span>Codex</span></button>}
      {agentEnabled.hermes && <button className={currentKind === 'hermes' ? 'active' : ''} onClick={() => selectAgent('hermes')}><AgentIcon kind="hermes" /><span>Hermes</span></button>}
      {agentEnabled.pi && <button className={currentKind === 'pi' ? 'active' : ''} onClick={() => selectAgent('pi')}><AgentIcon kind="pi" /><span>Pi</span></button>}
    </nav>
    <section className="session-catalog">
      <header className="catalog-header"><div><small>AGENT</small><strong>{currentKind === 'local' ? 'Local Bash' : currentKind[0].toUpperCase() + currentKind.slice(1)}</strong></div><div><button className="icon" aria-label={`${currentKind} 设置`} title="Agent 设置" onClick={() => onSettings(currentKind)}><Settings2 /></button>{currentKind !== 'local' && <button className="icon" aria-label={`刷新 ${currentKind} 会话`} title="刷新原生会话" disabled={!!refreshingKind} aria-busy={refreshingKind === currentKind} onClick={() => onRefresh(currentKind)}><RefreshCw /></button>}<button className="icon catalog-create" aria-label="新建会话" title="新建会话" onClick={create}><Plus /></button></div></header>
      {roles.length > 0 && <div className="role-strip" role="tablist" aria-label={currentKind === 'pi' ? 'Pi 角色' : 'Hermes profile'}>{roles.map(role => <button key={role} role="tab" aria-selected={profile === role} className={profile === role ? 'active' : ''} onClick={() => onProfileChange(role)}>{role}</button>)}</div>}
      <label className="catalog-search"><Search /><input value={query} onChange={event => setQuery(event.target.value.trimStart().toLowerCase())} placeholder="搜索会话或工作目录" aria-label="搜索会话或工作目录" /></label>
      {workspaces.length > 1 && <div className="catalog-filter"><span>目录</span><Select.Root value={workspace || '__all__'} onValueChange={value => setWorkspace(value === '__all__' ? '' : value)}><Select.Trigger className="catalog-filter-trigger" aria-label="筛选工作目录"><Select.Value /><Select.Icon><ChevronDown /></Select.Icon></Select.Trigger><Select.Portal><Select.Content className="catalog-filter-menu" position="popper" sideOffset={4}><Select.Viewport><Select.Item className="catalog-filter-item" value="__all__"><Select.ItemText>全部工作目录</Select.ItemText><Select.ItemIndicator><Check /></Select.ItemIndicator></Select.Item>{workspaces.map(value => <Select.Item className="catalog-filter-item" key={value} value={value}><Select.ItemText>{value}</Select.ItemText><Select.ItemIndicator><Check /></Select.ItemIndicator></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal></Select.Root></div>}
      <div className="catalog-list">
        {currentKind === 'local' ? <div className="session-list">{filteredLocal.map(session => <div className={'session-row ' + (active?.id === session.id ? 'active' : '')} key={session.id}><button className="session" onClick={() => onSelectLocal(session)}><span className={'session-state ' + (connectedSessionID === session.id ? statusView('running').tone : statusView(session.status).tone)} /><span className="session-copy"><strong title={session.title}>{session.title}</strong><small title={session.workspace}>{displayWorkspacePath(session.workspace)}</small></span></button><button className="icon local-session-remove" aria-label={`删除 ${session.title}`} title="删除会话" onClick={() => onRemoveLocal(session)}><Trash2 /></button></div>)}{!filteredLocal.length && <div className="nav-empty"><span>{query ? '没有匹配的会话' : '暂无本地终端'}</span><small>新建一个 Bash 会话</small></div>}</div> : <SessionList rows={filtered} listKind={currentKind} listProfile={profile} activeID={active?.id} connectedID={connectedSessionID} visibleCount={visibleCount(currentKind, `${profile}:${workspace}`)} onSelect={onSelectSession} onDialog={onDialog} onDisconnect={onDisconnect} onRelease={onRelease} onOpenSecondary={onOpenSecondary} onShowMore={() => onShowMore(currentKind, `${profile}:${workspace}`)} />}
      </div>
    </section>
    <div className="user"><span><small>已登录</small>{username}</span><div className="user-actions"><button className={'icon ' + (settingsOpen ? 'active' : '')} aria-label="设置" title="设置" onClick={onSettingsPage}><Settings2 /></button><button className="icon" aria-label="退出登录" title="退出登录" onClick={onLogout}><LogOut /></button></div></div>
  </aside>;
}
