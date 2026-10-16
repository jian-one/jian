import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ChevronDown, Ellipsis, Info, MonitorCog, Plus, Server, SlidersHorizontal, Trash2 } from 'lucide-react';
import { Accordion, Dialog, Switch } from 'radix-ui';
import { type AgentSettings, type CommandConfig, type Host, type Theme, type TerminalStatus, type TerminalStatusResponse } from '../../shared/model';
import { initialTerminalFontSize } from '../../shared/model';
import { api, errorMessage } from '../../shared/api';
import { MenuPopup } from '../../shared/ui/Popup';
import { ErrorDialog } from '../../shared/ui/ErrorDialog';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { AgentIcon } from '../../shared/ui/AgentIcon';
import { EnvironmentVariables } from '../../shared/ui/EnvironmentVariables';
import { ProfileFilePicker } from '../../shared/ui/ProfileFilePicker';
import { ThemeControls } from '../../shared/ui/ThemeControls';
import { TerminalFontSizeControl } from '../../shared/ui/TerminalFontSizeControl';
import type { TerminalTheme } from '../terminal/themes';
import { agentEnabled, normalizeAgentSettings, parseExpandedRoster, withAgentEnabled, mergeSettingsFields, saveAgentSettings, settingsFields, dirtySettingsKinds, type AgentKind, type RosterKind } from './settings-model';
import packageInfo from '../../../package.json';

type Section = 'general' | 'hosts' | 'appearance' | 'terminal' | 'about';
type Props = { username: string; onLogout: () => void; onBack: () => void; targetAgent: RosterKind | null; onDirtyChange: (names: string[]) => void; theme: Theme; onThemeChange: (theme: Theme) => void; terminalTheme: TerminalTheme; onTerminalThemeChange: (theme: TerminalTheme) => void; terminalFontSize?: number; onTerminalFontSizeChange?: (size: number) => void; onAgentEnabledChange?: (kind: AgentKind, enabled: boolean) => Promise<void>; onHostsChange: (hosts: Host[]) => void; onCommandConfigsChange: (configs: CommandConfig[]) => void; busy: boolean; onBusyChange: (busy: boolean) => void; isCurrentUser: () => boolean };
const sections: { id: Section; label: string; icon: typeof SlidersHorizontal }[] = [
  { id: 'general', label: 'Agent 配置', icon: SlidersHorizontal },
  { id: 'hosts', label: '远程主机', icon: Server },
  { id: 'appearance', label: '外观与输入', icon: SlidersHorizontal },
  { id: 'terminal', label: '终端管理', icon: MonitorCog },
  { id: 'about', label: '关于', icon: Info },
];

function LaunchArguments({ kind, settings, setSettings }: { kind: AgentKind; settings: AgentSettings; setSettings: (update: (value: AgentSettings) => AgentSettings) => void }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const key = 'codex_args';
  const args = settings[key] || [];
  const update = (index: number, argument: string) => setSettings(value => ({ ...value, [key]: value[key].map((item, itemIndex) => itemIndex === index ? argument : item) }));
  const add = () => { const index = args.length; setSettings(value => ({ ...value, [key]: [...value[key], ''] })); requestAnimationFrame(() => refs.current[index]?.focus()); };
  return <fieldset className="profile-settings launch-arguments"><legend>启动参数</legend><small>每项为一个独立参数，保存后应用于新建和重启的会话。</small><div className="launch-argument-list">{args.map((argument, index) => <div key={index}><input ref={element => { refs.current[index] = element; }} value={argument} onChange={event => update(index, event.target.value)} placeholder="例如 --model 或 gpt-5" aria-label={`启动参数 ${index + 1}`} /><button type="button" className="icon" aria-label={`移除启动参数 ${index + 1}`} title="移除参数" onClick={() => setSettings(value => ({ ...value, [key]: value[key].filter((_, itemIndex) => itemIndex !== index) }))}><Trash2 /></button></div>)}</div><button type="button" className="icon launch-argument-add" onClick={add} aria-label="添加启动参数" title="添加启动参数"><Plus /></button></fieldset>;
}

