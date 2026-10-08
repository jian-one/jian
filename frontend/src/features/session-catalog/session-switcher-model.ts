import { openSessionKey, openSessionLabel, openSessionTitle, sessionTime, type OpenSession } from '../../shared/model.ts';

export function switcherRows(opened: OpenSession[], order: string[], catalog: OpenSession[], query = '', onlyOpened = false) {
  const open = new Map(opened.map(session => [openSessionKey(session), session]));
  const rows = new Map<string, OpenSession>();
  for (const session of [...catalog, ...opened]) {
    if (!session || typeof session.id !== 'string' || !session.id || typeof session.title !== 'string' || typeof session.workspace !== 'string' || !['local', 'codex', 'hermes', 'pi'].includes(session.kind)) continue;
    rows.set(openSessionKey(session), session);
  }
  const positions = new Map(order.map((key, index) => [key, index]));
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return [...rows.values()].filter(session => {
    const key = openSessionKey(session);
    const text = `${openSessionTitle(session)} ${session.workspace} ${session.id} ${openSessionLabel(session)} ${session.kind === 'local' ? '' : session.profile || 'default'}`.toLocaleLowerCase();
    return (!onlyOpened || open.has(key)) && words.every(word => text.includes(word));
  }).sort((a, b) => {
    const ak = openSessionKey(a), bk = openSessionKey(b);
    if (open.has(ak) !== open.has(bk)) return open.has(ak) ? -1 : 1;
    if (open.has(ak)) return (positions.get(ak) ?? order.length) - (positions.get(bk) ?? order.length);
    return (b.kind === 'local' ? 0 : sessionTime(b)) - (a.kind === 'local' ? 0 : sessionTime(a));
  });
}
