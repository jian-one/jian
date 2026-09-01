import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Ellipsis, Info, MonitorCog, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { Accordion, Switch } from 'radix-ui';
import { type AgentSettings, type Theme, type TerminalStatus, type TerminalStatusResponse } from '../../shared/model';
import { initialTerminalFontSize } from '../../shared/model';
import { api, errorMessage } from '../../shared/api';
import { MenuPopup } from '../../shared/ui/Popup';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { ErrorDialog } from '../../shared/ui/ErrorDialog';
import { AgentIcon } from '../../shared/ui/AgentIcon';
import { EnvironmentVariables } from '../../shared/ui/EnvironmentVariables';
import { ProfileFilePicker } from '../../shared/ui/ProfileFilePicker';
import { ThemeControls } from '../../shared/ui/ThemeControls';
import { TerminalFontSizeControl } from '../../shared/ui/TerminalFontSizeControl';
import type { TerminalTheme } from '../terminal/themes';
import { agentEnabled, normalizeAgentSettings, parseExpandedRoster, withAgentEnabled, type AgentKind, type RosterKind } from './settings-model';
import packageInfo from '../../../package.json';

type Section = 'general' | 'terminal' | 'about';
type Props = { theme: Theme; onThemeChange: (theme: Theme) => void; terminalTheme: TerminalTheme; onTerminalThemeChange: (theme: TerminalTheme) => void; terminalFontSize?: number; onTerminalFontSizeChange?: (size: number) => void; onAgentEnabledChange?: (kind: AgentKind, enabled: boolean) => Promise<void> };
const sections: { id: Section; label: string; icon: typeof SlidersHorizontal }[] = [
  { id: 'general', label: '通用', icon: SlidersHorizontal },
  { id: 'terminal', label: 'Terminal', icon: MonitorCog },
  { id: 'about', label: '关于', icon: Info },
];

function LaunchArguments({ kind, settings, setSettings }: { kind: AgentKind; settings: AgentSettings; setSettings: (update: (value: AgentSettings) => AgentSettings) => void }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const key = `${kind}_args` as 'codex_args' | 'hermes_args' | 'pi_args';
  const args = settings[key] || [];
  const update = (index: number, argument: string) => setSettings(value => ({ ...value, [key]: value[key].map((item, itemIndex) => itemIndex === index ? argument : item) }));
  const add = () => { const index = args.length; setSettings(value => ({ ...value, [key]: [...value[key], ''] })); requestAnimationFrame(() => refs.current[index]?.focus()); };
  return <fieldset className="profile-settings launch-arguments"><legend>启动参数</legend><small>每项为一个独立参数，保存后应用于新建和重启的会话。</small><div className="launch-argument-list">{args.map((argument, index) => <div key={index}><input ref={element => { refs.current[index] = element; }} value={argument} onChange={event => update(index, event.target.value)} placeholder="例如 --model 或 gpt-5" aria-label={`启动参数 ${index + 1}`} /><button type="button" className="icon" aria-label={`移除启动参数 ${index + 1}`} title="移除参数" onClick={() => setSettings(value => ({ ...value, [key]: value[key].filter((_, itemIndex) => itemIndex !== index) }))}><Trash2 /></button></div>)}</div><button type="button" className="icon launch-argument-add" onClick={add} aria-label="添加启动参数" title="添加启动参数"><Plus /></button></fieldset>;
}

