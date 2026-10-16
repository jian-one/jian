import { activeView, byLastActiveDesc, type Kind, type Session } from './shared/model.ts';

export type SessionLoadVersion = { current: number };

export function beginSessionLoad(version: SessionLoadVersion): number {
  version.current += 1;
  return version.current;
}

export function invalidateSessionLoads(version: SessionLoadVersion): void {
  version.current += 1;
}

export function isCurrentSessionLoad(version: SessionLoadVersion, requestVersion: number): boolean {
  return version.current === requestVersion;
}

export function shouldRestoreNativeSession({ hasOpenSessions, hasActiveSession, isLocalArea }: { hasOpenSessions: boolean; hasActiveSession: boolean; isLocalArea: boolean }): boolean {
  return !hasOpenSessions && !hasActiveSession && !isLocalArea;
}

export function normalizeSessions(sessions: Session[]): Session[] {
  return sessions
    .map(activeView)
    .sort(byLastActiveDesc);
}

export function savedSession(sessions: Session[], id: string | null, kind: Kind): Session | undefined {
  return sessions.find(session => session.id === id && session.kind === kind);
}
