import { useRef, useState } from 'react';

export type MobileInputMode = 'read' | 'direct' | 'compose';
export type TerminalDraft = { text: string; lastSubmitted: string };
export const emptyDraft: TerminalDraft = { text: '', lastSubmitted: '' };
export const draftStorageKey = (user: string, session: string) => 'jian.terminal-draft.' + encodeURIComponent(user) + '.' + encodeURIComponent(session);
export const parseDraft = (raw: string | null): TerminalDraft => {
  try {
    const value = JSON.parse(raw || 'null');
    return value && typeof value.text === 'string' && typeof value.lastSubmitted === 'string' ? value : emptyDraft;
  } catch { return emptyDraft; }
};

export function useTerminalDrafts(user: string | null) {
  const cache = useRef(new Map<string, TerminalDraft>());
  const [, render] = useState(0);
  const [storageError, setStorageError] = useState('');
  const read = (session: string): TerminalDraft => {
    if (!user) return emptyDraft;
    const key = draftStorageKey(user, session);
    if (!cache.current.has(key)) {
      try { cache.current.set(key, parseDraft(sessionStorage.getItem(key))); }
      catch { cache.current.set(key, emptyDraft); }
    }
    return cache.current.get(key)!;
  };
  const write = (session: string, draft: TerminalDraft) => {
    if (!user) return;
    const key = draftStorageKey(user, session);
    cache.current.set(key, draft); render(value => value + 1);
    try { sessionStorage.setItem(key, JSON.stringify(draft)); setStorageError(''); }
    catch { setStorageError('草稿仅保留在当前页面，刷新可能丢失。'); }
  };
  const clear = () => {
    cache.current.clear(); setStorageError('');
    try {
      Object.keys(sessionStorage).filter(key => key.startsWith('jian.terminal-draft.')).forEach(key => sessionStorage.removeItem(key));
    } catch {}
  };
  return { read, write, clear, storageError };
}
