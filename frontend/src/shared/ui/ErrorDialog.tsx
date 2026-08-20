import { Dialog } from 'radix-ui';

export function ErrorDialog({ open, message, onClose }: { open: boolean; message: string; onClose: () => void }) {
  return <Dialog.Root open={open} onOpenChange={value => !value && onClose()}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog" aria-describedby="error-dialog-description">
        <header><div><span className="eyebrow">操作失败</span><Dialog.Title>无法完成操作</Dialog.Title></div></header>
        <Dialog.Description id="error-dialog-description" className="error">{message}</Dialog.Description>
        <footer><Dialog.Close asChild><button type="button">知道了</button></Dialog.Close></footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