function AgentRosterItem({ kind, settings, savingKind, save, setSettings, dirty, feedback, reset }: { dirty: boolean; feedback?: { message?: string; error?: string }; reset: () => void; kind: RosterKind; settings: AgentSettings; savingKind: RosterKind | null; save: (kind: RosterKind, enabled?: boolean) => Promise<void>; setSettings: (update: (value: AgentSettings) => AgentSettings) => void }) {
  const enabled = kind === 'local' || agentEnabled(settings, kind);
  const label = kind === 'local' ? 'Local' : kind === 'codex' ? 'Codex' : '通用启动器';
  const [profilePicking, setProfilePicking] = useState(false);
  const toggle = (next: boolean) => void save(kind, next);
  const field = (key: 'codex_bin' | 'path', fieldLabel: string, hint: string) => <label className="setting-field"><span>{fieldLabel}<small>{hint}</small></span><input value={settings[key] || ''} onChange={event => setSettings(value => ({ ...value, [key]: event.target.value }))} /></label>;
  const localProfiles = <><fieldset className="profile-settings local-profile-settings"><legend>自动加载的 Shell 配置文件</legend><small>第一个文件固定为 ~/.bashrc，不能删除。</small><div className="local-profile-list">{settings.local_profiles.map((path, index) => <div key={path}><span title={path}>{path}</span>{index === 0 ? <small>固定</small> : <button type="button" className="icon" aria-label={`移除 ${path}`} title="移除文件" onClick={() => setSettings(value => ({ ...value, local_profiles: value.local_profiles.filter(item => item !== path) }))}><Trash2 /></button>}</div>)}</div><div className="local-profile-add"><button type="button" className="icon" aria-label="添加 Shell 配置文件" title="添加文件" onClick={() => setProfilePicking(true)}><Plus /></button></div></fieldset>{profilePicking && <ProfileFilePicker open onOpenChange={setProfilePicking} select={path => { setSettings(value => value.local_profiles.includes(path) ? value : { ...value, local_profiles: [...value.local_profiles, path] }); setProfilePicking(false); }} />}</>;
  const commandConfigs = <fieldset className="profile-settings"><legend>命令配置</legend><small>每项配置可用于本机或已注册的远程主机。参数按行填写，环境变量逐项保存。</small>{settings.command_configs.map((config, index) => <div className="command-config-card" key={config.id}><div className="command-config-heading"><strong>{config.name || `配置 ${index + 1}`}</strong><button type="button" className="icon" aria-label={`移除命令配置 ${config.name || index + 1}`} onClick={() => setSettings(value => ({ ...value, command_configs: value.command_configs.filter(item => item.id !== config.id) }))}><Trash2 /></button></div><label className="setting-field"><span>名称</span><input value={config.name} placeholder="例如：Codex Review" onChange={event => updateCommandConfig(config.id, { name: event.target.value }, setSettings)} /></label><label className="setting-field"><span>程序</span><input required value={config.program} placeholder="例如 codex、python 或绝对路径" onChange={event => updateCommandConfig(config.id, { program: event.target.value }, setSettings)} /></label><label className="setting-field"><span>默认参数<small>一行一个参数，不经过 Shell 拼接</small></span><textarea rows={3} value={config.args.join('\n')} placeholder={'例如：\n--model\ngpt-5'} onChange={event => updateCommandConfig(config.id, { args: event.target.value.split('\n').filter(argument => argument.length > 0) }, setSettings)} /></label><EnvironmentVariables values={config.env} onChange={env => updateCommandConfig(config.id, { env }, setSettings)} /></div>)}<button type="button" className="icon launch-argument-add" aria-label="添加命令配置" onClick={() => setSettings(value => ({ ...value, command_configs: [...value.command_configs, { id: crypto.randomUUID(), name: '', program: '', args: [], env: [] }] }))}><Plus /></button></fieldset>;
  return <Accordion.Item className="agent-roster-item" data-agent-settings={kind} value={kind}>
    <div className="agent-toggle-row"><Accordion.Header><Accordion.Trigger className="agent-roster-trigger" disabled={!!savingKind} aria-label={`${label}设置，展开或收起详细配置`}><span className="agent-toggle-copy"><AgentIcon kind={kind === 'local' ? 'local' : kind} /><strong>{label}</strong>{dirty && <small className="settings-dirty-badge">未保存</small>}{feedback?.error && <small className="settings-error-badge">保存失败</small>}</span><ChevronDown className="agent-roster-chevron" aria-hidden="true" /></Accordion.Trigger></Accordion.Header><Switch.Root className="agent-switch" checked={enabled} disabled={kind === 'local' || !!savingKind} onCheckedChange={kind === 'local' ? undefined : toggle} aria-label={kind === 'local' ? 'Local 已激活' : `启用 ${label}`}><Switch.Thumb className="agent-switch-thumb" /></Switch.Root></div>
    <Accordion.Content className="agent-roster-content"><form onSubmit={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); void save(kind); }}>
      <fieldset className="agent-roster-fields settings-form-lock" disabled={!!savingKind}>{kind === 'local' ? localProfiles : kind === 'codex' ? <>{field('codex_bin', 'CODEX_BIN', '留空时使用运行环境中的 codex') }<EnvironmentVariables values={settings.codex_env} onChange={values => setSettings(value => ({ ...value, codex_env: values }))} /><LaunchArguments kind="codex" settings={settings} setSettings={setSettings} /></> : commandConfigs}</fieldset>
      <div className="settings-card-feedback">{feedback?.error && <p className="error" role="alert">{feedback.error}</p>}{feedback?.message && <p className="settings-save-status" role="status">{feedback.message}</p>}</div><footer><button type="button" className="settings-reset" disabled={!!savingKind || !dirty} onClick={reset}>撤销本项修改</button><button type="submit" disabled={!!savingKind || !dirty}>{savingKind === kind ? '正在保存…' : `保存 ${label} 设置`}</button></footer>
    </form></Accordion.Content>
  </Accordion.Item>;
}

