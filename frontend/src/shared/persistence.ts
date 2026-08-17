import type { LocalSession, Session } from './model';

export const recentWorkspaces = (sessions: Array<Pick<Session | LocalSession, 'workspace'>>) => Array.from(new Set(sessions.map(s => s.workspace).filter(p => p === '~' || p.startsWith('/')))).slice(0, 5);
