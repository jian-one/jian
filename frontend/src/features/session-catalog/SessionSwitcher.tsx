import { useRef, useState } from 'react';
import { Dialog, Tabs, ToggleGroup, Collapsible, Select } from 'radix-ui';
import { Search, X, RefreshCw, ChevronDown } from 'lucide-react';
import { isMobile, openSessionKey, openSessionLabel, openSessionTitle, displayWorkspacePath, type OpenSession, type Kind } from '../../shared/model';
import { AgentIcon } from '../../shared/ui/AgentIcon';
import { restoreDialogFocus } from '../../shared/ui/dialog-focus';
import { switcherRows } from './session-switcher-model';
import { catalogAreas, catalogFeedback, type Catalog, type CatalogArea } from './catalog-state';

type Props = {
  opened: OpenSession[]; order: string[]; activeKey: string | null; catalog: Catalog;
  enabled: Partial<Record<Kind, boolean>>; onSelect: (session: OpenSession) => void; onClose: () => void;
  onRefresh: (area: CatalogArea) => void; onManage: () => void;
};
function Filter({ value, change, label, items }: { value: string; change: (value: string) => void; label: string; items: [string, string][] }) {
  return <Select.Root value={value} onValueChange={change}><Select.Trigger className="catalog-filter-trigger" aria-label={label}><Select.Value /><Select.Icon><ChevronDown /></Select.Icon></Select.Trigger><Select.Portal><Select.Content className="catalog-filter-menu" position="popper"><Select.Viewport>{items.map(([id, text]) => <Select.Item key={id} value={id} className="catalog-filter-item"><Select.ItemText>{text}</Select.ItemText></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal></Select.Root>;
}
export function SessionSwitcher({ opened, order, activeKey, catalog, enabled, onSelect, onClose, onRefresh, onManage }: Props) {
  const [query, setQuery] = useState(''), [scope, setScope] = useState('all'), [area, setArea] = useState('all'), [role, setRole] = useState('all'), [workspace, setWorkspace] = useState('all'), [limit, setLimit] = useState(50);
  const [errorsOpen, setErrorsOpen] = useState(() => !isMobile());
  const [filtersOpen, setFiltersOpen] = useState(() => !isMobile());
  const search = useRef<HTMLInputElement>(null), close = useRef<HTMLButtonElement>(null), previousFocus = useRef(document.activeElement as HTMLElement | null);
  const sources = catalogAreas.filter(value => (value === 'local' || enabled[value] !== false) && (area === 'all' || value === area));
  const available = switcherRows(opened, order, sources.flatMap(value => catalog[value]?.rows || []), '', scope === 'open').filter(row => area === 'all' || row.kind === area);
  const candidates = switcherRows(opened, order, sources.flatMap(value => catalog[value]?.rows || []), query, scope === 'open').filter(row => area === 'all' || row.kind === area);
  const roles = Array.from(new Set(available.flatMap(row => row.kind === 'hermes' || row.kind === 'pi' ? [row.kind + ':' + (row.profile || 'default')] : [])));
  const paths = Array.from(new Set(available.map(row => row.workspace).filter(Boolean)));
  const rows = candidates.filter(row => (role === 'all' || row.kind !== 'local' && row.kind + ':' + (row.profile || 'default') === role) && (workspace === 'all' || row.workspace === workspace));
  const filterCount = [area, role, workspace].filter(value => value !== 'all').length;
  const openedKeys = new Set(opened.map(openSessionKey));
  const failures = sources.filter(value => catalog[value]?.error);
  const loading = sources.some(value => catalog[value]?.refreshing);
  return <Dialog.Root open onOpenChange={value => !value && onClose()}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content className="session-switcher dialog" onCloseAutoFocus={event => restoreDialogFocus(event, previousFocus.current)}
      onOpenAutoFocus={event => { event.preventDefault(); (isMobile() ? close.current : search.current)?.focus({ preventScroll: true }); }}>
      <header><div><Dialog.Title asChild><h2>会话中心</h2></Dialog.Title><Dialog.Description>查找会话，继续当前工作。</Dialog.Description></div><Dialog.Close asChild><button ref={close} className="icon" aria-label="关闭会话切换器"><X /></button></Dialog.Close></header>
      <label className="switcher-search"><Search /><input ref={search} type="search" value={query} aria-label="搜索全部会话" placeholder="标题、目录、Agent 或角色"
        onChange={event => { setQuery(event.target.value); setLimit(50); }} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && rows[0]) { event.preventDefault(); const first = rows.find(row => row.kind === 'local' || enabled[row.kind] !== false); if (first) onSelect(first); } }} /></label>
      <div className="switcher-toolbar"><ToggleGroup.Root className="switcher-scope" type="single" value={scope} onValueChange={value => { if (value) { setScope(value); setLimit(50); } }} aria-label="会话范围">
        <ToggleGroup.Item value="all">全部会话</ToggleGroup.Item><ToggleGroup.Item value="open">已打开</ToggleGroup.Item>
      </ToggleGroup.Root><button className="icon" aria-label="刷新会话列表" disabled={loading} onClick={() => sources.forEach(onRefresh)}><RefreshCw /></button><button onClick={onManage}>管理会话</button></div>
      <Collapsible.Root open={filtersOpen} onOpenChange={setFiltersOpen}><Collapsible.Trigger className="switcher-filters-toggle">{filterCount ? '筛选 · ' + filterCount + ' 项' : '筛选 Agent、角色与目录'} <ChevronDown /></Collapsible.Trigger><Collapsible.Content><div className="switcher-filters"><Filter value={area} change={value => { setArea(value); setRole('all'); setWorkspace('all'); }} label="筛选 Agent" items={[['all', '全部 Agent'], ...catalogAreas.filter(value => value === 'local' || enabled[value] !== false).map(value => [value, openSessionLabel({ kind: value })] as [string, string])]} />
        {!!roles.length && <Filter value={role} change={setRole} label="筛选角色" items={[['all', '全部角色'], ...roles.map(value => [value, value.replace(':', ' · ')] as [string, string])]} />}
        {paths.length > 1 && <Filter value={workspace} change={setWorkspace} label="筛选目录" items={[['all', '全部目录'], ...paths.map(value => [value, displayWorkspacePath(value)] as [string, string])]} />}
      </div></Collapsible.Content></Collapsible.Root>
      <div className="switcher-feedback" role="status">{loading ? '更新中，当前列表仍可使用' : rows.length + ' 个会话'}<small>{sources.map(value => openSessionLabel({ kind: value }) + ' · ' + catalogFeedback(catalog[value])).join(' / ')}</small></div>
      {!!failures.length && <Collapsible.Root className="switcher-errors" open={errorsOpen} onOpenChange={setErrorsOpen}><Collapsible.Trigger className="switcher-error-summary">{failures.length} 个来源未更新 · {errorsOpen ? '收起原因' : '查看原因'}</Collapsible.Trigger><Collapsible.Content>{failures.map(value => <div className="switcher-error" key={value} role="alert"><span>{openSessionLabel({ kind: value })}：{catalog[value]?.error}</span><button disabled={catalog[value]?.refreshing} onClick={() => onRefresh(value)}>重试</button></div>)}</Collapsible.Content></Collapsible.Root>}
      <div className="switcher-results">
        <Tabs.Root orientation="vertical" activationMode="manual" onValueChange={key => { const session = rows.find(row => openSessionKey(row) === key); if (session) onSelect(session); }}>
          <Tabs.List className="switcher-list" aria-label="会话搜索结果">{rows.slice(0, limit).map(session => {
            const key = openSessionKey(session);
            return <Tabs.Trigger className="switcher-result" key={key} value={key} disabled={session.kind !== 'local' && enabled[session.kind] === false}>
              <AgentIcon kind={session.kind} /><span className="switcher-result-copy"><strong>{openSessionTitle(session)}</strong><small>{openSessionLabel(session)}{session.kind !== 'local' && ' · ' + (session.profile || 'default')}</small><small title={session.workspace}>{displayWorkspacePath(session.workspace) || '未知工作区'}</small></span>
              {session.kind !== 'local' && enabled[session.kind] === false ? <span className="switcher-tag">Agent 已停用</span> : key === activeKey ? <span className="switcher-tag">当前</span> : openedKeys.has(key) && <span className="switcher-tag">已打开</span>}
            </Tabs.Trigger>;
          })}</Tabs.List>
        </Tabs.Root>
        {!rows.length && <p className="switcher-empty">{query ? '没有匹配的会话，试试其他关键词。' : scope === 'open' ? '还没有打开的会话。' : '暂无会话，可新建或刷新列表。'}</p>}
        {rows.length > limit && <button className="switcher-more" onClick={() => setLimit(value => value + 50)}>显示更多</button>}
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
