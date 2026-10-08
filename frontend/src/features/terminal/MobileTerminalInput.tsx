import { useEffect, useRef, useState, type RefObject } from 'react';
import { Collapsible } from 'radix-ui';
import type { MobileInputMode, TerminalDraft } from './mobile-state';

export type TerminalActions = {
  enter: (mode: 'direct' | 'compose') => void;
  leave: () => void;
  search: () => void;
  copy: () => void;
  paste: () => void;
};
type Props = {
  mode: MobileInputMode; draft: TerminalDraft; storageError: string;
  editor: RefObject<HTMLTextAreaElement | null>; ready: boolean;
  onDraft: (draft: TerminalDraft) => void; send: (data: string) => boolean;
  pasteText: (text: string) => boolean; leave: () => void;
};
export function MobileTerminalInput({ mode, draft, storageError, editor, ready, onDraft, send, pasteText, leave }: Props) {
  const [shift, setShift] = useState(false), [composing, setComposing] = useState(false);
  const submitting = useRef(false);
  const accepted = useRef<string | null>(null);
  useEffect(() => { accepted.current = null; }, [draft.text]);
  useEffect(() => { if (mode !== 'direct') setShift(false); if (mode !== 'compose') setComposing(false); }, [mode]);
  const submit = (enter: boolean) => {
    if (composing || submitting.current || accepted.current === draft.text || !draft.text || !ready) return;
    submitting.current = true;
    try {
      if (!pasteText(draft.text)) return;
      if (enter && !send('\r')) return;
      accepted.current = draft.text;
      onDraft({ text: '', lastSubmitted: draft.text });
    } finally { submitting.current = false; }
  };
  return <div className="mobile-terminal-input">
    {mode === 'direct' && <div className="mobile-control-bar" role="toolbar" aria-label="终端控制键"
      onPointerDownCapture={event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); }}>
      <div className="mobile-control-scroll">
        <button disabled={!ready} onClick={() => send('\u001b')}>ESC</button>
        <button disabled={!ready} onClick={() => send(shift ? '\u001b[Z' : '\t')}>TAB</button>
        {(['D', 'A', 'B', 'C'] as const).map((direction, index) => <button key={direction} disabled={!ready}
          aria-label={['方向键左', '方向键上', '方向键下', '方向键右'][index]}
          onClick={() => send('\u001b[' + (shift ? '1;2' : '') + direction)}>{['←', '↑', '↓', '→'][index]}</button>)}
        <button aria-label="Shift" aria-pressed={shift} disabled={!ready} onClick={() => setShift(value => !value)}>SHIFT</button>
        <button disabled={!ready} aria-label="中断 Ctrl+C" onClick={() => send('\u0003')}>Ctrl+C</button>
      </div>
      <button disabled={!ready} onClick={() => send('\r')}>Enter</button><button onClick={() => { setShift(false); leave(); }}>收起</button>
    </div>}
    <Collapsible.Root open={mode === 'compose'} className="mobile-composer">
      <Collapsible.Content>
        <label htmlFor="mobile-terminal-editor">文本编辑 · 回车换行</label>
        <textarea id="mobile-terminal-editor" ref={editor} aria-label="编辑终端文本" value={draft.text}
          autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false}
          enterKeyHint="enter" onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
          onChange={event => onDraft({ ...draft, text: event.target.value })} />
        <div className="mobile-composer-actions">
          {draft.lastSubmitted && !draft.text && <button onClick={() => onDraft({ ...draft, text: draft.lastSubmitted })}>恢复最近提交</button>}
          <button onClick={leave}>收起</button>
          <button disabled={!ready || !draft.text || composing} onClick={() => submit(false)}>发送文本</button>
          <button disabled={!ready || !draft.text || composing} onClick={() => submit(true)}>发送并回车</button>
        </div>
        {storageError && <p role="status">{storageError}</p>}
      </Collapsible.Content>
    </Collapsible.Root>
  </div>;
}
