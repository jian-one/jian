import { Popover } from 'radix-ui';
import { SlidersHorizontal } from 'lucide-react';
import { ThemeControls } from './ThemeControls';
import { TerminalFontSizeControl } from './TerminalFontSizeControl';
import type { Theme } from '../model';
import type { TerminalTheme } from '../../features/terminal/themes';

type Props = {
  theme: Theme; terminalTheme: TerminalTheme; fontSize: number;
  onThemeChange: (value: Theme) => void;
  onTerminalThemeChange: (value: TerminalTheme) => void;
  onFontSizeChange: (value: number) => void;
};
export function WorkbenchTools({ theme, terminalTheme, fontSize, onThemeChange, onTerminalThemeChange, onFontSizeChange }: Props) {
  return <Popover.Root><Popover.Trigger asChild><button className="icon" aria-label="外观与终端工具" title="外观与终端工具"><SlidersHorizontal /></button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="workbench-tools-menu" align="end" sideOffset={8} aria-label="外观与终端工具">
      <div><span>界面与终端配色</span><ThemeControls interfaceTheme={theme} terminalTheme={terminalTheme} onInterfaceThemeChange={onThemeChange} onTerminalThemeChange={onTerminalThemeChange} /></div>
      <div><span>终端字号</span><TerminalFontSizeControl size={fontSize} onChange={onFontSizeChange} /></div>
    </Popover.Content></Popover.Portal></Popover.Root>;
}
