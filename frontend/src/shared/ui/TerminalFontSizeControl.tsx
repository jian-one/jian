import { Minus, Plus } from 'lucide-react';
import { clampTerminalFontSize, terminalFontSizeMax, terminalFontSizeMin } from '../model';

export function TerminalFontSizeControl({ size, onChange, compact = false }: { size: number; onChange: (size: number) => void; compact?: boolean }) {
  const change = (delta: number) => onChange(clampTerminalFontSize(size + delta));
  return <div className={'terminal-font-size-control' + (compact ? ' compact' : '')} aria-label="终端字号">
    <button type="button" aria-label="减小终端字号" title="减小字号" disabled={size <= terminalFontSizeMin} onClick={() => change(-1)}><Minus /></button>
    <output>{size}px</output>
    <button type="button" aria-label="增大终端字号" title="增大字号" disabled={size >= terminalFontSizeMax} onClick={() => change(1)}><Plus /></button>
    {!compact && <input type="range" min={terminalFontSizeMin} max={terminalFontSizeMax} value={size} onChange={event => onChange(Number(event.target.value))} aria-label="终端字号滑块" />}
  </div>;
}
