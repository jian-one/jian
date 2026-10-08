import { useEffect, useRef, useState, useImperativeHandle, type ChangeEvent } from 'react';
import { NotebookPen } from 'lucide-react';
import { Popover, Tooltip } from 'radix-ui';
import * as Y from 'yjs';
import { api, onSocketEvent } from '../../shared/api';

type NoteState = { state: string };
type NoteUpdate = { update?: string };
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64 = (value: string) => {
  const standard = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(standard + '='.repeat((4 - standard.length % 4) % 4)), char => char.charCodeAt(0));
};
const cacheKey = (username: string) => `jian.quick-note.${username}`;

function replaceText(node: HTMLTextAreaElement, next: string) {
  const previous = node.value;
  if (previous === next) return;
  let start = 0, previousEnd = previous.length, nextEnd = next.length;
  while (start < previousEnd && start < nextEnd && previous[start] === next[start]) start++;
  while (previousEnd > start && nextEnd > start && previous[previousEnd - 1] === next[nextEnd - 1]) { previousEnd--; nextEnd--; }
  node.setRangeText(next.slice(start, nextEnd), start, previousEnd, 'preserve');
}

export function QuickNote({ username, openRef }: { username: string; openRef?: { current: (() => void) | null } }) {
  const textarea = useRef<HTMLTextAreaElement>(null), doc = useRef(new Y.Doc()), composing = useRef(false), pending = useRef<string[]>([]), loaded = useRef(false), cached = useRef(true), mounted = useRef(true), syncing = useRef(false);
  const [syncStatus, setSyncStatus] = useState('已保存');
  const [open, setOpen] = useState(false);
  useImperativeHandle(openRef, () => () => setOpen(true));
  const text = doc.current.getText('body');
  const persist = () => { try { localStorage.setItem(cacheKey(username), JSON.stringify({ state: toBase64(Y.encodeStateAsUpdate(doc.current)), pending: pending.current })); } catch { cached.current = false; } };
  const flush = async () => {
    if (syncing.current) return;
    syncing.current = true;
    setSyncStatus('待同步');
    try {
      if (!loaded.current) { const value = await api<NoteState>('/quick-note'); if (!mounted.current) { syncing.current = false; return; } Y.applyUpdate(doc.current, fromBase64(value.state), 'remote'); loaded.current = true; sync(); }
    } catch { syncing.current = false; setSyncStatus('读取失败，请重试'); return; }
    while (mounted.current && pending.current[0]) {
      try { await api('/quick-note', { method: 'PUT', body: JSON.stringify({ update: pending.current[0] }) }); pending.current.shift(); persist(); }
      catch { setSyncStatus(cached.current ? '同步失败，已保留本地副本' : '同步失败，本地存储不可用，请保留此页面'); break; }
    }
    syncing.current = false;
    if (!pending.current.length) setSyncStatus('已保存');
  };
  const sync = () => { if (!composing.current && textarea.current) replaceText(textarea.current, text.toString()); };

  useEffect(() => {
    mounted.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(cacheKey(username)) || '{}') as { state?: string; pending?: string[] };
      if (saved.state) Y.applyUpdate(doc.current, fromBase64(saved.state), 'cache');
      pending.current = Array.isArray(saved.pending) ? saved.pending : [];
    } catch {}
    const update = (value: Uint8Array, origin: unknown) => {
      if (origin !== 'remote' && origin !== 'cache') { pending.current.push(toBase64(value)); persist(); void flush(); }
      sync();
    };
    doc.current.on('update', update);
    const remove = onSocketEvent('quick-note.update', message => {
      const update = (message as NoteUpdate).update;
      if (update) try { Y.applyUpdate(doc.current, fromBase64(update), 'remote'); } catch {}
    });
    void flush();
    return () => { mounted.current = false; remove(); doc.current.off('update', update); };
  }, [username]);

  const change = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value, previous = text.toString();
    let start = 0, previousEnd = previous.length, nextEnd = next.length;
    while (start < previousEnd && start < nextEnd && previous[start] === next[start]) start++;
    while (previousEnd > start && nextEnd > start && previous[previousEnd - 1] === next[nextEnd - 1]) { previousEnd--; nextEnd--; }
    doc.current.transact(() => { if (previousEnd > start) text.delete(start, previousEnd - start); if (nextEnd > start) text.insert(start, next.slice(start, nextEnd)); });
  };

  return <Tooltip.Provider delayDuration={250}><Popover.Root open={open} onOpenChange={setOpen}><Tooltip.Root><Tooltip.Trigger asChild><Popover.Trigger asChild><button className="quick-note-toggle" aria-label="快速记事本"><NotebookPen /></button></Popover.Trigger></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip" side="left">快速记事本<Tooltip.Arrow /></Tooltip.Content></Tooltip.Portal></Tooltip.Root><Popover.Portal><Popover.Content className="quick-note" side="bottom" align="end" sideOffset={12} onCloseAutoFocus={event => { const dock = document.querySelector<HTMLButtonElement>('button[aria-label="更多工作台操作"]'); if (dock) { event.preventDefault(); dock.focus({ preventScroll: true }); } }} onOpenAutoFocus={event => { event.preventDefault(); textarea.current?.focus(); }}><label htmlFor="quick-note-body">快速记事本</label><div className="note-sync-status" role="status"><span>{syncStatus}</span>{syncStatus !== '已保存' && <button type="button" onClick={() => void flush()}>重试同步</button>}</div><textarea id="quick-note-body" ref={textarea} defaultValue={text.toString()} onChange={change} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; sync(); }} placeholder="随手记下想法…" maxLength={100000} /></Popover.Content></Popover.Portal></Popover.Root></Tooltip.Provider>;
}
