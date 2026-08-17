import { useRef } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { EnvironmentVariable } from '../model';

export function EnvironmentVariables({ values, onChange }: { values: EnvironmentVariable[]; onChange: (values: EnvironmentVariable[]) => void }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const add = () => { const index = values.length; onChange([...values, { key: '', value: '' }]); requestAnimationFrame(() => refs.current[index]?.focus()); };
  const update = (index: number, field: keyof EnvironmentVariable, value: string) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item));
  return <fieldset className="profile-settings environment-variables"><legend>环境变量</legend><small>会叠加在 Local 的环境变量之上，并用于启动、恢复和重启会话。</small><div className="environment-variable-list">{values.map((item, index) => <div key={index}><input ref={element => { refs.current[index] = element; }} value={item.key} onChange={event => update(index, 'key', event.target.value)} placeholder="变量名" aria-label={`环境变量 ${index + 1} 名称`} /><span aria-hidden="true">=</span><input value={item.value} onChange={event => update(index, 'value', event.target.value)} placeholder="变量值" aria-label={`环境变量 ${index + 1} 值`} /><button type="button" className="icon" aria-label={`移除环境变量 ${index + 1}`} title="移除环境变量" onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}><Trash2 /></button></div>)}</div><button type="button" className="icon launch-argument-add" onClick={add} aria-label="添加环境变量" title="添加环境变量"><Plus /></button></fieldset>;
}
