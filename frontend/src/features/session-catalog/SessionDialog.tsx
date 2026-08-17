import { useState } from 'react';
import { X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import type { Session } from '../../shared/model';
import { errorMessage } from '../../shared/api';

export function SessionDialog({ mode, session, close, confirm }: { mode: 'rename' | 'delete'; session: Session; close: () => void; confirm: (title?: string) => Promise<void> }) {
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try { await confirm(mode === 'rename' ? title : undefined); }
    catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  return <Dialog.Root open onOpenChange={open => !open && close()}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog" asChild>
        <form onSubmit={submit}>
          <header><div><span className="eyebrow">{mode === 'rename' ? '会话设置' : '不可恢复操作'}</span><Dialog.Title asChild><h3 id="session-dialog-title">{mode === 'rename' ? '重命名会话' : '永久删除会话'}</h3></Dialog.Title></div><Dialog.Close asChild><button type="button" className="icon" aria-label="关闭对话框" disabled={busy}><X /></button></Dialog.Close></header>
          {mode === 'rename' ? <label>会话名称<input value={title} onChange={event => setTitle(event.target.value)} required /></label> : <p>删除“{session.title}”会中止正在执行的任务，并永久删除原生会话记录。</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <footer><Dialog.Close asChild><button type="button" disabled={busy}>取消</button></Dialog.Close><button className={mode === 'delete' ? 'danger' : ''} disabled={busy || (mode === 'rename' && !title.trim())}>{busy ? '处理中…' : mode === 'rename' ? '保存名称' : '永久删除'}</button></footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
