import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { NotebookPen } from 'lucide-react';
import { Popover, Tooltip } from 'radix-ui';
import * as Y from 'yjs';
import { api, onSocketEvent } from '../../shared/api';

type NoteState = { state: string };
type NoteUpdate = { update?: string };
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const cacheKey = (username: string) => `jian.quick-note.${username}`;

function replaceText(node: HTMLTextAreaElement, next: string) {
  const previous = node.value;
  if (previous === next) return;
  let start = 0, previousEnd = previous.length, nextEnd = next.length;
  while (start < previousEnd && start < nextEnd && previous[start] === next[start]) start++;
  while (previousEnd > start && nextEnd > start && previous[previousEnd - 1] === next[nextEnd - 1]) { previousEnd--; nextEnd--; }
  node.setRangeText(next.slice(start, nextEnd), start, previousEnd, 'preserve');
}

export function QuickNote({ username }: { username: string }) {
  const textarea = useRef<HTMLTextAreaElement>(null), doc = useRef(new Y.Doc()), composing = useRef(false), pending = useRef<string[]>([]), syncing = useRef(false);
  const [open, setOpen] = useState(false);
  const text = doc.current.getText('body');
  const persist = () => { try { localStorage.setItem(cacheKey(username), JSON.stringify({ state: toBase64(Y.encodeStateAsUpdate(doc.current)), pending: pending.current })); } catch {} };
  const flush = async () => {
    if (syncing.current) return;
    syncing.current = true;
    while (pending.current[0]) {
      try { await api('/quick-note', { method: 'PUT', body: JSON.stringify({ update: pending.current[0] }) }); pending.current.shift(); persist(); }
      catch { break; }
    }
    syncing.current = false;
  };
  const sync = () => { if (!composing.current && textarea.current) replaceText(textarea.current, text.toString()); };

  useEffect(() => {
    let active = true;
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
    void api<NoteState>('/quick-note').then(value => { if (active) { Y.applyUpdate(doc.current, fromBase64(value.state), 'remote'); sync(); void flush(); } }).catch(() => {});
    return () => { active = false; remove(); doc.current.off('update', update); };
  }, [username]);

  const change = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value, previous = text.toString();
    let start = 0, previousEnd = previous.length, nextEnd = next.length;
    while (start < previousEnd && start < nextEnd && previous[start] === next[start]) start++;
    while (previousEnd > start && nextEnd > start && previous[previousEnd - 1] === next[nextEnd - 1]) { previousEnd--; nextEnd--; }
    doc.current.transact(() => { if (previousEnd > start) text.delete(start, previousEnd - start); if (nextEnd > start) text.insert(start, next.slice(start, nextEnd)); });
  };

  return <Tooltip.Provider delayDuration={250}><Popover.Root open={open} onOpenChange={setOpen}><Tooltip.Root><Tooltip.Trigger asChild><Popover.Trigger asChild><button className="quick-note-toggle" aria-label="快速记事本"><NotebookPen /></button></Popover.Trigger></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip" side="left">快速记事本<Tooltip.Arrow /></Tooltip.Content></Tooltip.Portal></Tooltip.Root><Popover.Portal><Popover.Content className="quick-note" side="left" align="center" sideOffset={12} onOpenAutoFocus={event => { event.preventDefault(); textarea.current?.focus(); }}><label htmlFor="quick-note-body">快速记事本</label><textarea id="quick-note-body" ref={textarea} defaultValue={text.toString()} onChange={change} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; sync(); }} placeholder="随手记下想法…" maxLength={100000} /></Popover.Content></Popover.Portal></Popover.Root></Tooltip.Provider>;
}
