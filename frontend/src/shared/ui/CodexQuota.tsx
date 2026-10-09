import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, errorMessage } from '../api';
import { formatCodexQuota, type CodexQuota } from '../codex-quota';

const QuotaContext = createContext({ text: '额度加载中…', error: '' });

export function CodexQuotaProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [quota, setQuota] = useState({ text: '额度加载中…', error: '' });
  useEffect(() => {
    if (!enabled) return;
    setQuota({ text: '额度加载中…', error: '' });
    let cancelled = false, pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const value = await api<CodexQuota>('/agents/codex/rate-limits');
        if (!cancelled) setQuota({ text: formatCodexQuota(value), error: '' });
      } catch (error) {
        if (!cancelled) setQuota({ text: '额度暂不可用', error: errorMessage(error) });
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    const visible = () => void refresh();
    document.addEventListener('visibilitychange', visible);
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [enabled]);
  return <QuotaContext.Provider value={quota}>{children}</QuotaContext.Provider>;
}

export function CodexQuotaStatus() {
  const quota = useContext(QuotaContext);
  return <span className="codex-quota" title={quota.error || 'Codex 账号剩余额度，每 30 秒刷新；Reset 为可用重置次数'} aria-label={'Codex 额度：' + quota.text}>{quota.text}</span>;
}
