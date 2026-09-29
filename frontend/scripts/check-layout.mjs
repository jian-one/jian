import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const main = read('../src/main.tsx');
const navigation = read('../src/features/navigation/SidebarNavigation.tsx');
const sessions = read('../src/features/session-catalog/SessionList.tsx');
const terminal = read('../src/features/terminal/mountTerminal.ts');
const model = read('../src/shared/model.ts');
const css = `${read('../src/styles.css')}\n${read('../src/layout.css')}`;

const checks = [
  ['Agent rail has direct Local, Codex, Hermes and Pi entry points', ['Local', 'Codex', 'Hermes', 'Pi'].every(label => navigation.includes(`<span>${label}</span>`))],
  ['roles stay visible as a compact tab strip', navigation.includes('className="role-strip"') && navigation.includes('role="tablist"')],
  ['catalog searches title, workspace and session ID', navigation.includes('value.title} ${value.workspace} ${value.id}') && navigation.includes('catalog-search')],
  ['workspace is a filter instead of a disclosure level', navigation.includes('catalog-filter') && !navigation.includes('NavigationMenu')],
  ['normal list loads use the runtime cache', main.includes('`/agents/${target}/sessions/cache`')],
  ['native discovery is explicit refresh only', main.includes('refresh ? `/agents/${target}/sessions/refresh`') && main.includes('await load(k, true)')],
  ['session rows expose a right-pane action through Radix menu', sessions.includes('Columns2') && sessions.includes('在右侧打开')],
  ['desktop supports two terminal panes', main.includes('terminal-split') && main.includes('secondary-pane') && main.includes('setSecondary')],
  ['narrow screens show one terminal pane', css.includes('@media (max-width: 1199px) { .terminal-split .secondary-pane, .secondary-open-action { display: none; } }')],
  ['mobile navigation remains one drawer state', main.includes('mobileNavigationOpen') && main.includes('nav-mobile-open')],
  ['mobile terminal uses its dedicated IME input buffer', terminal.includes('attachTerminalInputBuffer') && terminal.includes('xtermTextarea.disabled = touchInput')],
  ['terminal focus does not steal focus from dialogs', main.includes('[role="dialog"][aria-modal="true"]')],
  ['terminal status and release controls remain available', main.includes('terminal-status-menu') && main.includes('释放会话')],
  ['release and restart remain direct actions', !main.includes('setConfirm("release")') && main.includes('window.dispatchEvent(new Event("jian-restart-terminal"))')],
  ['Agent identity remains complete in an open session key', main.includes('const openSessionKey') && main.includes('session.profile || "default"')],
  ['native session normalization remains profile-aware', model.includes("export type Kind = 'codex' | 'hermes' | 'pi'")],
  ['mobile sidebar remains off-canvas while closed', css.includes('transform: translateX(-105%)')],
  ['keyboard focus and reduced motion remain styled', css.includes(':focus-visible') && css.includes('prefers-reduced-motion: reduce')],
];

const failed = checks.filter(([, passed]) => !passed);
for (const [name, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exit(1);
