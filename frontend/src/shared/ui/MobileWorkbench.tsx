import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Dialog } from 'radix-ui';
import { ListFilter, Keyboard, MoreHorizontal, X } from 'lucide-react';
import { SessionContext } from './SessionContext';
import { ThemeControls } from './ThemeControls';
import { TerminalFontSizeControl } from './TerminalFontSizeControl';
import { connectionView, type Kind, type OpenSession, type Theme, type ConnectionState } from '../model';
import type { TerminalTheme } from '../../features/terminal/themes';
import type { MobileInputMode } from '../../features/terminal/mobile-state';
import type { TerminalActions } from '../../features/terminal/MobileTerminalInput';

type Props = {
  session: OpenSession | null; kind: Kind | 'local'; profile: string; connection: ConnectionState;
  focused: boolean; mode: MobileInputMode; busy: boolean; attached: boolean;
  actions: { current: TerminalActions | null }; hasDraft: boolean;
  onSwitch: () => void; onNavigation: () => void; onCreate: () => void;
  onSettings: () => void; onNote: () => void; onFocus: () => void;
  onRelease: () => void; onRestart: () => void; onDisconnect: () => void; onReconnect: () => void;
  theme: Theme; terminalTheme: TerminalTheme; fontSize: number;
  onTheme: (value: Theme) => void; onTerminalTheme: (value: TerminalTheme) => void; onFontSize: (value: number) => void;
};
export function MobileWorkbench(p: Props) {
  const [panel, setPanel] = useState<'more' | 'appearance' | null>(null);
  const close = useRef<HTMLButtonElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const act = (action: () => void) => { flushSync(() => setPanel(null)); action(); };
  const view = connectionView(p.connection);
  const buttons: [string, () => void, boolean?][] = [
    ['文本编辑', () => p.actions.current?.enter('compose'), !p.session || !p.attached],
    ['搜索终端输出', () => p.actions.current?.search(), !p.session || !p.attached],
    ['选择输出文本', () => p.actions.current?.copy(), !p.session || !p.attached],
    ['粘贴到终端', () => p.actions.current?.paste(), p.connection !== 'connected'],
    ['新建会话', p.onCreate], ['会话目录与管理', p.onNavigation],
    ['快速记事本', p.onNote], ['设置', p.onSettings],
  ];
  return <>
    {!p.focused && <header className="mobile-workbench-header"><SessionContext session={p.session} kind={p.kind} profile={p.profile} />
      <span className={'status ' + view.tone} aria-label={'终端状态：' + view.label}>{view.label}</span></header>}
    <nav className="mobile-workbench-dock" aria-label="移动工作台">
      <button disabled={p.busy} aria-label="切换会话" onClick={() => { p.actions.current?.leave(); p.onSwitch(); }}><ListFilter /><span>会话</span></button>
      <button disabled={!p.session || !p.attached || p.busy || (p.mode === 'read' && p.connection !== 'connected')} aria-label={p.mode === 'read' ? '输入终端' : '收起输入'}
        onClick={() => p.mode === 'read' ? p.actions.current?.enter('direct') : p.actions.current?.leave()}>
        <Keyboard /><span>{p.mode === 'read' ? p.hasDraft ? '输入 · 草稿' : '输入' : '收起输入'}</span></button>
      <Dialog.Root open={panel !== null} onOpenChange={open => { if (!open) setPanel(null); }}>
        <Dialog.Trigger asChild><button ref={trigger} aria-label="更多工作台操作" disabled={p.busy}
          onClick={() => { p.actions.current?.leave(); setPanel('more'); }}><MoreHorizontal /><span>更多</span></button></Dialog.Trigger>
        <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="mobile-workbench-sheet dialog"
          onOpenAutoFocus={event => { event.preventDefault(); close.current?.focus({ preventScroll: true }); }}
          onCloseAutoFocus={event => { event.preventDefault(); if (!document.querySelector('.dialog-overlay, .terminal-search-bar') && !document.activeElement?.matches('input, textarea')) trigger.current?.focus({ preventScroll: true }); }}>
          <header><Dialog.Title>{panel === 'appearance' ? '外观与终端工具' : '工作台操作'}</Dialog.Title><Dialog.Close asChild><button ref={close} className="icon" aria-label="关闭工作台操作"><X /></button></Dialog.Close></header>
          <Dialog.Description>{panel === 'appearance' ? '界面配色与终端配色分别保存。' : '选择一个操作继续工作。'}</Dialog.Description>
          <div className="mobile-sheet-content">{panel === 'appearance' ? <>
            <div className="mobile-appearance"><ThemeControls interfaceTheme={p.theme} terminalTheme={p.terminalTheme} onInterfaceThemeChange={p.onTheme} onTerminalThemeChange={p.onTerminalTheme} /><TerminalFontSizeControl size={p.fontSize} onChange={p.onFontSize} /></div>
            <button onClick={() => setPanel('more')}>返回工作台操作</button>
          </> : <>
            {buttons.map(([label, action, disabled]) => <button key={label} aria-label={label} disabled={disabled} onClick={() => act(action)}>{label}</button>)}
            <button aria-label="外观与终端工具" onClick={() => setPanel('appearance')}>外观与终端工具</button>
            {p.session && <>
              <button aria-label={p.focused ? '退出专注模式' : '进入专注模式'} onClick={() => act(p.onFocus)}>{p.focused ? '退出专注模式' : '进入专注模式'}</button>
              <button disabled={p.connection === 'ended'} onClick={() => act(p.onReconnect)}>重新连接</button>
              <button onClick={() => act(p.onDisconnect)}>关闭当前会话显示</button>
              <button onClick={() => act(p.onRestart)}>重启当前会话</button><button onClick={() => act(p.onRelease)}>释放当前会话</button>
            </>}
          </>}</div>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>
    </nav>
  </>;
}
