export function restoreDialogFocus(event: { preventDefault: () => void }, previous: HTMLElement | null) {
  event.preventDefault();
  const target = previous?.isConnected ? previous : document.querySelector<HTMLElement>('.mobile-nav-toggle, .session-tabs [data-state="active"], .empty-state button');
  target?.focus({ preventScroll: true });
}
