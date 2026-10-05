import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { DropdownMenu } from 'radix-ui';

type MenuShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  content: ReactNode;
  contentClassName: string;
  ariaLabel: string;
};

const menuItems = (content: ReactNode): ReactNode => Children.map(content, child => {
  if (!isValidElement<{ children?: ReactNode }>(child)) return child;
  if (child.type === Fragment) return menuItems(child.props.children);
  return child.type === 'button' ? <DropdownMenu.Item asChild>{child}</DropdownMenu.Item> : child;
});

export function MenuPopup({ open, onOpenChange, trigger, content, contentClassName, ariaLabel }: MenuShellProps) {
  return <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
    <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
    <DropdownMenu.Content className={contentClassName} aria-label={ariaLabel} sideOffset={8} align="end">
      {menuItems(content)}
    </DropdownMenu.Content>
  </DropdownMenu.Root>;
}
