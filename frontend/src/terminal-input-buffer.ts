export type TerminalInputEvent = {
  data: string | null;
  inputType: string;
  isComposing: boolean;
};

export const isPasteShortcut = (event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'key'>) =>
  !event.altKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v';

type TerminalInputBufferOptions = {
  clear: () => void;
  preview: (text: string) => void;
  read: () => string;
  send: (data: string) => void;
  defer?: (callback: () => void) => () => void;
};

const controlInput = (inputType: string) => {
  if (inputType === 'deleteContentBackward') return '\u007f';
  if (inputType === 'deleteContentForward') return '\u001b[3~';
  if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') return '\r';
  return null;
};

export const terminalKeyData = (event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'isComposing' | 'key' | 'metaKey'> & { keyCode?: number }) => {
  if (event.isComposing || event.key === 'Process' || event.keyCode === 229 || event.metaKey) return null;
  if (event.ctrlKey && !event.altKey) {
    if (event.key === ' ') return '\0';
    if (event.key.length === 1) {
      const code = event.key.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) return String.fromCharCode(code & 0x1f);
    }
  }
  const keys: Record<string, string> = {
    ArrowDown: '\u001b[B', ArrowLeft: '\u001b[D', ArrowRight: '\u001b[C', ArrowUp: '\u001b[A',
    Backspace: '\u007f', Delete: '\u001b[3~', End: '\u001b[F', Enter: '\r', Escape: '\u001b',
    Home: '\u001b[H', PageDown: '\u001b[6~', PageUp: '\u001b[5~', Tab: '\t',
  };
  return keys[event.key] || (event.altKey && !event.ctrlKey && event.key.length === 1 ? `\u001b${event.key}` : null);
};

export class TerminalInputBuffer {
  private cancelDeferred?: () => void;
  private composing = false;
  private readonly options: TerminalInputBufferOptions;

  constructor(options: TerminalInputBufferOptions) {
    this.options = options;
  }

  compositionStart() {
    this.cancelPendingCommit();
    this.composing = true;
    this.options.preview('');
  }

  compositionUpdate(text: string) {
    if (this.composing) this.options.preview(text);
  }

  compositionEnd(fallback: string) {
    this.composing = false;
    this.cancelPendingCommit();
    const defer = this.options.defer || (callback => {
      const id = window.setTimeout(callback, 0);
      return () => window.clearTimeout(id);
    });
    this.cancelDeferred = defer(() => {
      this.cancelDeferred = undefined;
      this.commit(fallback);
    });
  }

  beforeInput(inputType: string, isComposing: boolean) {
    if (this.composing || isComposing) return null;
    const data = controlInput(inputType);
    if (!data) return null;
    this.cancelPendingCommit();
    this.commit(data, false);
    return data;
  }

  input(event: TerminalInputEvent) {
    if (this.composing || event.isComposing) {
      this.options.preview(event.data || this.options.read());
      return;
    }
    this.cancelPendingCommit();
    const control = controlInput(event.inputType);
    if (control) {
      this.commit(control, false);
      return;
    }
    this.commit(event.data || this.options.read());
  }

  dispose() {
    this.cancelPendingCommit();
    this.options.preview('');
  }

  private cancelPendingCommit() {
    this.cancelDeferred?.();
    this.cancelDeferred = undefined;
  }

  private commit(fallback: string, readValue = true) {
    const value = readValue ? this.options.read() || fallback : fallback;
    if (value) this.options.send(value);
    this.options.clear();
    this.options.preview('');
  }
}

export function attachTerminalInputBuffer(element: HTMLTextAreaElement, options: Omit<TerminalInputBufferOptions, 'clear' | 'read'>) {
  const clear = () => {
    element.value = '';
    element.setSelectionRange(0, 0);
  };
  const buffer = new TerminalInputBuffer({ ...options, clear, read: () => element.value });
  const beforeInput = (event: InputEvent) => {
    if (!event.cancelable) return;
    const data = buffer.beforeInput(event.inputType, event.isComposing);
    if (data) event.preventDefault();
  };
  const input = (event: InputEvent) => buffer.input({ data: event.data, inputType: event.inputType, isComposing: event.isComposing });
  const keydown = (event: KeyboardEvent) => {
    const data = terminalKeyData(event);
    if (!data) return;
    event.preventDefault();
    if (data === '\r') buffer.beforeInput('insertLineBreak', false);
    else if (data === '\u007f') buffer.beforeInput('deleteContentBackward', false);
    else {
      options.send(data);
      clear();
    }
  };
  const compositionStart = () => buffer.compositionStart();
  const compositionUpdate = (event: CompositionEvent) => buffer.compositionUpdate(event.data);
  const compositionEnd = (event: CompositionEvent) => buffer.compositionEnd(event.data);
  element.addEventListener('beforeinput', beforeInput);
  element.addEventListener('input', input);
  element.addEventListener('keydown', keydown);
  element.addEventListener('compositionstart', compositionStart);
  element.addEventListener('compositionupdate', compositionUpdate);
  element.addEventListener('compositionend', compositionEnd);
  return () => {
    element.removeEventListener('beforeinput', beforeInput);
    element.removeEventListener('input', input);
    element.removeEventListener('keydown', keydown);
    element.removeEventListener('compositionstart', compositionStart);
    element.removeEventListener('compositionupdate', compositionUpdate);
    element.removeEventListener('compositionend', compositionEnd);
    buffer.dispose();
  };
}
