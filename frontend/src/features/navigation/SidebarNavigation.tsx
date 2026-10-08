import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, LogOut, Menu, Plus, RefreshCw, Search, Settings2, Trash2, X } from 'lucide-react';
import { Dialog, Select, Tabs } from 'radix-ui';
import { SessionList } from '../session-catalog/SessionList';
import { byLastActiveDesc, displayWorkspacePath, navScrollKey, statusView, type Kind, type LocalSession, type Session } from '../../shared/model';
import { AgentIcon } from '../../shared/ui/AgentIcon';

type ActiveSession = Session | LocalSession | null;
type Area = Kind | 'local';
type Props = {
  busy: boolean; creating: boolean; catalogError?: string;
  active: ActiveSession; currentKind: Area; profile: string; profiles: string[]; piAgents?: string[]; sessions: Session[]; localSessions: LocalSession[];
  compact: boolean; navigationOpen: boolean; onNavigationOpenChange: (open: boolean) => void; handingOffFocus: boolean; onAreaChange: (area: Area) => void; onProfileChange: (profile: string) => void;
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

export function SidebarNavigation({ active, currentKind, profile, profiles, piAgents = profiles, sessions, localSessions, compact, navigationOpen, onNavigationOpenChange, handingOffFocus, onAreaChange, onProfileChange, onSelectSession, onSelectLocal, onCreateLocal, onRemoveLocal, onOpenWorkspace, onRefresh, refreshingKind, onSettings, onDialog, onRelease, connectedSessionID, onDisconnect, onOpenSecondary, visibleCount, onShowMore, username, onLogout, settingsOpen, onSettingsPage, busy, creating, catalogError }: Props) {
  const [agentEnabled, setAgentEnabled] = useState({ codex: localStorage.getItem('jian.codex-enabled') !== 'false', hermes: localStorage.getItem('jian.hermes-enabled') !== 'false', pi: localStorage.getItem('jian.pi-enabled') !== 'false' });
  const [query, setQuery] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [listNode, setListNode] = useState<HTMLDivElement | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const restored = useRef<{ key: string; node: HTMLElement } | null>(null);
  useEffect(() => { const update = (event: Event) => { const next = (event as CustomEvent<Partial<typeof agentEnabled>>).detail; setAgentEnabled(next ? { codex: next.codex !== false, hermes: next.hermes !== false, pi: next.pi !== false } : { codex: localStorage.getItem('jian.codex-enabled') !== 'false', hermes: localStorage.getItem('jian.hermes-enabled') !== 'false', pi: localStorage.getItem('jian.pi-enabled') !== 'false' }); }; window.addEventListener('jian-agent-settings', update); return () => window.removeEventListener('jian-agent-settings', update); }, []);
  useEffect(() => setWorkspace(''), [currentKind, profile]);
  const roles = currentKind === 'hermes' ? (profiles.length ? profiles : ['default']) : currentKind === 'pi' ? (piAgents.length ? piAgents : ['default']) : [];
  const rows = useMemo(() => currentKind === 'local' ? [] : rowsFor(sessions, currentKind, currentKind === 'hermes' || currentKind === 'pi' ? profile : undefined), [sessions, currentKind, profile]);
  const workspaces = useMemo(() => Array.from(new Set(rows.map(session => displayWorkspacePath(session.workspace) || '未知工作区'))), [rows]);
  const filtered = rows.filter(session => (workspace === '' || (displayWorkspacePath(session.workspace) || '未知工作区') === workspace) && matches(query, session));
  const filteredLocal = localSessions.filter(session => matches(query, session));
  const scrollKey = navScrollKey(currentKind, currentKind === 'local' ? 'default' : profile);
  const hasRows = (currentKind === 'local' ? localSessions : rows).length > 0;
  useLayoutEffect(() => {
    const node = listNode;
    if (!node || !hasRows || (compact && !navigationOpen) || (restored.current?.node === node && restored.current.key === scrollKey)) return;
    let position = 0;
      try { position = Number(localStorage.getItem(scrollKey)) || 0; } catch {}
      node.scrollTop = Math.max(0, position);
      restored.current = { key: scrollKey, node };
  }, [listNode, compact, navigationOpen, scrollKey, hasRows]);
  const resetScroll = () => {
    if (listNode) listNode.scrollTop = 0;
    try { localStorage.setItem(scrollKey, '0'); } catch {}
  };
  const selectAgent = (area: Area) => { setQuery(''); onAreaChange(area); };
  const create = () => currentKind === 'local' ? onCreateLocal() : onOpenWorkspace(currentKind, currentKind === 'hermes' || currentKind === 'pi' ? profile : undefined);
  const content = <aside className="sidebar">
    <div className="brand"><span className="brand-mark"><Bot /></span><span className="brand-copy"><strong>Jian</strong><small>LOCAL AGENT CONTROL</small></span></div>
    <nav className="agent-rail" aria-label="Agent" inert={busy}>
      <button className={currentKind === 'local' ? 'active' : ''} onClick={() => selectAgent('local')}><AgentIcon /><span>Local</span></button>
      {agentEnabled.codex && <button className={currentKind === 'codex' ? 'active' : ''} onClick={() => selectAgent('codex')}><AgentIcon kind="codex" /><span>Codex</span></button>}
      {agentEnabled.hermes && <button className={currentKind === 'hermes' ? 'active' : ''} onClick={() => selectAgent('hermes')}><AgentIcon kind="hermes" /><span>Hermes</span></button>}
      {agentEnabled.pi && <button className={currentKind === 'pi' ? 'active' : ''} onClick={() => selectAgent('pi')}><AgentIcon kind="pi" /><span>Pi</span></button>}
    </nav>
    <section className="session-catalog" inert={busy} aria-busy={creating}>
      <header className="catalog-header"><div><small>会话</small><strong>{currentKind === 'local' ? 'Local Bash' : currentKind[0].toUpperCase() + currentKind.slice(1)}</strong></div><div><button className="icon" aria-label={`${currentKind} 设置`} title="Agent 设置" onClick={() => onSettings(currentKind)}><Settings2 /></button>{currentKind !== 'local' && <button className="icon" aria-label={`刷新 ${currentKind} 会话`} title="刷新原生会话" disabled={!!refreshingKind} aria-busy={refreshingKind === currentKind} onClick={() => onRefresh(currentKind)}><RefreshCw /></button>}<button className="icon catalog-create" aria-label="新建会话" title="新建会话" onClick={create}><Plus /><span>新建</span></button></div></header>
      {roles.length > 0 && <Tabs.Root value={profile} onValueChange={onProfileChange} activationMode="manual"><Tabs.List className="role-strip" aria-label={currentKind === 'pi' ? 'Pi 角色' : 'Hermes profile'}>{roles.map(role => <Tabs.Trigger key={role} value={role} className={profile === role ? 'active' : ''}>{role}</Tabs.Trigger>)}</Tabs.List></Tabs.Root>}
      <label className="catalog-search"><Search /><input value={query} onChange={event => { resetScroll(); setQuery(event.target.value.trimStart().toLowerCase()); }} placeholder="搜索会话或工作目录" aria-label="搜索会话或工作目录" /></label>
      {workspaces.length > 1 && <div className="catalog-filter"><span>目录</span><Select.Root value={workspace || '__all__'} onValueChange={value => { resetScroll(); setWorkspace(value === '__all__' ? '' : value); }}><Select.Trigger className="catalog-filter-trigger" aria-label="筛选工作目录"><Select.Value /><Select.Icon><ChevronDown /></Select.Icon></Select.Trigger><Select.Portal><Select.Content className="catalog-filter-menu" position="popper" sideOffset={4}><Select.Viewport><Select.Item className="catalog-filter-item" value="__all__"><Select.ItemText>全部工作目录</Select.ItemText><Select.ItemIndicator><Check /></Select.ItemIndicator></Select.Item>{workspaces.map(value => <Select.Item className="catalog-filter-item" key={value} value={value}><Select.ItemText>{value}</Select.ItemText><Select.ItemIndicator><Check /></Select.ItemIndicator></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal></Select.Root></div>}
      {refreshingKind === currentKind && <p className="catalog-feedback" role="status">正在刷新原生会话…</p>}
      {catalogError && <div className="catalog-feedback error" role="alert"><span>{catalogError}</span><button onClick={() => currentKind !== 'local' && onRefresh(currentKind)}>重试</button></div>}
      <div ref={setListNode} className="catalog-list" onScroll={event => {
        if (compact && !navigationOpen) return;
        try { localStorage.setItem(scrollKey, String(event.currentTarget.scrollTop)); } catch {}
      }}>
        {currentKind === 'local' ? <div className="session-list">{filteredLocal.map(session => <div className={'session-row ' + (active?.id === session.id ? 'active' : '')} key={session.id}><button className="session" onClick={() => onSelectLocal(session)}><span className={'session-state ' + statusView(session.status).tone} /><span className="session-copy"><strong title={session.title}>{session.title}</strong><small title={session.workspace}>{displayWorkspacePath(session.workspace)}</small></span></button><button className="icon local-session-remove" aria-label={`删除 ${session.title}`} title="删除会话" onClick={() => onRemoveLocal(session)}><Trash2 /></button></div>)}{!filteredLocal.length && <div className="nav-empty"><span>{query ? '没有匹配的会话' : '暂无本地终端'}</span><small>{query ? '尝试其他关键词，或清除筛选。' : '新建一个 Bash 会话开始工作。'}</small><button onClick={() => query ? setQuery('') : create()}>{query ? '清除筛选' : '新建会话'}</button></div>}</div> : <SessionList searching={!!query || !!workspace} onClearFilter={() => { setQuery(''); setWorkspace(''); resetScroll(); }} rows={filtered} listKind={currentKind} listProfile={profile} activeID={active?.id} connectedID={connectedSessionID} visibleCount={visibleCount(currentKind, `${profile}:${workspace}`)} onSelect={onSelectSession} onDialog={onDialog} onDisconnect={onDisconnect} onRelease={onRelease} onOpenSecondary={onOpenSecondary} onShowMore={() => onShowMore(currentKind, `${profile}:${workspace}`)} />}
      </div>
    </section>
    <div className="user"><span><small>已登录</small>{username}</span><div className="user-actions"><button disabled={busy} className={'icon ' + (settingsOpen ? 'active' : '')} aria-label="设置" title="设置" onClick={onSettingsPage}><Settings2 /></button><button className="icon" aria-label="退出登录" title="退出登录" onClick={onLogout}><LogOut /></button></div></div>
  </aside>;
  if (!compact) return content;
  return <Dialog.Root open={navigationOpen} onOpenChange={onNavigationOpenChange}>
    <Dialog.Trigger asChild><button type="button" className="icon mobile-nav-toggle" aria-label="打开导航"><Menu /></button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="nav-scrim" />
      <Dialog.Content ref={drawerRef} className="nav-drawer" aria-describedby={undefined}
        onOpenAutoFocus={event => { event.preventDefault(); drawerRef.current?.querySelector<HTMLButtonElement>('.nav-drawer-close')?.focus({ preventScroll: true }); }}
        onCloseAutoFocus={event => { if (handingOffFocus) { event.preventDefault(); document.querySelector<HTMLButtonElement>('.settings-back')?.focus({ preventScroll: true }); } else { const dock = document.querySelector<HTMLButtonElement>('.mobile-workbench-dock button[aria-label="更多工作台操作"]'); if (dock) { event.preventDefault(); dock.focus({ preventScroll: true }); } } }}>
        <Dialog.Title className="nav-dialog-title">会话导航</Dialog.Title>
        <Dialog.Close asChild><button type="button" className="icon mobile-nav-toggle nav-drawer-close" aria-label="关闭导航"><X /></button></Dialog.Close>
        {content}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