function AgentRosterItem({ kind, settings, username, availableProfiles, save, setSettings }: { kind: RosterKind; settings: AgentSettings; username: string; availableProfiles: string[]; save: (kind: RosterKind, enabled: boolean) => Promise<void>; setSettings: (update: (value: AgentSettings) => AgentSettings) => void }) {
  const enabled = kind === 'local' || agentEnabled(settings, kind);
  const label = kind === 'local' ? 'Local' : kind === 'codex' ? 'Codex' : kind === 'hermes' ? 'Hermes' : 'Pi';
  const [profilePicking, setProfilePicking] = useState(false);
  const toggle = (next: boolean) => void save(kind, next);
  const field = (key: 'codex_bin' | 'path' | 'hermes_home' | 'hermes_bin' | 'pi_default', fieldLabel: string, hint: string) => <label className="setting-field"><span>{fieldLabel}<small>{hint}</small></span><input value={settings[key] || ''} onChange={event => setSettings(value => ({ ...value, [key]: event.target.value }))} /></label>;
  const toggleProfile = (profile: string) => setSettings(value => ({ ...value, hermes_profiles: value.hermes_profiles.includes(profile) ? value.hermes_profiles.filter(item => item !== profile) : [...value.hermes_profiles, profile] }));
  const environmentVariables = kind !== 'local' && <EnvironmentVariables values={settings[`${kind}_env` as 'codex_env' | 'hermes_env' | 'pi_env'] || []} onChange={values => setSettings(value => ({ ...value, [`${kind}_env`]: values }))} />;
  const localProfiles = <><fieldset className="profile-settings local-profile-settings"><legend>自动加载的 profile 文件</legend><small>第一个文件固定为 ~/.bashrc，不能删除。</small><div className="local-profile-list">{settings.local_profiles.map((path, index) => <div key={path}><span title={path}>{path}</span>{index === 0 ? <small>固定</small> : <button type="button" className="icon" aria-label={`移除 ${path}`} title="移除文件" onClick={() => setSettings(value => ({ ...value, local_profiles: value.local_profiles.filter(item => item !== path) }))}><Trash2 /></button>}</div>)}</div><div className="local-profile-add"><button type="button" className="icon" aria-label="添加 profile 文件" title="添加 profile 文件" onClick={() => setProfilePicking(true)}><Plus /></button></div></fieldset>{profilePicking && <ProfileFilePicker open onOpenChange={setProfilePicking} select={path => { setSettings(value => value.local_profiles.includes(path) ? value : { ...value, local_profiles: [...value.local_profiles, path] }); setProfilePicking(false); }} />}</>;
  const roleFields = <fieldset className="profile-settings"><legend>角色</legend><small>名称、入口路径和角色主目录均为必填。</small>{settings.pi_roles.map((role, index) => <div className="launch-argument-list" key={`${role.name}-${index}`}><input required placeholder="角色名称" value={role.name} onChange={event => setSettings(value => ({ ...value, pi_roles: value.pi_roles.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) }))} /><input required placeholder="入口路径" value={role.entry} onChange={event => setSettings(value => ({ ...value, pi_roles: value.pi_roles.map((item, itemIndex) => itemIndex === index ? { ...item, entry: event.target.value } : item) }))} /><input required placeholder="角色主目录" value={role.home} onChange={event => setSettings(value => ({ ...value, pi_roles: value.pi_roles.map((item, itemIndex) => itemIndex === index ? { ...item, home: event.target.value } : item) }))} /><button type="button" className="icon" aria-label={`移除角色 ${role.name || index + 1}`} onClick={() => setSettings(value => ({ ...value, pi_roles: value.pi_roles.filter((_, itemIndex) => itemIndex !== index) }))}><Trash2 /></button></div>)}<button type="button" className="icon launch-argument-add" aria-label="添加角色" onClick={() => setSettings(value => ({ ...value, pi_roles: [...value.pi_roles, { name: '', entry: '', home: '' }] }))}><Plus /></button></fieldset>;
  return <Accordion.Item className="agent-roster-item" value={kind}><div className="agent-toggle-row"><Accordion.Header><Accordion.Trigger className="agent-roster-trigger" aria-label={`${label}设置，展开或收起详细配置`}><span className="agent-toggle-copy"><AgentIcon kind={kind === 'local' ? 'local' : kind} /><strong>{label}</strong></span><ChevronDown className="agent-roster-chevron" aria-hidden="true" /></Accordion.Trigger></Accordion.Header><Switch.Root className="agent-switch" checked={enabled} disabled={kind === 'local'} onCheckedChange={kind === 'local' ? undefined : toggle} aria-label={kind === 'local' ? 'Local 已激活' : `启用 ${label}`}><Switch.Thumb className="agent-switch-thumb" /></Switch.Root></div><Accordion.Content className="agent-roster-content"><div className="agent-roster-fields">{kind === 'local' ? <>{localProfiles}</> : kind === 'codex' ? <>{field('codex_bin', 'CODEX_BIN', 'Codex 可执行文件路径')}{environmentVariables}<LaunchArguments kind="codex" settings={settings} setSettings={setSettings} /></> : kind === 'hermes' ? <>{field('hermes_home', 'HERMES_HOME', 'Hermes 配置与 profile 根目录')}{field('hermes_bin', 'HERMES_BIN', 'Hermes 可执行文件路径')}{environmentVariables}<LaunchArguments kind="hermes" settings={settings} setSettings={setSettings} /></> : <>{field('pi_default', 'default', '默认 Pi 命令完整路径')}{environmentVariables}<LaunchArguments kind="pi" settings={settings} setSettings={setSettings} />{roleFields}</>}</div><footer><button onClick={() => void save(kind, enabled)}>保存 {label} 设置</button></footer></Accordion.Content></Accordion.Item>;
}