function updateCommandConfig(id: string, patch: Partial<CommandConfig>, setSettings: (update: (value: AgentSettings) => AgentSettings) => void) {
  setSettings(value => ({ ...value, command_configs: value.command_configs.map(config => config.id === id ? { ...config, ...patch } : config) }));
}

type HostToken = { host: Host; token: string };
function HostSettings({ onHostsChange, onBusyChange }: { onHostsChange: (hosts: Host[]) => void; onBusyChange: (busy: boolean) => void }) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [token, setToken] = useState<HostToken | null>(null);
  const [confirm, setConfirm] = useState<{ action: 'rotate' | 'delete'; host: Host } | null>(null);
  const mounted = useRef(false), savingRef = useRef(false), loadVersion = useRef(0);
  const publishHosts = (value: Host[]) => { if (mounted.current) { setHosts(value); onHostsChange(value); } };
  const load = async () => {
    const version = ++loadVersion.current;
    try {
      const value = await api<Host[]>('/hosts');
      if (mounted.current && version === loadVersion.current) { publishHosts(value || []); setError(''); }
    } catch (cause) { if (mounted.current && version === loadVersion.current) setError(errorMessage(cause)); }
  };
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => { if (!savingRef.current) void load(); }, 10000);
    return () => { mounted.current = false; loadVersion.current++; window.clearInterval(timer); };
  }, []);
  const register = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true); savingRef.current = true; loadVersion.current++; onBusyChange(true); setError('');
    try {
      const value = await api<HostToken>('/hosts', { method: 'POST', body: JSON.stringify({ name }) });
      if (mounted.current) { setName(''); setToken(value); await load(); }
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { savingRef.current = false; if (mounted.current) setSaving(false); onBusyChange(false); }
  };
  const act = async () => {
    if (!confirm || saving) return;
    const current = confirm; setSaving(true); savingRef.current = true; loadVersion.current++; onBusyChange(true); setError('');
    try {
      if (current.action === 'rotate') {
        const value = await api<HostToken>(`/hosts/${encodeURIComponent(current.host.id)}/rotate`, { method: 'POST' });
        if (mounted.current) setToken(value);
      } else {
        await api(`/hosts/${encodeURIComponent(current.host.id)}`, { method: 'DELETE' });
        if (mounted.current) setToken(null);
      }
      if (mounted.current) { setConfirm(null); await load(); }
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { savingRef.current = false; if (mounted.current) setSaving(false); onBusyChange(false); }
  };
  const command = token && `jian-client connect --server ${window.location.origin} --host ${token.host.id} --token ${token.token}`;
  const copy = async () => {
    if (!command) return;
    try { await navigator.clipboard.writeText(command); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    catch (cause) { setError(errorMessage(cause)); }
  };
  return <div className="host-settings-content"><div className="settings-section-intro"><h2>注册远程主机</h2><p>远程主机主动连接 Jian 服务，连接后可在浏览器里打开 Codex 或通用命令终端。请通过 HTTPS 访问服务以保护注册凭据。</p></div>
    <form className="host-register-form" onSubmit={event => void register(event)}><label className="setting-field"><span>主机名称</span><input value={name} maxLength={100} onChange={event => setName(event.target.value)} placeholder="例如 gpu-node-01" disabled={saving} /></label><button type="submit" disabled={saving || !name.trim()}>{saving ? '正在注册…' : '注册主机'}</button></form>
    {error && <p className="error" role="alert">{error}<button type="button" onClick={() => void load()}>重试</button></p>}
    <div className="settings-section-intro host-list-heading"><h2>已注册主机</h2><button type="button" onClick={() => void load()} disabled={saving}>刷新</button></div>
    {hosts.length ? <div className="registered-host-list">{hosts.map(host => <article className="registered-host-card" key={host.id}><div className="registered-host-heading"><span className={'session-state ' + (host.connected ? 'running' : 'ended')} /><strong>{host.name}</strong><span className="registered-host-status">{host.connected ? '在线' : '离线'}</span></div><dl><div><dt>平台</dt><dd>{host.platform || '未知'}</dd></div><div><dt>主目录</dt><dd title={host.home}>{host.home || '客户端连接后自动获取'}</dd></div><div><dt>主机 ID</dt><dd><code>{host.id}</code></dd></div></dl><footer><button type="button" className="settings-reset" disabled={saving} onClick={() => setConfirm({ action: 'rotate', host })}>轮换凭据</button><button type="button" className="danger" disabled={saving} onClick={() => setConfirm({ action: 'delete', host })}>移除主机</button></footer></article>)}</div> : <p className="host-empty">还没有远程主机。注册后在目标机器运行连接命令。</p>}
    <Dialog.Root open={!!token} onOpenChange={open => { if (!open) setToken(null); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog host-token-dialog" aria-describedby={undefined}><Dialog.Title>主机连接凭据</Dialog.Title><Dialog.Description>在目标机器安装 jian-client 并运行下面的命令。令牌只在此处显示一次。</Dialog.Description><pre><code>{command}</code></pre><div className="host-token-actions"><button type="button" onClick={() => void copy()}>{copied ? '已复制' : '复制连接命令'}</button><Dialog.Close asChild><button type="button" className="settings-reset">完成</button></Dialog.Close></div></Dialog.Content></Dialog.Portal></Dialog.Root>
    <ConfirmDialog open={!!confirm} title={confirm?.action === 'rotate' ? '轮换主机凭据？' : '移除远程主机？'} description={confirm?.action === 'rotate' ? '旧凭据会立即失效，当前客户端将断开。你需要在目标机器更新连接命令。' : `“${confirm?.host.name || ''}”上的远程会话将从 Jian 移除，客户端连接也会被撤销。`} confirmLabel={confirm?.action === 'rotate' ? '轮换凭据' : '移除主机'} danger busy={saving} onConfirm={() => void act()} onClose={() => { if (!saving) setConfirm(null); }} />
  </div>;
}

function GeneralSettings({ onAgentEnabledChange, onBusyChange, isCurrentUser, targetAgent, onDirtyChange, onCommandConfigsChange }: { targetAgent: RosterKind | null; onDirtyChange: (names: string[]) => void; onAgentEnabledChange: (kind: AgentKind, enabled: boolean) => Promise<void>; onCommandConfigsChange: (configs: CommandConfig[]) => void; onBusyChange: (busy: boolean) => void; isCurrentUser: () => boolean }) {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const baseline = useRef<AgentSettings | null>(null);
  const [expanded, setExpanded] = useState<RosterKind[]>(() => parseExpandedRoster(localStorage.getItem('jian.settings-agent-roster-expanded')));
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState<Partial<Record<RosterKind, { message?: string; error?: string }>>>({});
  const [savingKind, setSavingKind] = useState<RosterKind | null>(null);
  const mounted = useRef(true);
  const alive = () => mounted.current && isCurrentUser();
  const saveInFlight = useRef(false);
  const readingSettings = useRef(false);
  const save = async (kind: RosterKind, enabled?: boolean) => {
    if (!settings || saveInFlight.current || (enabled === undefined && !dirtySettingsKinds(settings, baseline.current).includes(kind))) return;
    saveInFlight.current = true;
    setSavingKind(kind); onBusyChange(true); setFeedback(value => ({ ...value, [kind]: {} }));
    const fields = settingsFields(kind, enabled === undefined ? 'roster' : 'toggle');
    const next = enabled === undefined ? settings : withAgentEnabled(settings, kind, enabled);
    try {
      const saved = await saveAgentSettings(next, fields, alive);
      if (!alive()) return;
      if (baseline.current) baseline.current = mergeSettingsFields(baseline.current, saved, fields);
      setSettings(value => value ? mergeSettingsFields(value, saved, fields) : value);
      onCommandConfigsChange(saved.command_configs || []);
      if (enabled !== undefined && kind !== 'local') await onAgentEnabledChange(kind, agentEnabled(saved, kind));
      setFeedback(value => ({ ...value, [kind]: { message: `${kind === 'local' ? 'Local' : kind === 'codex' ? 'Codex' : '通用启动器'}${enabled === undefined ? ' 设置已保存' : enabled ? ' 已启用' : ' 已禁用'}` } }));
    } catch (e) { if (alive()) setFeedback(value => ({ ...value, [kind]: { error: errorMessage(e) } })); }
    finally { saveInFlight.current = false; if (alive()) { setSavingKind(null); onBusyChange(false); } }
  };
  const load = async () => {
    if (readingSettings.current) return;
    readingSettings.current = true;
    setError('');
    try { const value = await api<{ settings: AgentSettings }>('/auth/me'); if (alive()) { baseline.current = normalizeAgentSettings(value.settings); setSettings(baseline.current); } }
    catch (e) { if (alive()) setError(errorMessage(e)); }
    finally { readingSettings.current = false; }
  };
  const dirtyKinds = dirtySettingsKinds(settings, baseline.current);
  useEffect(() => { onDirtyChange(dirtyKinds.map(kind => kind === 'local' ? 'Local' : kind === 'codex' ? 'Codex' : '通用启动器')); }, [dirtyKinds.join('|'), onDirtyChange]);
  useEffect(() => {
    if (!targetAgent) return;
    setExpanded(values => values.includes(targetAgent) ? values : [...values, targetAgent]);
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-agent-settings="${targetAgent}"]`)?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [targetAgent, settings !== null]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirtySettingsKinds(settings, baseline.current).length) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [settings]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, []);
  useEffect(() => { localStorage.setItem('jian.settings-agent-roster-expanded', JSON.stringify(expanded)); }, [expanded]);
  return <div className="general-settings-content" aria-busy={!!savingKind}><div className="settings-section-intro"><h2>Agent 配置</h2><p>Codex 提供专用启动器；其他 CLI 可用通用命令配置。</p></div>{error && <p className="error" role="alert">{error}{!settings && <button onClick={() => void load()}>重试</button>}</p>}{settings ? <Accordion.Root className="agent-toggle-list" type="multiple" value={expanded} onValueChange={values => setExpanded(values as RosterKind[])}>{(['local', 'codex', 'command'] as RosterKind[]).map(kind => <Fragment key={kind}>{kind === 'codex' && <div className="settings-section-intro agent-roster-heading"><h2>可用启动器</h2></div>}<AgentRosterItem kind={kind} dirty={dirtyKinds.includes(kind)} feedback={feedback[kind]} reset={() => { if (saveInFlight.current || !baseline.current) return; setSettings(value => value ? mergeSettingsFields(value, baseline.current!, settingsFields(kind)) : value); setFeedback(value => ({ ...value, [kind]: {} })); }} settings={settings} savingKind={savingKind} save={save} setSettings={update => { if (!saveInFlight.current) { setFeedback(value => ({ ...value, [kind]: {} })); setSettings(value => value ? update(value) : value); } }} /></Fragment>)}</Accordion.Root> : !error && <p className="muted">正在读取启动器设置…</p>}{dirtyKinds.length > 0 && <div className="settings-mobile-save" role="status"><span>有未保存修改</span>{dirtyKinds.map(kind => <button key={kind} disabled={!!savingKind} onClick={() => void save(kind)}>保存 {kind === 'local' ? 'Local' : kind === 'codex' ? 'Codex' : '通用启动器'}</button>)}</div>}</div>;
}

function TerminalStatusMenu({ terminal, onEnter, onRelease }: { terminal: TerminalStatus; onEnter: () => void; onRelease: () => void }) {
  const [open, setOpen] = useState(false);
  return <MenuPopup open={open} onOpenChange={setOpen} contentClassName="status-menu terminal-card-menu" ariaLabel={`${terminal.title || terminal.id} 操作`} trigger={<button type="button" className="icon terminal-status-menu-trigger" aria-label={`${terminal.title || terminal.id} 操作`} title="更多操作"><Ellipsis /></button>} content={<><button type="button" disabled={!terminal.running} onClick={() => { setOpen(false); onEnter(); }}>进入会话</button><button type="button" onClick={() => { setOpen(false); onRelease(); }}>释放会话</button></>} />;
}

function TerminalPool({ terminals, onEnter, onRelease, onReleaseAll }: { terminals: TerminalStatus[]; onEnter: (terminal: TerminalStatus) => void; onRelease: (terminal: TerminalStatus) => void; onReleaseAll: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <div className="terminal-pool"><header><div><span className="eyebrow">TERMINAL SESSIONS</span></div><MenuPopup open={menuOpen} onOpenChange={setMenuOpen} contentClassName="status-menu terminal-pool-menu" ariaLabel="会话列表操作" trigger={<button type="button" className="terminal-pool-count" aria-label={`${terminals.length} 个会话的操作`} title="会话列表操作" disabled={!terminals.length}>{terminals.length}</button>} content={<button type="button" className="terminal-release-all-action" onClick={() => { setMenuOpen(false); onReleaseAll(); }}>释放所有会话</button>} /></header>{terminals.length ? <div className="terminal-status-list">{terminals.map(terminal => <article className="terminal-status-card" key={terminal.id}><div className="terminal-status-heading"><span className={'terminal-status-dot ' + (terminal.running ? 'running' : 'ended')} /><strong title={terminal.title || terminal.id}>{terminal.title || terminal.id}</strong><code>{terminal.label}</code><TerminalStatusMenu terminal={terminal} onEnter={() => onEnter(terminal)} onRelease={() => onRelease(terminal)} /></div><div className="terminal-status-meta"><span title={terminal.id}>{terminal.id}</span><span>{terminal.running ? terminal.busy ? '忙碌中' : '空闲' : '已结束'}</span><span>{terminal.subscribers} 个连接</span></div>{terminal.workspace && <small className="terminal-status-workspace" title={terminal.workspace}>{terminal.workspace}</small>}</article>)}</div> : <p className="terminal-pool-empty">暂无运行中的终端</p>}</div>;
}

function TerminalSettings({ terminalFontSize = initialTerminalFontSize(), onTerminalFontSizeChange = size => window.dispatchEvent(new CustomEvent('jian-terminal-font-size', { detail: size })) }: { terminalFontSize?: number; onTerminalFontSizeChange?: (size: number) => void } = {}) {
  const [status, setStatus] = useState<TerminalStatusResponse | null>(null);
  const [error, setError] = useState('');
  const releaseInFlight = useRef(false);
  const load = async () => { try { const value = await api<TerminalStatusResponse>('/settings/terminal-status'); setStatus(value); setError(''); } catch (e) { setError(errorMessage(e)); } };
  useEffect(() => { let active = true; const refresh = async () => { if (active) await load(); }; void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => { active = false; window.clearInterval(timer); }; }, []);
  const enter = (terminal: TerminalStatus) => window.dispatchEvent(new CustomEvent('jian-enter-terminal', { detail: { id: terminal.id, label: terminal.label } }));
  const release = async (terminal?: TerminalStatus) => { if (releaseInFlight.current) return; releaseInFlight.current = true; try { const path = terminal ? `/settings/terminals/${encodeURIComponent(terminal.id)}/release` : '/settings/terminals/release-all'; await api(path, { method: 'POST' }); if (!terminal) window.dispatchEvent(new Event('jian-release-all-terminals')); await load(); } catch (e) { setError(errorMessage(e)); } finally { releaseInFlight.current = false; } };
  return <div className="terminal-settings-content"><header className="terminal-settings-heading"><div className="settings-section-intro"><span className="eyebrow">TERMINAL MANAGER</span><p>查看服务器上运行的终端，释放会中止任务。</p></div><div className="terminal-font-size-settings"><span>终端字号</span><TerminalFontSizeControl size={terminalFontSize} onChange={onTerminalFontSizeChange} /></div></header><div className="terminal-font-preview" style={{ fontSize: terminalFontSize }}>user@jian:~$ echo "终端字号预览"</div>{status && <TerminalPool terminals={status.active_pool} onEnter={enter} onRelease={terminal => void release(terminal)} onReleaseAll={() => void release()} />}{!status && !error && <p className="muted">正在读取终端状态…</p>}<ErrorDialog open={!!error} message={error} onClose={() => setError('')} /></div>;
}

function AboutSettings() {
  const facts = [
    ['版本号', packageInfo.version],
    ['技术栈', 'Rust backend · React frontend'],
  ];
  return <div className="about-settings-content"><div className="about-identity"><span className="about-icon" aria-hidden="true" /><div><span className="eyebrow">JIAN · 简</span><h2>One terminal. Agents, everywhere.</h2></div></div><dl className="about-facts">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></div>;
}

export function SettingsPage({ username, onLogout, onBack, targetAgent, onDirtyChange, theme, onThemeChange, terminalTheme, onTerminalThemeChange, terminalFontSize, onTerminalFontSizeChange, onAgentEnabledChange: configuredAgentChange, onHostsChange, onCommandConfigsChange, busy, onBusyChange, isCurrentUser }: Props) {
  const [section, setSection] = useState<Section>(() => { const saved = sessionStorage.getItem('jian.settings-section'); return ['general', 'hosts', 'appearance', 'terminal', 'about'].includes(saved || '') ? saved as Section : 'general'; });
  useEffect(() => { sessionStorage.setItem('jian.settings-section', section); }, [section]);
  useEffect(() => { if (targetAgent) setSection('general'); }, [targetAgent]);
  const onAgentEnabledChange = configuredAgentChange || (async (kind: AgentKind, enabled: boolean) => { localStorage.setItem(`jian.${kind}-enabled`, String(enabled)); });
  const current = sections.find(item => item.id === section) || sections[0];
  return <section className="settings-page" aria-label="设置">
    <nav className="settings-navigation" aria-label="设置导航"><div className="settings-navigation-heading"><button type="button" className="settings-back" aria-label="返回工作台" autoFocus onClick={onBack} disabled={busy}><ArrowLeft />返回工作台</button><h1>设置</h1></div><div className="settings-navigation-list">{sections.map(item => { const Icon = item.icon; return <button key={item.id} disabled={busy} className={'settings-navigation-item ' + (section === item.id ? 'selected' : '')} aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}><Icon /><span>{item.label}</span></button>; })}</div><div className="settings-account"><span>{username}</span><button onClick={onLogout} aria-label="退出登录">退出登录</button></div></nav>
    <div className="settings-main"><header className="settings-theme-bar"><div><strong>{current.label}</strong></div><div className="settings-theme-actions"><ThemeControls interfaceTheme={theme} terminalTheme={terminalTheme} onInterfaceThemeChange={onThemeChange} onTerminalThemeChange={onTerminalThemeChange} /></div></header><div className="settings-content" aria-label={`${current.label}设置`}><div hidden={section !== 'general'}><GeneralSettings targetAgent={targetAgent} onDirtyChange={onDirtyChange} onAgentEnabledChange={onAgentEnabledChange} onCommandConfigsChange={onCommandConfigsChange} onBusyChange={onBusyChange} isCurrentUser={isCurrentUser} /></div>{section === 'hosts' && <HostSettings onHostsChange={hosts => { onHostsChange(hosts); window.dispatchEvent(new Event('jian-hosts-updated')); }} onBusyChange={onBusyChange} />}{section === 'appearance' && <div className="appearance-settings"><h2>外观与输入</h2><p>界面与终端配色分别保存，立即生效。</p><ThemeControls interfaceTheme={theme} terminalTheme={terminalTheme} onInterfaceThemeChange={onThemeChange} onTerminalThemeChange={onTerminalThemeChange} /><label>终端字号<TerminalFontSizeControl size={terminalFontSize || initialTerminalFontSize()} onChange={onTerminalFontSizeChange || (() => {})} /></label><p>手机默认使用文本编辑；可随时切换实时终端。草稿按会话保存在当前浏览器。</p></div>}{section === 'terminal' && <TerminalSettings terminalFontSize={terminalFontSize} onTerminalFontSizeChange={onTerminalFontSizeChange} />}{section === 'about' && <AboutSettings />}</div></div>
  </section>;
}
