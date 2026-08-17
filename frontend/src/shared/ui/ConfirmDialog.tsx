import { X } from 'lucide-react';
import { Dialog } from 'radix-ui';

export function ConfirmDialog({ open, title, description, confirmLabel, danger = false, busy = false, onConfirm, onClose }: { open: boolean; title: string; description: string; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return <Dialog.Root open={open} onOpenChange={value => !value && !busy && onClose()}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog" aria-describedby="confirm-dialog-description">
        <header><div><span className="eyebrow">请确认操作</span><Dialog.Title asChild><h3>{title}</h3></Dialog.Title></div><Dialog.Close asChild><button type="button" className="icon" aria-label="关闭对话框" disabled={busy}><X /></button></Dialog.Close></header>
        <Dialog.Description id="confirm-dialog-description">{description}</Dialog.Description>
        <footer><Dialog.Close asChild><button type="button" disabled={busy}>取消</button></Dialog.Close><button className={danger ? 'danger' : ''} disabled={busy} onClick={onConfirm}>{busy ? '处理中…' : confirmLabel}</button></footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
