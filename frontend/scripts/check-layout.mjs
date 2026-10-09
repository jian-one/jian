import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const app = read('../src/main.tsx');
const main = app + read('../src/features/terminal/AgentTerminal.tsx') + read('../src/features/session-catalog/SessionTabs.tsx') + read('../src/features/session-catalog/WorkspacePicker.tsx');
const switcher = read('../src/features/session-catalog/SessionSwitcher.tsx');
const catalog = read('../src/features/session-catalog/useSessionCatalog.ts');
const navigation = read('../src/features/navigation/SidebarNavigation.tsx');
const sessions = read('../src/features/session-catalog/SessionList.tsx');
const terminal = read('../src/features/terminal/mountTerminal.ts');
const model = read('../src/shared/model.ts');
const settings = read('../src/features/settings/SettingsPage.tsx');
const css = `${read('../src/styles.css')}\n${read('../src/layout.css')}`;

const checks = [
  ['unified switching uses cached catalogs and Radix navigation', switcher.includes('Dialog.Root') && switcher.includes('Tabs.List') && switcher.includes('catalog: Catalog') && !switcher.includes('api(')],
  ['focus mode changes layout without replacing terminal identity', app.includes('workbench-focused') && app.includes('hidden={!focusMode}') && css.includes('.workbench-focused .session-tabs')],
  ['pane recovery reuses one guarded connection flow', terminal.includes('reconnectRequestRef.current = retryNow') && terminal.includes('socketRef.current !== ws') && terminal.includes('clearConnectionTimers()')],
  ['configuration cards show dirty state and individual recovery', settings.includes('settings-dirty-badge') && settings.includes('撤销本项修改') && settings.includes('feedback[kind]')],

  ['settings is independent from terminal context', app.includes('settingsOpen ? (') && app.includes('<SettingsPage') && !app.includes('settingsOpen ? "settings"')],
  ['Agent rail has direct Local, Codex, Hermes and Pi entry points', ['Local', 'Codex', 'Hermes', 'Pi'].every(label => navigation.includes(`<span>${label}</span>`))],
  ['roles use keyboard-accessible Radix tabs', navigation.includes('className="role-strip"') && navigation.includes('Tabs.Trigger') && navigation.includes('activationMode="manual"')],
  ['catalog searches title, workspace and session ID', navigation.includes('value.title} ${value.workspace} ${value.id}') && navigation.includes('catalog-search')],
  ['workspace is a filter instead of a disclosure level', navigation.includes('catalog-filter') && !navigation.includes('NavigationMenu')],
  ['normal list loads use the runtime cache', catalog.includes('/sessions/catalog?areas=')],
  ['native discovery is explicit refresh only', catalog.includes('`/agents/${area}/sessions/refresh`') && main.includes('await load(k, true)')],
  ['session rows expose a right-pane action through Radix menu', sessions.includes('Columns2') && sessions.includes('在右侧打开')],
  ['desktop supports two terminal panes', main.includes('terminal-split') && main.includes('secondary-pane') && main.includes('setSecondary')],
  ['narrow screens detach secondary display but preserve its session tab', app.includes('secondary && wideScreen') && app.includes('setOpenSessions(current => current.some')],
  ['mobile navigation uses a controlled Radix drawer', main.includes('mobileNavigationOpen') && navigation.includes('Dialog.Root open={navigationOpen}') && navigation.includes('onCloseAutoFocus')],
  ['mobile terminal uses its dedicated IME input buffer', terminal.includes('attachTerminalInputBuffer') && terminal.includes('xtermTextarea.disabled = touchInput')],
  ['terminal focus does not steal focus from dialogs', main.includes('[role="dialog"][aria-modal="true"]')],
  ['terminal search and navigation use the Search addon', terminal.includes("from '@xterm/addon-search'") && main.includes('aria-label="搜索终端输出"') && main.includes('findPrevious') && main.includes('findNext')],
  ['terminal links are restricted to HTTP(S) and WebGL loss falls back safely', terminal.includes("from '@xterm/addon-web-links'") && terminal.includes("from '@xterm/addon-webgl'") && terminal.includes("url.protocol === 'http:'") && terminal.includes("url.protocol === 'https:'") && terminal.includes('onContextLoss(() => addon.dispose())')],
  ['terminal status and release controls remain available', main.includes('terminal-status-menu') && main.includes('释放会话')],
  ['release runs directly while restart remains confirmed', !app.includes('setConfirmation({ type: "release"') && !settings.includes('确认释放') && app.includes('setConfirmation({ type: "restart"') && app.includes('onConfirm={() => void confirmOperation()}')],
  ['Agent identity remains complete in an open session key', model.includes('const openSessionKey') && model.includes("session.profile || 'default'")],
  ['native session normalization remains profile-aware', model.includes("export type Kind = 'codex' | 'hermes' | 'pi'")],
  ['mobile navigation is unmounted when closed', navigation.includes('Dialog.Portal') && !navigation.includes('forceMount') && css.includes('.nav-drawer')],
  ['tab closes are separate accessible buttons', main.includes('className="session-tab-close"') && main.includes('type="button" className="session-tab-close"') && main.includes('activationMode="manual"')],
  ['navigation records the actual catalog scroll container', navigation.includes('ref={setListNode} className="catalog-list"') && !main.includes('sidebarRef.current.scrollTop')],
  ['keyboard focus and reduced motion remain styled', css.includes(':focus-visible') && css.includes('prefers-reduced-motion: reduce')],
  ['workspace uses Radix and Agent shortcuts open the unified settings view', app.includes('targetAgent={settingsTarget}') && main.includes('Dialog.Root open onOpenChange') && main.includes('Dialog.Content className="workspace-picker"') && !main.includes('useDialogFocus')],
  ['settings saves lock navigation and preserve other drafts', main.includes('settingsBusyRef') && main.includes('locked={settingsBusy || creating || operationBusy}') && settings.includes('mergeSettingsFields(value, saved, fields)') && settings.includes('disabled={busy}')],
  ['mobile dialog viewport updates are coalesced and forms scroll inside fixed actions', main.includes("--dialog-viewport-height") && css.includes('.workspace-picker-body') && css.includes('overscroll-behavior: contain')],
];

const failed = checks.filter(([, passed]) => !passed);
for (const [name, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exit(1);
