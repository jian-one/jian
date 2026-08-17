import type { ITheme } from '@xterm/xterm';
import { terminalThemeKey } from '../../shared/model';

const consoleTheme: ITheme = { background: '#080d0c', foreground: '#dce7e3', cursor: '#68d7a5', selectionBackground: '#315f4e99' };
const lightTheme: ITheme = { background: '#f8fafc', foreground: '#172033', cursor: '#2563eb', selectionBackground: '#9db8ff80' };
export const terminalThemeRegistry = [
  { id: 'console', label: '默认主题', description: '深绿信号与低照度工作台', theme: consoleTheme },
  { id: 'light', label: '浅色主题', description: '日间阅读与清晰层级', theme: lightTheme },
  { id: 'atom-one-dark', label: 'Atom One Dark', description: '经典深色代码配色', theme: { background: '#21252b', foreground: '#abb2bf', cursor: '#abb2bf', cursorAccent: '#21252b', selectionBackground: '#323844', selectionForeground: '#abb2bf', black: '#21252b', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf', brightBlack: '#767676', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#abb2bf' } satisfies ITheme },
  { id: 'atom-one-light', label: 'Atom One Light', description: '经典浅色代码配色', theme: { background: '#f9f9f9', foreground: '#2a2c33', cursor: '#bbbbbb', cursorAccent: '#ffffff', selectionBackground: '#ededed', selectionForeground: '#2a2c33', black: '#000000', red: '#de3d4b', green: '#3f954a', yellow: '#d2b653', blue: '#2f5ff7', magenta: '#950095', cyan: '#3f954a', white: '#bbbbbb', brightBlack: '#000000', brightRed: '#de3d4b', brightGreen: '#3f954a', brightYellow: '#d2b653', brightBlue: '#2f5ff7', brightMagenta: '#950095', brightCyan: '#3f954a', brightWhite: '#ffffff' } satisfies ITheme },
] as const;
export type TerminalTheme = typeof terminalThemeRegistry[number]['id'];
export const terminalThemeOptions = terminalThemeRegistry.map(({ theme: _theme, ...option }) => option);
export const terminalThemes = Object.fromEntries(terminalThemeRegistry.map(({ id, theme }) => [id, theme])) as Record<TerminalTheme, ITheme>;
export const terminalThemeColors = Object.fromEntries(terminalThemeRegistry.map(({ id, theme }) => [id, { background: theme.background!, foreground: theme.foreground! }])) as Record<TerminalTheme, { background: string; foreground: string }>;
export const initialTerminalTheme = (): TerminalTheme => {
  const stored = localStorage.getItem(terminalThemeKey);
  if (stored !== null) return terminalThemeRegistry.some(theme => theme.id === stored) ? stored as TerminalTheme : 'console';
  return localStorage.getItem('jian.theme') === 'light' ? 'light' : 'console';
};
