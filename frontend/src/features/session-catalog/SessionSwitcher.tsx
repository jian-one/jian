import { useEffect, useRef, useState } from 'react';
import { Dialog, Tabs, ToggleGroup, Collapsible } from 'radix-ui';
import { Search, X } from 'lucide-react';
import { api, errorMessage } from '../../shared/api';
import { normalizeSessions } from '../../session-load-guard';
import { isMobile, openSessionKey, openSessionLabel, openSessionTitle, displayWorkspacePath, type OpenSession, type Kind, type LocalSession, type Session } from '../../shared/model';
import { AgentIcon } from '../../shared/ui/AgentIcon';
import { restoreDialogFocus } from '../../shared/ui/dialog-focus';
import { switcherRows } from './session-switcher-model';

type Area = Kind | 'local';
type Catalog = Partial<Record<Area, OpenSession[]>>;
type Props = {
  opened: OpenSession[]; order: string[]; activeKey: string | null; initialCatalog: Catalog;
  enabled: Partial<Record<Kind, boolean>>; onSelect: (session: OpenSession) => void; onClose: () => void;
  onCatalog: (area: Area, rows: OpenSession[]) => void;
};
export function SessionSwitcher({ opened, order, activeKey, initialCatalog, enabled, onSelect, onClose, onCatalog }: Props) {
  const [catalog, setCatalog] = useState(initialCatalog), [query, setQuery] = useState(''), [scope, setScope] = useState('all');
  const [errors, setErrors] = useState<Partial<Record<Area, string>>>({}), [loading, setLoading] = useState<Partial<Record<Area, boolean>>>({}), [limit, setLimit] = useState(50);
  const search = useRef<HTMLInputElement>(null), close = useRef<HTMLButtonElement>(null), previousFocus = useRef(document.activeElement as HTMLElement | null), mounted = useRef(true);
  const onCatalogRef = useRef(onCatalog); onCatalogRef.current = onCatalog;
  const load = async (area: Area) => {
    setLoading(value => ({ ...value, [area]: true }));
    setErrors(value => ({ ...value, [area]: '' }));
    try {
      const response = await api<Session[] | LocalSession[]>(area === 'local' ? '/local/sessions' : `/agents/${area}/sessions/cache`);
      const rows: OpenSession[] = area === 'local' ? response.filter(row => row.kind === 'local') as LocalSession[] : normalizeSessions(response as Session[]);
      if (!mounted.current) return;
      setCatalog(value => ({ ...value, [area]: rows })); onCatalogRef.current(area, rows);
    } catch (error) { if (mounted.current) setErrors(value => ({ ...value, [area]: errorMessage(error) })); }
    finally { if (mounted.current) setLoading(value => ({ ...value, [area]: false })); }
  };
  useEffect(() => {
    mounted.current = true;
    for (const area of ['local', 'codex', 'hermes', 'pi'] as Area[]) if (area === 'local' || enabled[area] !== false) void load(area);
    return () => { mounted.current = false; };
  }, []);
  const rows = switcherRows(opened, order, Object.entries(catalog).flatMap(([area, rows]) => area === 'local' || enabled[area as Kind] !== false ? rows || [] : []), query, scope === 'open');
  const openedKeys = new Set(opened.map(openSessionKey));
  const failures = Object.entries(errors).filter(([, message]) => !!message);
  const [errorsOpen, setErrorsOpen] = useState(() => !isMobile());
  return <Dialog.Root open onOpenChange={value => !value && onClose()}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content className="session-switcher dialog" onCloseAutoFocus={event => restoreDialogFocus(event, previousFocus.current)}
      onOpenAutoFocus={event => { event.preventDefault(); (isMobile() ? close.current : search.current)?.focus({ preventScroll: true }); }}>
      <header><div><Dialog.Title asChild><h2>切换会话</h2></Dialog.Title><Dialog.Description>搜索当前账户的已打开及已缓存会话。</Dialog.Description></div><Dialog.Close asChild><button ref={close} className="icon" aria-label="关闭会话切换器"><X /></button></Dialog.Close></header>
      <label className="switcher-search"><Search /><input ref={search} type="search" value={query} aria-label="搜索全部会话" placeholder="标题、目录、Agent 或角色"
        onChange={event => { setQuery(event.target.value); setLimit(50); }} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && rows[0]) { event.preventDefault(); const first = rows.find(row => row.kind === 'local' || enabled[row.kind] !== false); if (first) onSelect(first); } }} /></label>
      <ToggleGroup.Root className="switcher-scope" type="single" value={scope} onValueChange={value => { if (value) { setScope(value); setLimit(50); } }} aria-label="会话范围">
        <ToggleGroup.Item value="all">全部会话</ToggleGroup.Item><ToggleGroup.Item value="open">已打开</ToggleGroup.Item>
      </ToggleGroup.Root>
      <div className="switcher-feedback" role="status">{Object.values(loading).some(Boolean) ? '正在读取会话缓存…' : `${rows.length} 个会话`}</div>
      {!!failures.length && <Collapsible.Root className="switcher-errors" open={errorsOpen} onOpenChange={setErrorsOpen}><Collapsible.Trigger className="switcher-error-summary">{failures.length} 个来源未更新 · {errorsOpen ? '收起原因' : '查看原因'}</Collapsible.Trigger><Collapsible.Content>{failures.map(([area, message]) => <div className="switcher-error" key={area} role="alert"><span>{openSessionLabel({ kind: area as Area })}：{message}</span><button disabled={loading[area as Area]} onClick={() => void load(area as Area)}>重试</button></div>)}</Collapsible.Content></Collapsible.Root>}
      <div className="switcher-results">
        <Tabs.Root orientation="vertical" activationMode="manual" onValueChange={key => { const session = rows.find(row => openSessionKey(row) === key); if (session) onSelect(session); }}>
          <Tabs.List className="switcher-list" aria-label="会话搜索结果">{rows.slice(0, limit).map(session => {
            const key = openSessionKey(session);
            return <Tabs.Trigger className="switcher-result" key={key} value={key} disabled={session.kind !== 'local' && enabled[session.kind] === false}>
              <AgentIcon kind={session.kind} /><span className="switcher-result-copy"><strong>{openSessionTitle(session)}</strong><small>{openSessionLabel(session)}{session.kind !== 'local' && ` · ${session.profile || 'default'}`}</small><small title={session.workspace}>{displayWorkspacePath(session.workspace) || '未知工作区'}</small></span>
              {session.kind !== 'local' && enabled[session.kind] === false ? <span className="switcher-tag">Agent 已停用</span> : key === activeKey ? <span className="switcher-tag">当前</span> : openedKeys.has(key) && <span className="switcher-tag">已打开</span>}
            </Tabs.Trigger>;
          })}</Tabs.List>
        </Tabs.Root>
        {!rows.length && <p className="switcher-empty">{query ? '没有匹配的会话，试试其他关键词。' : scope === 'open' ? '还没有打开的会话。' : '暂无已缓存会话，可在侧栏新建或刷新原生会话。'}</p>}
        {rows.length > limit && <button className="switcher-more" onClick={() => setLimit(value => value + 50)}>显示更多</button>}
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
