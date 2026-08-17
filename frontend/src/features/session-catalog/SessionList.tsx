import { DropdownMenu } from 'radix-ui';
import { MoreHorizontal, Pencil, Trash2, Unplug } from 'lucide-react';
import { channelNames, displayTitle, rawChannel, statusView, type Kind, type Session } from '../../shared/model';

type Props = {
  rows: Session[];
  listKind: Kind;
  listProfile?: string;
  activeID?: string;
  connectedID?: string | null;
  visibleCount: number;
  onSelect: (session: Session) => void;
  onDialog: (mode: 'rename' | 'delete', session: Session) => void;
  onDisconnect: (session: Session) => void;
  onShowMore: () => void;
};

function SessionActions({ kind, session, connected, onDialog, onDisconnect }: { kind: Kind; session: Session; connected: boolean; onDialog: Props['onDialog']; onDisconnect: Props['onDisconnect'] }) {
  const title = displayTitle(session);
  return <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="icon" aria-label={`${title} 的更多操作`} title="更多操作"><MoreHorizontal /></button></DropdownMenu.Trigger><DropdownMenu.Content className="session-actions" sideOffset={4} align="end"><DropdownMenu.Item asChild><button disabled={!connected} title={connected ? '断开当前浏览器连接' : '当前未连接'} onClick={() => onDisconnect(session)}><Unplug />断开连接</button></DropdownMenu.Item><DropdownMenu.Item asChild><button disabled={kind === 'codex'} title={kind === 'codex' ? 'Codex 原生会话不支持重命名' : '重命名'} onClick={() => onDialog('rename', session)}><Pencil />重命名</button></DropdownMenu.Item><DropdownMenu.Item asChild><button onClick={() => onDialog('delete', session)}><Trash2 />删除</button></DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Root>;
}

/** Session rows own their rendering rules; the workspace only supplies data and commands. */
export function SessionList({ rows, listKind, listProfile = '', activeID, connectedID, visibleCount, onSelect, onDialog, onDisconnect, onShowMore }: Props) {
  const shown = rows.slice(0, visibleCount);
  const hasMore = rows.length > shown.length;
  const key = `${listKind}:${listProfile}`;
  return <div className="session-list">
    {shown.map(session => {
      const title = displayTitle(session);
      const view = connectedID === session.id ? statusView('running') : statusView(session.status);
      const channel = channelNames[rawChannel(session).toLowerCase()] || rawChannel(session) || '未标注通道';
      return <div className={'session-row ' + (activeID === session.id ? 'active' : '')} key={session.id}>
        <button className="session" onClick={() => onSelect(session)}>
          <span className={'session-state ' + view.tone} aria-label={view.label} />
          <span className="session-copy"><strong title={title}>{title}</strong><small title={session.workspace}>{session.workspace || '未知工作区'}</small>{listKind !== 'codex' && <small title={channel}>{channel}</small>}</span>
        </button>
        <div className="session-menu"><SessionActions kind={listKind} session={session} connected={connectedID === session.id} onDialog={onDialog} onDisconnect={onDisconnect} /></div>
      </div>;
    })}
    {!rows.length && <div className="nav-empty"><span>暂无会话</span><small>从右侧工作区新建一个 {listKind === 'hermes' ? 'Hermes' : 'Codex'} 会话</small></div>}
    {hasMore ? <button className="session-more" onClick={onShowMore}>显示更多会话</button> : rows.length > 0 && <span className="session-end">已显示全部 {rows.length} 个会话</span>}
    <span aria-hidden="true" data-session-list-key={key} hidden />
  </div>;
}
