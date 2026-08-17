import type { ReactNode } from 'react';
import { DropdownMenu } from 'radix-ui';

type MenuShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  content: ReactNode;
  contentClassName: string;
  ariaLabel: string;
};

export function MenuPopup({ open, onOpenChange, trigger, content, contentClassName, ariaLabel }: MenuShellProps) {
  return <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
    <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
    <DropdownMenu.Content className={contentClassName} aria-label={ariaLabel} sideOffset={8} align="end">
      {content}
    </DropdownMenu.Content>
  </DropdownMenu.Root>;
}
