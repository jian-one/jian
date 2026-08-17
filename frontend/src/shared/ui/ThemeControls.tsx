import { useRef, useState } from 'react';
import { Palette, SquareTerminal } from 'lucide-react';
import { Popover } from 'radix-ui';
import { themeOptions, type Theme } from '../model';
import { terminalThemeColors, terminalThemeOptions, type TerminalTheme } from '../../features/terminal/themes';

type Picker = 'interface' | 'terminal';

export function ThemeControls({ interfaceTheme, terminalTheme, onInterfaceThemeChange, onTerminalThemeChange }: { interfaceTheme: Theme; terminalTheme: TerminalTheme; onInterfaceThemeChange: (theme: Theme) => void; onTerminalThemeChange: (theme: TerminalTheme) => void }) {
  const [active, setActive] = useState<Picker | null>(null);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const label = active === 'terminal' ? 'Terminal 配色' : '界面主题';
  const theme = active === 'terminal' ? terminalTheme : interfaceTheme;
  const toggle = (id: Picker) => (event: React.MouseEvent<HTMLButtonElement>) => {
    anchor.current = event.currentTarget;
    setActive(current => current === id ? null : id);
  };
  return <Popover.Root open={active !== null} onOpenChange={open => { if (!open) setActive(null); }}>
    <Popover.Anchor virtualRef={anchor} />
    <div className="theme-picker"><button className="icon theme-toggle" aria-label="界面主题" title="界面主题" aria-haspopup="dialog" aria-expanded={active === 'interface'} onClick={toggle('interface')}><Palette /></button></div>
    <div className="theme-picker"><button className="icon theme-toggle" aria-label="Terminal 配色" title="Terminal 配色" aria-haspopup="dialog" aria-expanded={active === 'terminal'} onClick={toggle('terminal')}><SquareTerminal /></button></div>
    <Popover.Portal>
      <Popover.Content className="theme-menu" aria-label={label} sideOffset={9} align="end" onPointerDownOutside={event => { const target = event.detail.originalEvent.target; if (target instanceof Element && target.closest('.theme-toggle')) event.preventDefault(); }}>
        <header><strong>{label}</strong></header>
        <div>{(active === 'terminal' ? terminalThemeOptions : themeOptions).map(option => { const colors = active === 'terminal' ? terminalThemeColors[option.id as TerminalTheme] : undefined; return <Popover.Close asChild key={option.id}><button className={'theme-option ' + (theme === option.id ? 'selected' : '')} data-theme-preview={option.id} aria-pressed={theme === option.id} onClick={() => active === 'terminal' ? onTerminalThemeChange(option.id as TerminalTheme) : onInterfaceThemeChange(option.id as Theme)}><span className="theme-swatch" aria-hidden="true" style={colors ? { background: colors.background, borderColor: colors.foreground } : undefined}><i style={colors ? { background: colors.foreground } : undefined} /><i style={colors ? { background: colors.foreground } : undefined} /><i style={colors ? { background: colors.foreground } : undefined} /></span><span><strong>{option.label}</strong><small>{option.description}</small></span>{theme === option.id && <span className="theme-current">当前</span>}</button></Popover.Close>; })}</div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
