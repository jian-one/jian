import { useEffect, useRef, useState } from "react";
import { Tabs, DropdownMenu } from "radix-ui";
import { X, MoreHorizontal, ListFilter } from "lucide-react";
import { adjacentTab } from "../../session-tabs";
import { openSessionKey, openSessionTitle, openSessionLabel, type OpenSession } from "../../shared/model";

export function SessionTabs({
  sessions, order, value, select, close, reorder, locked, onSwitcher,
}: {
  sessions: OpenSession[];
  order: string[];
  value: string | null;
  select: (key: string) => void;
  close: (key: string) => void;
  reorder: (from: string, to: string) => void;
  locked: boolean;
  onSwitcher: () => void;
}) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let frame = 0;
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const tab = list.querySelector<HTMLElement>('[data-state="active"]')?.parentElement;
        if (!tab) return;
        const bounds = list.getBoundingClientRect(), box = tab.getBoundingClientRect();
        if (box.left < bounds.left) list.scrollLeft += box.left - bounds.left;
        else if (box.right > bounds.right) list.scrollLeft += box.right - bounds.right;
      });
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [value, order]);
  return <Tabs.Root className="session-tabs" value={value || ""} onValueChange={select} activationMode="manual">
    <Tabs.List ref={listRef} className="session-tabs-list" aria-label="已打开的会话">
      {order.map(key => {
        const session = sessions.find(item => openSessionKey(item) === key);
        if (!session) return null;
        const title = openSessionTitle(session);
        return <div key={key} className={"session-tab " + (dragKey === key ? "dragging " : "") + (dropKey === key ? "drop-target" : "")}
          draggable={!locked}
          onDragStart={event => { if ((event.target as HTMLElement).closest(".session-tab-close")) { event.preventDefault(); return; } setDragKey(key); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", key); }}
          onDragOver={event => { event.preventDefault(); if (dragKey !== key) setDropKey(key); }}
          onDragLeave={() => setDropKey(current => current === key ? null : current)}
          onDrop={event => { event.preventDefault(); const from = event.dataTransfer.getData("text/plain") || dragKey; if (from && from !== key) reorder(from, key); setDragKey(null); setDropKey(null); }}
          onDragEnd={() => { setDragKey(null); setDropKey(null); }}>
          <Tabs.Trigger className="session-tab-trigger" disabled={locked} value={key} title={session.workspace}>
            <span data-tab-key={key} className="session-tab-kind">{openSessionLabel(session)}</span>
            <span className="session-tab-title">{title}</span>
          </Tabs.Trigger>
          <DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" className="session-tab-menu icon" aria-label={`${title} 标签操作`} disabled={locked}><MoreHorizontal /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="session-actions" align="end">
            <DropdownMenu.Label>{title}</DropdownMenu.Label><DropdownMenu.Label>{session.workspace}</DropdownMenu.Label>
            <DropdownMenu.Item disabled={order.indexOf(key) === 0} onSelect={() => reorder(key, order[order.indexOf(key) - 1])}>向左移动</DropdownMenu.Item>
            <DropdownMenu.Item disabled={order.indexOf(key) === order.length - 1} onSelect={() => reorder(key, order[order.indexOf(key) + 1])}>向右移动</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => close(key)}>关闭标签，进程继续运行</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
          <button type="button" className="session-tab-close" aria-label={`关闭 ${title}`} title="关闭标签页，进程继续运行"
            disabled={locked}
            onPointerDown={event => event.stopPropagation()}
            onClick={event => {
              const focused = event.currentTarget === document.activeElement;
              const next = key === value ? adjacentTab(order, key) : value;
              close(key);
              if (focused) requestAnimationFrame(() => {
                const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
                const target = Array.from(buttons || []).find(button => button.querySelector<HTMLElement>('[data-tab-key]')?.dataset.tabKey === next);
                (target || document.querySelector<HTMLButtonElement>('.empty-state button') || document.querySelector<HTMLButtonElement>('.agent-rail button.active, .mobile-nav-toggle'))?.focus({ preventScroll: true });
              });
            }}><X /></button>
        </div>;
      })}
    </Tabs.List>
    <button className="session-switcher-trigger icon" aria-label="切换会话" disabled={locked} onClick={onSwitcher}><ListFilter /></button>
  </Tabs.Root>;
}