function GeneralSettings({ onAgentEnabledChange }: { onAgentEnabledChange: (kind: AgentKind, enabled: boolean) => Promise<void> }) {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [username, setUsername] = useState('');
  const [availableProfiles, setAvailableProfiles] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<RosterKind[]>(() => parseExpandedRoster(localStorage.getItem('jian.settings-agent-roster-expanded')));
  const [error, setError] = useState('');
  const saveInFlight = useRef(false);
  const save = async (kind: RosterKind, enabled: boolean) => {
    if (!settings || saveInFlight.current) return;
    saveInFlight.current = true;
    const enabledChanged = kind !== 'local' && agentEnabled(settings, kind) !== enabled;
    const next = withAgentEnabled(settings, kind, enabled);
    try { setError(''); const saved = await api<AgentSettings>('/settings', { method: 'PUT', body: JSON.stringify(next) }); setSettings(normalizeAgentSettings(saved)); if (enabledChanged) await onAgentEnabledChange(kind, enabled); } catch (e) { setError(errorMessage(e)); } finally { saveInFlight.current = false; }
  };
  useEffect(() => { void api<{ username: string; settings: AgentSettings; available_profiles: string[] }>('/auth/me').then(value => { setUsername(value.username); setSettings(normalizeAgentSettings(value.settings)); setAvailableProfiles(value.available_profiles); }).catch(e => setError(errorMessage(e))); }, []);
  useEffect(() => { localStorage.setItem('jian.settings-agent-roster-expanded', JSON.stringify(expanded)); }, [expanded]);
  return <div className="general-settings-content"><div className="settings-section-intro"><span className="eyebrow">LOCAL SETTINGS</span></div>{error && <p className="error" role="alert">{error}</p>}{settings ? <Accordion.Root className="agent-toggle-list" type="multiple" value={expanded} onValueChange={values => setExpanded(values as RosterKind[])}><AgentRosterItem kind="local" settings={settings} username={username} availableProfiles={availableProfiles} save={save} setSettings={update => setSettings(value => value ? update(value) : value)} /><div className="settings-section-intro agent-roster-heading"><span className="eyebrow">AGENT ROSTER</span></div><AgentRosterItem kind="codex" settings={settings} username={username} availableProfiles={availableProfiles} save={save} setSettings={update => setSettings(value => value ? update(value) : value)} /><AgentRosterItem kind="hermes" settings={settings} username={username} availableProfiles={availableProfiles} save={save} setSettings={update => setSettings(value => value ? update(value) : value)} /><AgentRosterItem kind="pi" settings={settings} username={username} availableProfiles={availableProfiles} save={save} setSettings={update => setSettings(value => value ? update(value) : value)} /></Accordion.Root> : <p className="muted">正在读取 Agent 设置…</p>}</div>;
}

