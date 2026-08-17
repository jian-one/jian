import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, File, FolderOpen, Home, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { api, errorMessage } from '../api';
import type { BrowseResult } from '../model';
import { beginSessionLoad, isCurrentSessionLoad, type SessionLoadVersion } from '../../session-load-guard';

export function ProfileFilePicker({ open, onOpenChange, select }: { open: boolean; onOpenChange: (open: boolean) => void; select: (path: string) => void }) {
  const [current, setCurrent] = useState('');
  const [parent, setParent] = useState('');
  const [entries, setEntries] = useState<BrowseResult['entries']>([]);
  const [manual, setManual] = useState('~');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const browseVersion = useRef<SessionLoadVersion>({ current: 0 });
  const browse = async (path: string) => {
    const version = beginSessionLoad(browseVersion.current);
    setLoading(true);
    try {
      const value = await api<BrowseResult>(`/workspaces/browse?path=${encodeURIComponent(path)}`);
      if (!isCurrentSessionLoad(browseVersion.current, version)) return;
      setCurrent(value.path); setParent(value.parent); setManual(value.path); setEntries(value.entries); setError('');
    } catch (cause) { if (isCurrentSessionLoad(browseVersion.current, version)) setError(errorMessage(cause)); } finally { if (isCurrentSessionLoad(browseVersion.current, version)) setLoading(false); }
  };
  useEffect(() => { if (open) void browse('~'); }, [open]);
  const pathFor = (name: string) => current === '/' ? `/${name}` : `${current}/${name}`;
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="workspace-overlay profile-file-overlay" /><Dialog.Content className="workspace-picker profile-file-picker" aria-label="选择 profile 文件"><header><div><span className="eyebrow">BASH PROFILE</span><Dialog.Title>选择启动文件</Dialog.Title><Dialog.Description>选择后将加入 Bash 的加载顺序</Dialog.Description></div><Dialog.Close className="icon" aria-label="关闭文件选择器"><X /></Dialog.Close></header><form className="workspace-path" onSubmit={event => { event.preventDefault(); void browse(manual); }}><button type="button" aria-label="用户主目录" title="用户主目录" onClick={() => void browse('~')}><Home /></button><button type="button" aria-label="上级目录" title="上级目录" disabled={!parent || parent === current || loading} onClick={() => void browse(parent)}><ChevronLeft /></button><input value={manual} onChange={event => setManual(event.target.value)} aria-label="文件目录路径" /><button type="submit" disabled={loading}>前往</button></form><div className="directory-list">{entries.map(entry => entry.directory ? <button key={entry.name} disabled={loading} onClick={() => void browse(pathFor(entry.name))}><FolderOpen /><span>{entry.name}</span><ChevronDown /></button> : <button key={entry.name} className="profile-file-entry" onClick={() => select(pathFor(entry.name))}><File /><span>{entry.name}</span></button>)}</div>{error && <p className="error workspace-error">{error}</p>}<footer><span title={current}>{current || '~'}</span></footer></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
