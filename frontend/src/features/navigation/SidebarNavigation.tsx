import { useEffect, useState, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { NavigationMenu } from 'radix-ui';
import { Bot, ChevronDown, LogOut, Plus, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { SessionList } from '../session-catalog/SessionList';
import { byLastActiveDesc, statusView, type Kind, type LocalSession, type Session } from '../../shared/model';
import { AgentIcon } from '../../shared/ui/AgentIcon';

type ActiveSession = Session | LocalSession | null;
type Area = Kind | 'local';

type Props = {
  active: ActiveSession;
  currentKind: Kind | 'local';
  profile: string;
  profiles: string[];
  sessions: Session[];
  localSessions: LocalSession[];
  sidebarRef: RefObject<HTMLElement | null>;
  onScroll: (scrollTop: number) => void;
  onAreaChange: (area: Area) => void;
  onProfileChange: (profile: string) => void;
  onSelectSession: (session: Session) => void;
  onSelectLocal: (session: LocalSession) => void;
  onCreateLocal: () => void;
  onRemoveLocal: (session: LocalSession) => void;
  onOpenWorkspace: (kind: Kind, profile?: string) => void;
  onRefresh: (kind: Kind) => void;
  refreshingKind?: Kind | null;
  onSettings: (kind: Kind | 'local') => void;
  onDialog: (mode: 'rename' | 'delete', session: Session) => void;
  connectedSessionID?: string | null;
  onDisconnect: (session: Session) => void;
  visibleCount: (kind: Kind, profile?: string) => number;
  onShowMore: (kind: Kind, profile?: string) => void;
  username: string;
  onLogout: () => void;
  settingsOpen: boolean;
  onSettingsPage: () => void;
};

const rowsFor = (sessions: Session[], kind: Kind, profile?: string) => sessions
  .filter(session => session.kind === kind && (kind !== 'hermes' || (session.profile || 'default') === profile) && session.title.trim().toLowerCase() !== `new ${kind} session`)
  .sort(byLastActiveDesc);
const preventHoverOpen = (event: PointerEvent<HTMLButtonElement>) => event.preventDefault();
const preventEscapeDismiss = (event: KeyboardEvent) => event.preventDefault();

type MenuTriggerProps = {
  icon?: ReactNode;
  children: ReactNode;
  variant?: 'primary' | 'profile';
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
};

/** Keeps Radix's focus proxy inside one grid cell and shares trigger behavior. */
function MenuTrigger({ icon, children, variant = 'primary', onClick }: MenuTriggerProps) {
  return <div className="navigation-trigger-slot">
    <NavigationMenu.Trigger className={`navigation-trigger navigation-trigger-${variant}`} onClick={onClick} onPointerMove={preventHoverOpen} onPointerLeave={event => event.preventDefault()}>
      {icon}{children}<ChevronDown />
    </NavigationMenu.Trigger>
  </div>;
}

type PrimaryNavigationItemProps = {
  value: Area;
  label: string;
  icon: ReactNode;
  selected: boolean;
  actions: ReactNode;
  children: ReactNode;
};

/** A primary section keeps its content open until the user explicitly toggles it. */
function PrimaryNavigationItem({ value, label, icon, selected, actions, children }: PrimaryNavigationItemProps) {
  return <NavigationMenu.Item value={value} className="navigation-menu-item">
    <div className={'navigation-menu-row ' + (selected ? 'selected' : '')}>
      <MenuTrigger icon={icon}><span className="navigation-trigger-label" title={label}>{label}</span></MenuTrigger>
      {actions}
    </div>
    <NavigationMenu.Content className="navigation-menu-content" onEscapeKeyDown={preventEscapeDismiss} onPointerLeave={event => event.preventDefault()} onFocusOutside={event => event.preventDefault()} onPointerDownOutside={event => event.preventDefault()}>
      {children}
    </NavigationMenu.Content>
  </NavigationMenu.Item>;
}

/**
 * The sidebar has one interaction owner: Radix Navigation Menu. It owns group
 * disclosure and keyboard navigation; callers only provide session data and commands.
 */
export function SidebarNavigation({ active, currentKind, profile, profiles, sessions, localSessions, sidebarRef, onScroll, onAreaChange, onProfileChange, onSelectSession, onSelectLocal, onCreateLocal, onRemoveLocal, onOpenWorkspace, onRefresh, refreshingKind, onSettings, onDialog, connectedSessionID, onDisconnect, visibleCount, onShowMore, username, onLogout, settingsOpen, onSettingsPage }: Props) {
  const areaFromActive: Area = currentKind;
  const [agentEnabled, setAgentEnabled] = useState({ codex: localStorage.getItem('jian.codex-enabled') !== 'false', hermes: localStorage.getItem('jian.hermes-enabled') !== 'false' });
  useEffect(() => { const refreshAgentEnabled = () => setAgentEnabled({ codex: localStorage.getItem('jian.codex-enabled') !== 'false', hermes: localStorage.getItem('jian.hermes-enabled') !== 'false' }); window.addEventListener('jian-agent-settings', refreshAgentEnabled); return () => window.removeEventListener('jian-agent-settings', refreshAgentEnabled); }, []);
  const [value, setValue] = useState<Area | ''>(areaFromActive);
  const [profileValue, setProfileValue] = useState(profile);
  const [codexWorkspaceValue, setCodexWorkspaceValue] = useState('');

  useEffect(() => setValue(currentKind), [currentKind]);
  useEffect(() => setProfileValue(profile), [profile]);

  const selectArea = (next: string) => {
    setValue(next as Area | '');
    if (next === 'local' || next === 'codex' || next === 'hermes') onAreaChange(next);
  };
  const selectProfile = (next: string) => {
    setProfileValue(next);
    if (next) onProfileChange(next);
  };
  const toggleProfile = (next: string) => {
    const toggledValue = next === profileValue ? '' : next;
    setProfileValue(toggledValue);
    if (toggledValue) onProfileChange(toggledValue);
  };
  const profileRows = profiles.length ? profiles : ['default'];
  const codexRows = rowsFor(sessions, 'codex');
  const codexWorkspaces = Array.from(new Set(codexRows.map(session => session.workspace || '未知工作区')));
  const toggleCodexWorkspace = (workspace: string) => setCodexWorkspaceValue(value => value === workspace ? '' : workspace);

  return <aside ref={sidebarRef} className="sidebar" onScroll={event => onScroll(event.currentTarget.scrollTop)}>
    <div className="brand"><span className="brand-mark"><Bot /></span><span className="brand-copy"><strong>Jian</strong><small>LOCAL AGENT CONTROL</small></span></div>
    <NavigationMenu.Root className="navigation-menu" data-refreshing={refreshingKind || undefined} orientation="vertical" value={value} onValueChange={selectArea} delayDuration={0} skipDelayDuration={0}>
      <NavigationMenu.List className="navigation-menu-list">
        <PrimaryNavigationItem value="local" label="Local" icon={<AgentIcon />} selected={currentKind === 'local'} actions={<div className="navigation-menu-actions"><button className="icon" aria-label="Local 设置" title="Local 设置" onClick={() => onSettings('local')}><Settings2 /></button><button className="icon" aria-label="新建本地 Bash 会话" title="新建会话" onClick={onCreateLocal}><Plus /></button></div>}>
            <section className="nav-sessions"><header><span>本地终端</span><button className="icon" aria-label="新建本地 Bash 会话" title="新建会话" onClick={onCreateLocal}><Plus /></button></header><div className="session-list">
              {localSessions.map(session => <div className={'session-row ' + (active?.id === session.id ? 'active' : '')} key={session.id}><button className="session" onClick={() => onSelectLocal(session)}><span className={'session-state ' + (connectedSessionID === session.id ? statusView('running').tone : statusView(session.status).tone)} /><span className="session-copy"><strong title={session.title}>{session.title}</strong><small title={session.workspace}>{session.workspace}</small><small title="Bash">Bash</small></span></button><button className="icon local-session-remove" aria-label={`删除 ${session.title}`} title="删除会话" onClick={() => onRemoveLocal(session)}><Trash2 /></button></div>)}
              {!localSessions.length && <div className="nav-empty"><span>暂无本地终端</span><small>新建一个 Bash 会话</small></div>}
            </div></section>
        </PrimaryNavigationItem>

        {agentEnabled.codex && <PrimaryNavigationItem value="codex" label="Codex" icon={<AgentIcon kind="codex" />} selected={currentKind === 'codex'} actions={<div className="navigation-menu-actions"><button className="icon" aria-label="Codex 设置" title="Codex 设置" onClick={() => onSettings('codex')}><Settings2 /></button><button className="icon" aria-label="刷新 Codex 会话" title="刷新 Codex 会话" disabled={!!refreshingKind} aria-busy={refreshingKind === 'codex'} onClick={() => onRefresh('codex')}><RefreshCw /></button></div>}>
	          <section className="nav-sessions"><header><span>按工作目录</span><button className="icon" aria-label="新建 Codex 会话" title="新建会话" onClick={() => onOpenWorkspace('codex')}><Plus /></button></header><NavigationMenu.Sub className="workspace-navigation secondary-navigation" value={codexWorkspaceValue} onValueChange={setCodexWorkspaceValue} orientation="vertical"><NavigationMenu.List className="workspace-navigation-list secondary-navigation-list">{codexWorkspaces.map(workspace => <NavigationMenu.Item key={workspace} value={workspace} className="workspace-navigation-item secondary-navigation-item"><MenuTrigger variant="profile" onClick={event => { event.preventDefault(); toggleCodexWorkspace(workspace); }}><span className="secondary-navigation-label"><small>WORKSPACE</small><strong title={workspace}>{workspace}</strong></span></MenuTrigger><NavigationMenu.Content className="workspace-navigation-content secondary-navigation-content" onEscapeKeyDown={preventEscapeDismiss} onFocusOutside={event => event.preventDefault()} onPointerDownOutside={event => event.preventDefault()}><section className="nav-sessions nested-nav-sessions"><SessionList rows={codexRows.filter(session => (session.workspace || '未知工作区') === workspace)} listKind="codex" listProfile={workspace} activeID={active?.id} connectedID={connectedSessionID} visibleCount={visibleCount('codex', workspace)} onSelect={onSelectSession} onDialog={onDialog} onDisconnect={onDisconnect} onShowMore={() => onShowMore('codex', workspace)} /></section></NavigationMenu.Content></NavigationMenu.Item>)}</NavigationMenu.List></NavigationMenu.Sub>{!codexWorkspaces.length && <div className="nav-empty"><span>暂无会话</span><small>从右侧工作区新建一个 Codex 会话</small></div>}</section>
        </PrimaryNavigationItem>}

        {agentEnabled.hermes && <PrimaryNavigationItem value="hermes" label="Hermes" icon={<AgentIcon kind="hermes" />} selected={currentKind === 'hermes'} actions={<div className="navigation-menu-actions"><button className="icon" aria-label="Hermes 设置" title="Hermes 设置" onClick={() => onSettings('hermes')}><Settings2 /></button><button className="icon" aria-label="刷新 Hermes 会话" title="刷新 Hermes 会话" disabled={!!refreshingKind} aria-busy={refreshingKind === 'hermes'} onClick={() => onRefresh('hermes')}><RefreshCw /></button></div>}>
          <NavigationMenu.Sub className="profile-navigation secondary-navigation" value={profileValue} onValueChange={selectProfile} orientation="vertical"><NavigationMenu.List className="profile-navigation-list secondary-navigation-list">
	            {profileRows.map(item => <NavigationMenu.Item key={item} value={item} className="profile-navigation-item secondary-navigation-item"><MenuTrigger variant="profile" onClick={event => { event.preventDefault(); toggleProfile(item); }}><span className="profile-navigation-label secondary-navigation-label"><small>PROFILE</small><strong title={item}>{item}</strong></span></MenuTrigger><NavigationMenu.Content className="profile-navigation-content secondary-navigation-content" onEscapeKeyDown={preventEscapeDismiss} onFocusOutside={event => event.preventDefault()} onPointerDownOutside={event => event.preventDefault()}><section className="nav-sessions"><header><span>会话目录</span><button className="icon" aria-label={`在 ${item} 中新建 Hermes 会话`} title="新建会话" onClick={() => onOpenWorkspace('hermes', item)}><Plus /></button></header><SessionList rows={rowsFor(sessions, 'hermes', item)} listKind="hermes" listProfile={item} activeID={active?.id} connectedID={connectedSessionID} visibleCount={visibleCount('hermes', item)} onSelect={onSelectSession} onDialog={onDialog} onDisconnect={onDisconnect} onShowMore={() => onShowMore('hermes', item)} /></section></NavigationMenu.Content></NavigationMenu.Item>)}
          </NavigationMenu.List></NavigationMenu.Sub>
        </PrimaryNavigationItem>}
      </NavigationMenu.List>
    </NavigationMenu.Root>
    <div className="user"><span><small>已登录</small>{username}</span><div className="user-actions"><button className={'icon ' + (settingsOpen ? 'active' : '')} aria-label="设置" title="设置" onClick={onSettingsPage}><Settings2 /></button><button className="icon" aria-label="退出登录" title="退出登录" onClick={onLogout}><LogOut /></button></div></div>
  </aside>;
}