function TerminalStatusMenu({ terminal, onEnter, onRelease }: { terminal: TerminalStatus; onEnter: () => void; onRelease: () => void }) {
  const [open, setOpen] = useState(false);
  return <MenuPopup open={open} onOpenChange={setOpen} contentClassName="status-menu terminal-card-menu" ariaLabel={`${terminal.title || terminal.id} 操作`} trigger={<button type="button" className="icon terminal-status-menu-trigger" aria-label={`${terminal.title || terminal.id} 操作`} title="更多操作"><Ellipsis /></button>} content={<><button type="button" disabled={!terminal.running} onClick={() => { setOpen(false); onEnter(); }}>进入会话</button><button type="button" onClick={() => { setOpen(false); onRelease(); }}>释放会话</button></>} />;
}

function TerminalPool({ terminals, onEnter, onRelease, onReleaseAll }: { terminals: TerminalStatus[]; onEnter: (terminal: TerminalStatus) => void; onRelease: (terminal: TerminalStatus) => void; onReleaseAll: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <div className="terminal-pool"><header><div><span className="eyebrow">TERMINAL SESSIONS</span></div><MenuPopup open={menuOpen} onOpenChange={setMenuOpen} contentClassName="status-menu terminal-pool-menu" ariaLabel="会话列表操作" trigger={<button type="button" className="terminal-pool-count" aria-label={`${terminals.length} 个会话的操作`} title="会话列表操作" disabled={!terminals.length}>{terminals.length}</button>} content={<button type="button" className="terminal-release-all-action" onClick={() => { setMenuOpen(false); onReleaseAll(); }}>释放所有会话</button>} /></header>{terminals.length ? <div className="terminal-status-list">{terminals.map(terminal => <article className="terminal-status-card" key={terminal.id}><div className="terminal-status-heading"><span className={'terminal-status-dot ' + (terminal.running ? 'running' : 'ended')} /><strong title={terminal.title || terminal.id}>{terminal.title || terminal.id}</strong><code>{terminal.label}</code><TerminalStatusMenu terminal={terminal} onEnter={() => onEnter(terminal)} onRelease={() => onRelease(terminal)} /></div><div className="terminal-status-meta"><span title={terminal.id}>{terminal.id}</span><span>{terminal.running ? terminal.busy ? 'busy' : 'idle' : '已结束'}</span><span>{terminal.subscribers} 个连接</span></div>{terminal.workspace && <small className="terminal-status-workspace" title={terminal.workspace}>{terminal.workspace}</small>}</article>)}</div> : <p className="terminal-pool-empty">暂无 terminal</p>}</div>;
}

function TerminalSettings({ terminalFontSize = initialTerminalFontSize(), onTerminalFontSizeChange = size => window.dispatchEvent(new CustomEvent('jian-terminal-font-size', { detail: size })) }: { terminalFontSize?: number; onTerminalFontSizeChange?: (size: number) => void } = {}) {
  const [status, setStatus] = useState<TerminalStatusResponse | null>(null);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<{ type: 'all' | 'release'; terminal?: TerminalStatus } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { try { const value = await api<TerminalStatusResponse>('/settings/terminal-status'); setStatus(value); setError(''); } catch (e) { setError(errorMessage(e)); } };
  useEffect(() => { let active = true; const refresh = async () => { if (active) await load(); }; void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => { active = false; window.clearInterval(timer); }; }, []);
  const enter = (terminal: TerminalStatus) => window.dispatchEvent(new CustomEvent('jian-enter-terminal', { detail: { id: terminal.id, label: terminal.label } }));
  const release = async () => { if (!confirm) return; setBusy(true); try { const path = confirm.type === 'all' ? '/settings/terminals/release-all' : `/settings/terminals/${encodeURIComponent(confirm.terminal!.id)}/release`; await api(path, { method: 'POST' }); if (confirm.type === 'all') window.dispatchEvent(new Event('jian-release-all-terminals')); setConfirm(null); await load(); } catch (e) { setConfirm(null); setError(errorMessage(e)); } finally { setBusy(false); } };
  return <div className="terminal-settings-content"><header className="terminal-settings-heading"><div className="settings-section-intro"><span className="eyebrow">TERMINAL MANAGER</span><p>当前活跃的 PTY 会话，可手动释放。</p></div><div className="terminal-font-size-settings"><span>终端字号</span><TerminalFontSizeControl size={terminalFontSize} onChange={onTerminalFontSizeChange} /></div></header><div className="terminal-font-preview" style={{ fontSize: terminalFontSize }}>user@jian:~$ echo "终端字号预览"</div>{status && <TerminalPool terminals={status.active_pool} onEnter={enter} onRelease={terminal => setConfirm({ type: 'release', terminal })} onReleaseAll={() => setConfirm({ type: 'all' })} />}{!status && !error && <p className="muted">正在读取 TerminalManager 状态…</p>}<ConfirmDialog open={!!confirm} title={confirm?.type === 'all' ? '释放所有会话？' : '释放这个会话？'} description={confirm?.type === 'all' ? '所有 terminal 子进程都会被强制停止，当前浏览器连接也会断开。' : `“${confirm?.terminal?.title || confirm?.terminal?.id}”将被强制停止，正在执行的任务会中断。`} confirmLabel="确认释放" danger busy={busy} onConfirm={() => void release()} onClose={() => setConfirm(null)} /><ErrorDialog open={!!error} message={error} onClose={() => setError('')} /></div>;
}

function AboutSettings() {
  const facts = [
    ['版本号', packageInfo.version],
    ['技术栈', 'Rust backend · React frontend'],
  ];
  return <div className="about-settings-content"><div className="about-identity"><span className="about-icon" aria-hidden="true" /><div><span className="eyebrow">JIAN · 简</span><h2>One terminal. Agents, everywhere.</h2></div></div><dl className="about-facts">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></div>;
}

export function SettingsPage({ theme, onThemeChange, terminalTheme, onTerminalThemeChange, terminalFontSize, onTerminalFontSizeChange, onAgentEnabledChange: configuredAgentChange }: Props) {
  const [section, setSection] = useState<Section>(() => sessionStorage.getItem('jian.settings-section') === 'terminal' ? 'terminal' : sessionStorage.getItem('jian.settings-section') === 'about' ? 'about' : 'general');
  useEffect(() => { sessionStorage.setItem('jian.settings-section', section); }, [section]);
  const onAgentEnabledChange = configuredAgentChange || (async (kind: AgentKind, enabled: boolean) => { localStorage.setItem(`jian.${kind}-enabled`, String(enabled)); });
  const current = sections.find(item => item.id === section) || sections[0];
  return <section className="settings-page" aria-label="设置">
    <nav className="settings-navigation" aria-label="设置导航"><div className="settings-navigation-heading"><span className="eyebrow">WORKSPACE</span><h1>设置</h1></div><div className="settings-navigation-list">{sections.map(item => { const Icon = item.icon; return <button key={item.id} className={'settings-navigation-item ' + (section === item.id ? 'selected' : '')} aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}><Icon /><span>{item.label}</span></button>; })}</div></nav>
    <div className="settings-main"><header className="settings-theme-bar"><div><strong>{current.label}</strong></div><div className="settings-theme-actions"><ThemeControls interfaceTheme={theme} terminalTheme={terminalTheme} onInterfaceThemeChange={onThemeChange} onTerminalThemeChange={onTerminalThemeChange} /></div></header><div className="settings-content" aria-label={`${current.label}设置`}>{section === 'general' && <GeneralSettings onAgentEnabledChange={onAgentEnabledChange} />}{section === 'terminal' && <TerminalSettings terminalFontSize={terminalFontSize} onTerminalFontSizeChange={onTerminalFontSizeChange} />}{section === 'about' && <AboutSettings />}</div></div>
  </section>;
}
