import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, Search, X } from "lucide-react";
import { Collapsible } from "radix-ui";
import { initialTerminalFontSize, connectionView, type ConnectionState, type Kind, type TerminalSession } from "../../shared/model";
import { TerminalFontSizeControl } from "../../shared/ui/TerminalFontSizeControl";
import { mountTerminal } from "./mountTerminal";
import { terminalThemeColors, terminalThemes, type TerminalTheme } from "./themes";
import { isPasteShortcut } from "../../terminal-input-buffer";

export function AgentTerminal({
  session,
  onStatus,
  onProgress,
  terminalPath = "codex",
  terminalTheme,
  terminalFontSize = initialTerminalFontSize(),
  onTerminalFontSizeChange = (size) =>
    window.dispatchEvent(
      new CustomEvent("jian-terminal-font-size", { detail: size }),
    ),
}: {
  session: TerminalSession;
  onStatus: (v: string) => void;
  onProgress: (v: string) => void;
  terminalPath?: Kind | "local";
  terminalTheme: TerminalTheme;
  terminalFontSize?: number;
  onTerminalFontSizeChange?: (size: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    inputBufferRef = useRef<HTMLTextAreaElement>(null),
    previewRef = useRef<HTMLSpanElement>(null),
    wsRef = useRef<WebSocket | null>(null),
    termRef = useRef<Terminal | null>(null),
    fitRequestRef = useRef<(() => void) | null>(null),
    searchToggleRef = useRef<HTMLButtonElement>(null),
    searchInputRef = useRef<HTMLInputElement>(null),
    searchAddonRef = useRef<SearchAddon | null>(null);
  const searchOriginRef = useRef<HTMLElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [searchStatus, setSearchStatus] = useState("");
  const [fontSize, setFontSize] = useState(terminalFontSize);
  const changeFontSize = (size: number) => {
    setFontSize(size);
    onTerminalFontSizeChange(size);
  };
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [connectionProgress, setConnectionProgress] = useState("");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [shiftPressed, setShiftPressed] = useState(false);
  const usesTouchInput = () =>
    window.matchMedia("(pointer: coarse), (hover: none)").matches;
  const focus = () => {
    if (
      document.querySelector(
        '[role="dialog"][aria-modal="true"], [role="dialog"][data-state="open"]',
      )
    )
      return;
    if (usesTouchInput() && inputBufferRef.current)
      inputBufferRef.current.focus({ preventScroll: true });
    else termRef.current?.focus();
  };
  const copySelection = () => {
    const term = termRef.current;
    if (!term?.hasSelection()) return false;
    const selected = term.getSelection();
    const fallback = () => {
      const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const copy = document.createElement("textarea");
      copy.value = selected;
      copy.readOnly = true;
      copy.style.position = "fixed";
      copy.style.opacity = "0";
      document.body.append(copy);
      copy.select();
      try {
        document.execCommand("copy");
      } catch {}
      copy.remove();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
    const pending = navigator.clipboard?.writeText(selected);
    if (pending) void pending.catch(fallback);
    else fallback();
    term.clearSelection();
    return true;
  };
  const send = (data: string) => {
    if (data === "\u0003" && copySelection()) return;
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "input", data }));
    if (!usesTouchInput()) requestAnimationFrame(focus);
  };
  const sendArrow = (direction: string) =>
    send(`\u001b[${shiftPressed ? "1;2" : ""}${direction}`);
  const sendAttachment = async (file: Blob, name?: string) => {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const ws = wsRef.current;
    if (data && ws?.readyState === WebSocket.OPEN) {
      const extension = ({ "application/pdf": "pdf", "application/msword": "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "text/plain": "txt" } as Record<string, string>)[file.type] || file.type.split("/", 2)[1] || "bin";
      ws.send(JSON.stringify({ type: "attachment", name: name || `clipboard.${extension}`, mime: file.type, data }));
    }
  };
  const pasteClipboard = async (event?: ClipboardEvent) => {
    const clipboard = event?.clipboardData;
    const file = clipboard
      ? Array.from(clipboard.items || []).find(item => item.kind === "file")?.getAsFile() || Array.from(clipboard.files || [])[0]
      : undefined;
    if (file) {
      event?.preventDefault();
      await sendAttachment(file, file instanceof File ? file.name : undefined);
      return;
    }
    if (event && usesTouchInput()) return;
    if (!event) {
      try {
        for (const item of await navigator.clipboard?.read() || []) {
          const type = item.types.find(value => !value.startsWith("text/"));
          if (type) {
            await sendAttachment(await item.getType(type));
            return;
          }
        }
      } catch {}
    }
    const text = clipboard?.getData("text/plain") || await navigator.clipboard?.readText();
    if (text) {
      event?.preventDefault();
      send(text);
      return;
    }
    try { document.execCommand("paste"); } catch {}
  };
  useEffect(() => {
    if (!host.current) return;
    return mountTerminal({
      host: host.current,
      inputBuffer: inputBufferRef.current,
      preview: previewRef.current,
      terminalRef: termRef,
      socketRef: wsRef,
      fitRequestRef,
      sessionID: session.id,
      terminalPath,
      theme: terminalTheme,
      fontSize,
      focus,
      send,
      onStatus: value => { setConnection(value === "running" ? "connected" : value === "ended" ? "ended" : "reconnecting"); onStatus(value); },
      onProgress: value => { setConnectionProgress(value); onProgress(value); },
      onSearchAddon: (addon) => {
        searchAddonRef.current = addon;
      },
    });
  }, [session.id, terminalPath]);
  useEffect(() => {
    const change = (event: Event) =>
      setFontSize((event as CustomEvent<number>).detail);
    window.addEventListener("jian-terminal-font-size", change);
    return () => window.removeEventListener("jian-terminal-font-size", change);
  }, []);
  useEffect(() => {
    if (termRef.current)
      termRef.current.options.theme = terminalThemes[terminalTheme];
  }, [terminalTheme]);
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
      fitRequestRef.current?.();
    }
  }, [fontSize]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let lastY: number | null = null,
      distance = 0,
      moved = false,
      holdTimer = 0,
      held = false,
      tapEligible = false;
    const reset = () => {
      window.clearTimeout(holdTimer);
      holdTimer = 0;
      lastY = null;
      distance = 0;
      moved = false;
      held = false;
      tapEligible = false;
    };
    const start = (event: TouchEvent) => {
      reset();
      if (event.touches.length !== 1) {
        return;
      }
      lastY = event.touches[0].clientY;
      tapEligible = !termRef.current?.hasSelection() && window.getSelection()?.isCollapsed !== false;
      holdTimer = window.setTimeout(() => { held = true; holdTimer = 0; }, 700);
    };
    const move = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        reset();
        return;
      }
      if (held) return;
      if (lastY === null) return;
      const currentY = event.touches[0].clientY;
      distance += lastY - currentY;
      lastY = currentY;
      if (!moved && Math.abs(distance) < 4) return;
      moved = true;
      tapEligible = false;
      window.clearTimeout(holdTimer);
      holdTimer = 0;
      if (event.cancelable) event.preventDefault();
      const term = termRef.current;
      if (!term) return;
      const lineHeight = Math.max(
        12,
        (term.options.fontSize ?? 15) * (term.options.lineHeight ?? 1),
      );
      const lines =
        distance > 0
          ? Math.floor(distance / lineHeight)
          : Math.ceil(distance / lineHeight);
      if (lines !== 0) {
        term.scrollLines(lines);
        distance -= lines * lineHeight;
      }
    };
    const end = (event: TouchEvent) => {
      const selected = termRef.current?.hasSelection() || window.getSelection()?.isCollapsed === false;
      if (tapEligible && !moved && !held && !selected && event.touches.length === 0) focus();
      reset();
    };
    element.addEventListener("touchstart", start, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", end, { passive: true });
    element.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      window.clearTimeout(holdTimer);
      element.removeEventListener("touchstart", start);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", end);
      element.removeEventListener("touchcancel", reset);
    };
  }, [session.id]);
  const paste = () => {
    focus();
    try {
      document.execCommand("paste");
    } catch {}
  };
  const captureSearchOrigin = () => {
    if (searchOriginRef.current) return;
    const active = document.activeElement;
    searchOriginRef.current =
      active instanceof HTMLElement && active !== document.body
        ? active
        : searchToggleRef.current;
  };
  const toggleTools = () =>
    requestAnimationFrame(() => fitRequestRef.current?.());
  const find = (value = searchText, backwards = false) => {
    if (!value) {
      searchAddonRef.current?.clearDecorations();
      setSearchStatus("");
      return;
    }
    const found = backwards
      ? searchAddonRef.current?.findPrevious(value)
      : searchAddonRef.current?.findNext(value);
    setSearchStatus(found ? "已找到匹配项" : "没有匹配项");
  };
  const closeSearch = () => {
    searchAddonRef.current?.clearDecorations();
    setSearchOpen(false);
    setSearchText("");
    setSearchStatus("");
  };
  useEffect(() => {
    if (searchOpen) return;
    const origin = searchOriginRef.current;
    searchOriginRef.current = null;
    if (origin?.isConnected && !document.querySelector('[role="dialog"][aria-modal="true"], [role="dialog"][data-state="open"]'))
      origin.focus({ preventScroll: true });
  }, [searchOpen]);
  return (
    <section
      className="terminal-area"
      style={
        {
          "--terminal-bg": terminalThemeColors[terminalTheme].background,
          "--terminal-fg": terminalThemeColors[terminalTheme].foreground,
        } as CSSProperties
      }
    >
      <div className="terminal-connection-feedback" role="status" data-state={connection}>
        <span className={"status " + connectionView(connection).tone}>{connectionView(connection).label}</span>
        {connection !== "connected" && <span>{connectionProgress}</span>}
      </div>
      <div
        className="terminal-stage"
        onKeyDownCapture={event => {
          if (!isPasteShortcut(event.nativeEvent)) return;
          event.preventDefault();
          void pasteClipboard();
        }}
        onPaste={event => void pasteClipboard(event.nativeEvent)}
      >
        <button
          className="terminal-search-toggle"
          ref={searchToggleRef}
          type="button"
          aria-label="搜索终端输出"
          title="搜索终端输出"
          onPointerDown={captureSearchOrigin}
          onClick={() => {
            captureSearchOrigin();
            setSearchOpen(true);
            requestAnimationFrame(() => searchInputRef.current?.focus());
          }}
        >
          <Search />
        </button>
        {searchOpen && (
          <form
            className="terminal-search-bar"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              find();
            }}
          >
            <input
              ref={searchInputRef}
              type="search"
              aria-label="搜索终端输出"
              placeholder="查找输出…"
              value={searchText}
              onChange={(event) => {
                setSearchText(event.target.value);
                find(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeSearch();
                if (event.key === "Enter" && event.shiftKey) {
                  event.preventDefault();
                  find(searchText, true);
                }
              }}
            />
            <span aria-live="polite">{searchStatus}</span>
            <button type="button" aria-label="上一个匹配项" title="上一个匹配项" onClick={() => find(searchText, true)}>↑</button>
            <button type="button" aria-label="下一个匹配项" title="下一个匹配项" onClick={() => find()}>↓</button>
            <button type="button" aria-label="关闭搜索" title="关闭搜索" onClick={closeSearch}><X /></button>
          </form>
        )}
        <div className="terminal" ref={host} />
        <textarea
          ref={inputBufferRef}
          className="terminal-input-buffer"
          aria-label="终端输入"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          enterKeyHint="enter"
          inputMode="text"
          spellCheck={false}
          tabIndex={-1}
        />
        <span
          ref={previewRef}
          className="terminal-input-preview"
          aria-hidden="true"
        />
      </div>
      <Collapsible.Root
        className={"terminal-tools " + (toolsOpen ? "open" : "")}
        open={toolsOpen}
        onOpenChange={setToolsOpen}
        onAnimationEnd={toggleTools}
        onPointerDownCapture={event => {
          // Keep the current input focus without opening or dismissing the keyboard.
          if (usesTouchInput() && (event.target as HTMLElement).closest("button"))
            event.preventDefault();
        }}
      >
        <Collapsible.Trigger asChild>
          <button className="terminal-tools-toggle">
            {toolsOpen ? "收起更多按键" : "更多按键"}
            <ChevronDown />
          </button>
        </Collapsible.Trigger>
        <Collapsible.Content
          forceMount
          className="terminal-controls"
          role="toolbar"
          aria-label="终端控制键"
        >
          <TerminalFontSizeControl
            compact
            size={fontSize}
            onChange={changeFontSize}
          />
          <div className="terminal-navigation">
            <button onClick={() => send("\u001b")}>
              ESC
            </button>
            <button
              aria-label="方向键上"
              onClick={() => sendArrow("A")}
            >
              <ArrowUp />
            </button>
            <button
              aria-label="Shift"
              aria-pressed={shiftPressed}
              onClick={() => setShiftPressed(value => !value)}
            >
              SHIFT
            </button>
            <button
              aria-label="方向键左"
              onClick={() => sendArrow("D")}
            >
              <ArrowLeft />
            </button>
            <button
              aria-label="方向键下"
              onClick={() => sendArrow("B")}
            >
              <ArrowDown />
            </button>
            <button
              aria-label="方向键右"
              onClick={() => sendArrow("C")}
            >
              <ArrowRight />
            </button>
          </div>
          <div className="terminal-functions">
            <button onClick={() => send(shiftPressed ? "\u001b[Z" : "\t")}>
              TAB
            </button>
            <button onClick={() => send("\u001b[Z")}>
              SHIFT+TAB
            </button>
            <button onClick={() => send("/")}>
              /
            </button>
            <button aria-label="Shift+左方向键" onClick={() => send("\u001b[1;2D")}>
              SHIFT+←
            </button>
            <button onClick={() => void pasteClipboard()}>
              CTRL+V
            </button>
            <button onClick={() => send("\r")}>
              Enter
            </button>
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </section>
  );
}
