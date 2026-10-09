import { Popover } from 'radix-ui';
import { ChevronDown } from 'lucide-react';
import { AgentIcon } from './AgentIcon';
import { CodexQuotaStatus } from './CodexQuota';
import { openSessionLabel, openSessionTitle, displayWorkspace, displayChannel, type Kind, type OpenSession } from '../model';

export function SessionContext({ session, kind, profile }: { session: OpenSession | null; kind: Kind | 'local'; profile: string }) {
  const agent = openSessionLabel({ kind });
  const role = kind === 'hermes' || kind === 'pi' ? session?.kind === kind ? session.profile || 'default' : profile : '';
  const title = session ? openSessionTitle(session) : `${agent} 工作区`;
  const quota = kind === 'codex' && <CodexQuotaStatus />;
  const details = <><span className="agent-label"><AgentIcon kind={kind} />{agent}{role && ` · ${role}`}</span><div className="session-title-line"><h2>{title}</h2>{quota}</div>
    <div className="session-meta"><span>{session ? displayWorkspace(session) : '选择会话或新建会话开始工作'}</span>
      {session && session.kind !== 'local' && <span>{displayChannel(session)}</span>}
      {session && <span className="session-identity">会话 ID：{session.id}</span>}
    </div></>;
  return <div className="context-copy"><div className="desktop-session-context">{details}</div>
    <Popover.Root><Popover.Trigger asChild><button className="session-context-trigger" aria-label="查看会话详情"><AgentIcon kind={kind} /><span><small>{agent}{role && (" · " + role)}</small>{title}</span><ChevronDown /></button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="session-context-popover" align="start" sideOffset={8} aria-label="会话详情">{details}</Popover.Content></Popover.Portal>
    </Popover.Root><div className="mobile-codex-quota">{quota}</div></div>;
}
