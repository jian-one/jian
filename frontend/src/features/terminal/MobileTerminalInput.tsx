import { useEffect, useRef, useState, type RefObject } from 'react';
import { Collapsible, ToggleGroup, Popover, Toolbar } from 'radix-ui';
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
  enter: (mode: 'direct' | 'compose') => void;
};
export function MobileTerminalInput({ mode, draft, storageError, editor, ready, onDraft, send, pasteText, leave, enter }: Props) {
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
    {mode !== 'read' && <ToggleGroup.Root type="single" value={mode} className="mobile-input-modes" aria-label="输入方式" onValueChange={value => { if (value === 'compose' || value === 'direct') enter(value); }}><ToggleGroup.Item value="compose">文本编辑</ToggleGroup.Item><ToggleGroup.Item value="direct" disabled={!ready}>实时终端</ToggleGroup.Item></ToggleGroup.Root>}
    {mode === 'direct' && <Toolbar.Root className="mobile-control-bar" aria-label="终端控制键"
      onPointerDownCapture={event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); }}>
      <div className="mobile-control-scroll">
        <Toolbar.Button disabled={!ready} onClick={() => send('\u001b')}>ESC</Toolbar.Button>
        <Toolbar.Button disabled={!ready} onClick={() => send(shift ? '\u001b[Z' : '\t')}>TAB</Toolbar.Button>
        {(['D', 'A', 'B', 'C'] as const).map((direction, index) => <Toolbar.Button key={direction} disabled={!ready}
          aria-label={['方向键左', '方向键上', '方向键下', '方向键右'][index]}
          onClick={() => send('\u001b[' + (shift ? '1;2' : '') + direction)}>{['←', '↑', '↓', '→'][index]}</Toolbar.Button>)}
        <Toolbar.Button aria-label="Shift" aria-pressed={shift} disabled={!ready} onClick={() => setShift(value => !value)}>SHIFT</Toolbar.Button>
        <Toolbar.Button disabled={!ready} aria-label="中断 Ctrl+C" onClick={() => send('\u0003')}>Ctrl+C</Toolbar.Button>
        <Popover.Root><Popover.Trigger asChild><Toolbar.Button disabled={!ready} aria-label="扩展终端按键">扩展按键</Toolbar.Button></Popover.Trigger><Popover.Portal><Popover.Content className="terminal-extra-keys" side="top" onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()} onPointerDownCapture={event => event.preventDefault()}>
          {([['Ctrl+D', '\u0004'], ['Ctrl+L', '\u000c'], ['Ctrl+Z', '\u001a'], ['Home', '\u001b[H'], ['End', '\u001b[F'], ['PageUp', '\u001b[5~'], ['PageDown', '\u001b[6~']] as const).map(([label, data]) => <Toolbar.Button key={label} onClick={() => send(data)}>{label}</Toolbar.Button>)}
        </Popover.Content></Popover.Portal></Popover.Root>
      </div>
      <Toolbar.Button disabled={!ready} onClick={() => send('\r')}>Enter</Toolbar.Button><Toolbar.Button onClick={() => { setShift(false); leave(); }}>收起</Toolbar.Button>
    </Toolbar.Root>}
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
