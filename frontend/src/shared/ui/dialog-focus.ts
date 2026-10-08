export function restoreDialogFocus(event: { preventDefault: () => void }, previous: HTMLElement | null) {
  event.preventDefault();
  const target = previous?.isConnected && previous.getClientRects().length ? previous : document.querySelector<HTMLElement>('.mobile-workbench-dock button[aria-label="更多工作台操作"]') || document.querySelector<HTMLElement>('.mobile-nav-toggle, .session-tabs [data-state="active"], .empty-state button');
  target?.focus({ preventScroll: true });
}
