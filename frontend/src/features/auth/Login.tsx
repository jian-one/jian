import { useState } from 'react';
import { api, errorMessage } from '../../shared/api';

export function Login({ done }: { done: () => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  return <main className="login"><section className="login-intro"><div className="login-signal" aria-hidden="true"><i /><i /><i /><i /></div><span className="eyebrow">LOCAL / AUTHENTICATED / PERSISTENT</span><h1><span>代理继续运行，</span><span>浏览器只是窗口。</span></h1><p>在一个本地工作台中启动、恢复并观察 Codex 与 Hermes 会话。</p><div className="login-capabilities"><span><i />服务器持有终端进程</span><span><i />断线后自动回放输出</span><span><i />工作区与会话保持隔离</span></div></section><form className="card" onSubmit={async event => { event.preventDefault(); setError(''); try { await api('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }); await done(); } catch (err) { setError(errorMessage(err)); } }}><div className="brand"><span className="brand-mark"><img src="/app_icon.svg" alt="" /></span><span className="brand-copy"><strong>Jian</strong><small>LOCAL AGENT CONTROL</small></span></div><div className="login-heading"><span className="eyebrow">受保护的本地入口</span><h2>登录工作台</h2><p>使用管理员凭据继续</p></div><label>用户名<input autoFocus autoComplete="username" placeholder="管理员用户名" value={username} onChange={event => setUsername(event.target.value)} /></label><label>密码<input type="password" autoComplete="current-password" placeholder="管理员密码" value={password} onChange={event => setPassword(event.target.value)} /></label>{error && <p className="error" role="alert">{error}</p>}<button>进入工作台</button></form></main>;
}
