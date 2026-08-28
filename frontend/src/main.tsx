import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { type Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  Folder,
  FolderOpen,
  Home,
  Menu,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { Collapsible, Tabs } from "radix-ui";
import { QuickNote } from "./features/quick-note/QuickNote";
import {
  beginSessionLoad,
  invalidateSessionLoads,
  isCurrentSessionLoad,
  normalizeSessions,
  savedSession,
  shouldRestoreNativeSession,
  type SessionLoadVersion,
} from "./session-load-guard";
import { api, errorMessage } from "./shared/api";
import {
  activeKindKey,
  activeAreaKey,
  activeProfileKey,
  activeLocalSessionKey,
  themeKey,
  interfaceThemeKey,
  terminalThemeKey,
  terminalFontSizeKey,
  activeSessionKey,
  selectedSessionKey,
  sessionCacheKey,
  navScrollKey,
  initialKind,
  initialTheme,
  initialTerminalFontSize,
  displayTitle,
  displayChannel,
  displayWorkspace,
  activeView,
  statusView,
  isMobile,
  type Kind,
  type LocalSession,
  type TerminalSession,
  type Theme,
  type Session,
  type BrowseResult,
  type AgentSettings,
  type SettingsResponse,
} from "./shared/model";
import {
  initialTerminalTheme,
  terminalThemeColors,
  terminalThemes,
  type TerminalTheme,
} from "./features/terminal/themes";
import { recentWorkspaces } from "./shared/persistence";
import { MenuPopup } from "./shared/ui/Popup";
import { ConfirmDialog } from "./shared/ui/ConfirmDialog";
import { ErrorDialog } from "./shared/ui/ErrorDialog";
import { mountTerminal } from "./features/terminal/mountTerminal";
import { SessionDialog } from "./features/session-catalog/SessionDialog";
import { Login } from "./features/auth/Login";
import { useDialogFocus } from "./shared/ui/useDialogFocus";
import { SidebarNavigation } from "./features/navigation/SidebarNavigation";
import { SettingsPage } from "./features/settings/SettingsPage";
import { ProfileFilePicker } from "./shared/ui/ProfileFilePicker";
import { AgentIcon } from "./shared/ui/AgentIcon";
import { EnvironmentVariables } from "./shared/ui/EnvironmentVariables";
import { ThemeControls } from "./shared/ui/ThemeControls";
import { TerminalFontSizeControl } from "./shared/ui/TerminalFontSizeControl";
import { isPasteShortcut } from "./terminal-input-buffer";

import "./styles.css";
import "./layout.css";

function StatusMenu({
  status,
  connected,
  onReconnect,
  onRelease,
  onRestart,
}: {
  status: ReturnType<typeof statusView>;
  connected: boolean;
  onReconnect: () => void;
  onRelease: () => Promise<void>;
  onRestart?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<"restart" | "release" | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmAction = async () => {
    setBusy(true);
    try {
      if (confirm === "release") await onRelease();
      else if (onRestart) await onRestart();
      else window.dispatchEvent(new Event("jian-restart-terminal"));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="terminal-status-menu">
      <MenuPopup
        open={open}
        onOpenChange={setOpen}
        contentClassName="status-menu"
        ariaLabel="终端状态操作"
        trigger={
          <button className={"status " + status.tone}>
            <i />
            {status.label}
            <ChevronDown />
          </button>
        }
        content={
          <>
            <button
              onClick={() => {
                setOpen(false);
                onReconnect();
              }}
            >
              <RefreshCw />
              刷新终端
            </button>
            <button
              disabled={!connected}
              onClick={() => {
                setOpen(false);
                setConfirm("restart");
              }}
            >
              <RefreshCw />
              重启会话
            </button>
            <button
              onClick={() => {
                setOpen(false);
                setConfirm("release");
              }}
            >
              <Trash2 />
              释放会话
            </button>
          </>
        }
      />
      <ConfirmDialog
        open={!!confirm}
        title={confirm === "release" ? "释放当前会话？" : "重启当前会话？"}
        description={
          confirm === "release"
            ? "当前 terminal 协程和 PTY 子进程都会被完全释放，打开的会话标签也会关闭。"
            : "将重新加载当前 agent 的环境变量、Local profile 和启动参数，然后强制重启当前 PTY。正在执行的任务会中断。"
        }
        confirmLabel={confirm === "release" ? "确认释放" : "确认重启"}
        danger
        busy={busy}
        onConfirm={() => void confirmAction()}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}

function AgentSettingsDialog({
  kind,
  close,
  saved,
}: {
  kind: Kind | "local";
  close: () => void;
  saved: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const launchArgumentRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const [profilePath, setProfilePath] = useState("");
  const [profilePicking, setProfilePicking] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useDialogFocus(close, ref);
  useEffect(() => {
    void api<SettingsResponse>("/settings")
      .then((value) => {
        setSettings({
          ...value.settings,
          local_profiles: value.settings.local_profiles?.length
            ? value.settings.local_profiles
            : ["~/.bashrc"],
          codex_args: value.settings.codex_args || [],
          hermes_args: value.settings.hermes_args || [],
          pi_args: value.settings.pi_args || [],
          codex_env: value.settings.codex_env || [],
          hermes_env: value.settings.hermes_env || [],
          pi_env: value.settings.pi_env || [],
        });
        setAvailable(
          kind === "hermes"
            ? value.available_profiles
            : value.available_pi_agents,
        );
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError("");
    try {
      await api<AgentSettings>("/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      saved();
      close();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const toggleProfile = (profile: string) =>
    setSettings((value) =>
      value
        ? {
            ...value,
            hermes_profiles: value.hermes_profiles.includes(profile)
              ? value.hermes_profiles.filter((item) => item !== profile)
              : [...value.hermes_profiles, profile],
          }
        : value,
    );
  const addLocalProfile = (candidate = profilePath) => {
    const path = candidate.trim();
    if (!path) return;
    setSettings((value) =>
      value && !value.local_profiles.includes(path)
        ? { ...value, local_profiles: [...value.local_profiles, path] }
        : value,
    );
    setProfilePath("");
  };
  const removeLocalProfile = (path: string) =>
    setSettings((value) =>
      value
        ? {
            ...value,
            local_profiles: value.local_profiles.filter(
              (item) => item !== path,
            ),
          }
        : value,
    );
  const launchArgs =
    settings?.[`${kind}_args` as "codex_args" | "hermes_args" | "pi_args"] ||
    [];
  const updateLaunchArg = (index: number, argument: string) =>
    setSettings((value) => {
      if (!value) return value;
      const key = `${kind}_args` as "codex_args" | "hermes_args" | "pi_args";
      const args = [...value[key]];
      args[index] = argument;
      return { ...value, [key]: args };
    });
  const addLaunchArg = () => {
    const index = launchArgs.length;
    setSettings((value) => {
      if (!value) return value;
      const key = `${kind}_args` as "codex_args" | "hermes_args" | "pi_args";
      return { ...value, [key]: [...value[key], ""] };
    });
    requestAnimationFrame(() => launchArgumentRefs.current[index]?.focus());
  };
  const removeLaunchArg = (index: number) =>
    setSettings((value) => {
      if (!value) return value;
      const key = `${kind}_args` as "codex_args" | "hermes_args" | "pi_args";
      return {
        ...value,
        [key]: value[key].filter((_, item) => item !== index),
      };
    });
  const environmentVariables =
    kind === "local" || !settings ? null : (
      <EnvironmentVariables
        values={
          settings[`${kind}_env` as "codex_env" | "hermes_env" | "pi_env"]
        }
        onChange={(values) =>
          setSettings((value) =>
            value ? { ...value, [`${kind}_env`]: values } : value,
          )
        }
      />
    );
  const launchArguments = (
    <fieldset className="profile-settings launch-arguments">
      <legend>启动参数</legend>
      <small>每项为一个独立参数，保存后应用于新建和重启的会话。</small>
      <div className="launch-argument-list">
        {launchArgs.map((argument, index) => (
          <div key={index}>
            <input
              ref={(element) => {
                launchArgumentRefs.current[index] = element;
              }}
              value={argument}
              onChange={(event) => updateLaunchArg(index, event.target.value)}
              placeholder="例如 --model 或 gpt-5"
              aria-label={`启动参数 ${index + 1}`}
            />
            <button
              type="button"
              className="icon"
              aria-label={`移除启动参数 ${index + 1}`}
              title="移除参数"
              onClick={() => removeLaunchArg(index)}
            >
              <Trash2 />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="icon launch-argument-add"
        onClick={addLaunchArg}
        aria-label="添加启动参数"
        title="添加启动参数"
      >
        +
      </button>
    </fieldset>
  );
  const title =
    kind === "local"
      ? "Local Bash"
      : kind === "codex"
        ? "Codex"
        : kind === "hermes"
          ? "Hermes"
          : "Pi";
  return (
    <div className="dialog-overlay" role="presentation">
      <section
        className="dialog agent-settings"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={`${title} 设置`}
      >
        <header>
          <span className="eyebrow">{kind.toUpperCase()} SESSIONS</span>
          <h2>{kind === "local" ? "Bash 启动文件" : `${title} 会话设置`}</h2>
          <p>
            {kind === "local"
              ? "新建的 Bash 终端会按此顺序加载文件。"
              : "恢复会话优先使用以下设置"}
          </p>
        </header>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!settings ? (
          <p className="muted">正在读取设置…</p>
        ) : (
          <div className="setting-fields">
            {kind === "local" ? (
              <fieldset className="profile-settings local-profile-settings">
                <legend>自动加载的 profile 文件</legend>
                <small>第一个文件固定为 ~/.bashrc，不能删除。</small>
                <div className="local-profile-list">
                  {settings.local_profiles.map((path, index) => (
                    <div key={path}>
                      <span title={path}>{path}</span>
                      {index === 0 ? (
                        <small>固定</small>
                      ) : (
                        <button
                          className="icon"
                          aria-label={`移除 ${path}`}
                          title="移除文件"
                          onClick={() => removeLocalProfile(path)}
                        >
                          <Trash2 />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </fieldset>
            ) : (
              <>
                {environmentVariables}
                {launchArguments}
              </>
            )}
          </div>
        )}
        <footer>
          <button className="secondary" onClick={close}>
            取消
          </button>
          <button onClick={() => void save()} disabled={!settings || saving}>
            {saving ? "正在保存…" : "保存设置"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function WorkspacePicker({
  sessions,
  close,
  select,
  profile,
  kind,
}: {
  sessions: Session[];
  close: () => void;
  select: (path: string, launchArgs: string[]) => Promise<void>;
  profile?: string;
  kind: Kind;
}) {
  const [current, setCurrent] = useState(""),
    [parent, setParent] = useState(""),
    [entries, setEntries] = useState<BrowseResult["entries"]>([]),
    [manual, setManual] = useState("~"),
    [launchArgs, setLaunchArgs] = useState<string[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const launchArgumentRefs = useRef<(HTMLInputElement | null)[]>([]);
  const browseVersion = useRef<SessionLoadVersion>({ current: 0 });
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(close, dialogRef);
  const recent = recentWorkspaces(sessions);
  const browse = async (path: string) => {
    const version = beginSessionLoad(browseVersion.current);
    setLoading(true);
    setError("");
    try {
      const r = await api<BrowseResult>(
        `/workspaces/browse?path=${encodeURIComponent(path)}`,
      );
      if (!isCurrentSessionLoad(browseVersion.current, version)) return;
      setCurrent(r.path);
      setParent(r.parent);
      setManual(r.path);
      setEntries(r.entries.filter((x) => x.directory));
    } catch (e) {
      if (isCurrentSessionLoad(browseVersion.current, version))
        setError(errorMessage(e));
    } finally {
      if (isCurrentSessionLoad(browseVersion.current, version))
        setLoading(false);
    }
  };
  useEffect(() => {
    void browse("~");
    void api<SettingsResponse>("/settings")
      .then((value) =>
        setLaunchArgs(
          value.settings[
            `${kind}_args` as "codex_args" | "hermes_args" | "pi_args"
          ] || [],
        ),
      )
      .catch(() => {});
  }, [kind]);
  const enter = (name: string) =>
    void browse(current === "/" ? `/${name}` : `${current}/${name}`);
  const updateLaunchArg = (index: number, argument: string) =>
    setLaunchArgs((value) =>
      value.map((item, itemIndex) => (itemIndex === index ? argument : item)),
    );
  const addLaunchArg = () => {
    const index = launchArgs.length;
    setLaunchArgs((value) => [...value, ""]);
    requestAnimationFrame(() => launchArgumentRefs.current[index]?.focus());
  };
  const removeLaunchArg = (index: number) =>
    setLaunchArgs((value) =>
      value.filter((_, itemIndex) => itemIndex !== index),
    );
  return (
    <div
      className="workspace-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section
        ref={dialogRef}
        className="workspace-picker"
        role="dialog"
        aria-modal="true"
        aria-label="选择工作目录"
      >
        <header>
          <div>
            <span className="eyebrow">
              {kind === "hermes" ? `Hermes · ${profile || "default"}` : "Codex"}
            </span>
            <h3>选择工作目录</h3>
            <span>新会话将在此目录启动</span>
          </div>
          <button className="icon" aria-label="关闭目录选择器" onClick={close}>
            <X />
          </button>
        </header>
        {recent.length > 0 && (
          <div className="recent-workspaces">
            <strong>最近使用</strong>
            <div>
              {recent.map((p) => (
                <button key={p} onClick={() => void browse(p)} title={p}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
        <form
          className="workspace-path"
          onSubmit={(e) => {
            e.preventDefault();
            void browse(manual);
          }}
        >
          <button
            type="button"
            aria-label="用户主目录"
            title="用户主目录"
            onClick={() => void browse("~")}
          >
            <Home />
          </button>
          <button
            type="button"
            aria-label="上级目录"
            title="上级目录"
            disabled={!parent || parent === current}
            onClick={() => void browse(parent)}
          >
            <ChevronLeft />
          </button>
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            aria-label="文件目录路径"
          />
          <button type="submit">前往</button>
        </form>
        <div className="directory-list">
          {loading ? (
            <p className="muted">正在读取目录…</p>
          ) : entries.length ? (
            entries.map((x) => (
              <button key={x.name} onClick={() => enter(x.name)}>
                <FolderOpen />
                <span>{x.name}</span>
                <ChevronDown />
              </button>
            ))
          ) : (
            <div className="picker-empty">
              <Folder />
              <p>当前目录没有子目录</p>
            </div>
          )}
        </div>
        <fieldset className="workspace-launch-args">
          <legend>启动参数</legend>
          <div className="launch-argument-list">
            {launchArgs.map((argument, index) => (
              <div key={index}>
                <input
                  ref={(element) => {
                    launchArgumentRefs.current[index] = element;
                  }}
                  value={argument}
                  onChange={(event) =>
                    updateLaunchArg(index, event.target.value)
                  }
                  placeholder="例如 --model 或 gpt-5"
                  aria-label={`启动参数 ${index + 1}`}
                />
                <button
                  type="button"
                  className="icon"
                  aria-label={`移除启动参数 ${index + 1}`}
                  title="移除参数"
                  onClick={() => removeLaunchArg(index)}
                >
                  <Trash2 />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="icon launch-argument-add"
            onClick={addLaunchArg}
            aria-label="添加启动参数"
            title="添加启动参数"
          >
            +
          </button>
        </fieldset>
        {error && <p className="error workspace-error">{error}</p>}
        <footer>
          <span title={current}>{current || "~"}</span>
          <button
            type="button"
            disabled={loading || !current}
            onClick={async () => {
              setLoading(true);
              await select(
                current,
                launchArgs.filter((argument) => argument.trim()),
              );
            }}
          >
            在此启动会话
          </button>
        </footer>
      </section>
    </div>
  );
}

function AgentTerminal({
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
    termRef = useRef<Terminal | null>(null);
  const [fontSize, setFontSize] = useState(terminalFontSize);
  const changeFontSize = (size: number) => {
    setFontSize(size);
    onTerminalFontSizeChange(size);
  };
  const [toolsOpen, setToolsOpen] = useState(false);
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
      const copy = document.createElement("textarea");
      copy.value = selected;
      copy.style.position = "fixed";
      copy.style.opacity = "0";
      document.body.append(copy);
      copy.select();
      try {
        document.execCommand("copy");
      } catch {}
      copy.remove();
    };
    const pending = navigator.clipboard?.writeText(selected);
    if (pending) void pending.catch(fallback);
    else fallback();
    term.clearSelection();
    focus();
    return true;
  };
  const send = (data: string) => {
    if (data === "\u0003" && copySelection()) return;
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "input", data }));
    requestAnimationFrame(focus);
  };
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
      sessionID: session.id,
      terminalPath,
      theme: terminalTheme,
      fontSize,
      focus,
      send,
      onStatus,
      onProgress,
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
      window.dispatchEvent(new Event("resize"));
    }
  }, [fontSize]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let lastY: number | null = null,
      distance = 0,
      moved = false;
    const reset = () => {
      lastY = null;
      distance = 0;
      moved = false;
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        reset();
        return;
      }
      lastY = event.touches[0].clientY;
      distance = 0;
      moved = false;
    };
    const move = (event: TouchEvent) => {
      if (lastY === null || event.touches.length !== 1) return;
      const currentY = event.touches[0].clientY;
      distance += lastY - currentY;
      lastY = currentY;
      if (!moved && Math.abs(distance) < 4) return;
      moved = true;
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
    const end = () => {
      if (!moved) focus();
      reset();
    };
    element.addEventListener("touchstart", start, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", end, { passive: true });
    element.addEventListener("touchcancel", reset, { passive: true });
    return () => {
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
  const toggleTools = () =>
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
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
      <div
        className="terminal-stage"
        onKeyDownCapture={event => {
          if (!isPasteShortcut(event.nativeEvent)) return;
          event.preventDefault();
          void pasteClipboard();
        }}
        onPaste={event => void pasteClipboard(event.nativeEvent)}
      >
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
      >
        <Collapsible.Trigger asChild>
          <button className="terminal-tools-toggle">
            {toolsOpen ? "收起终端按键" : "终端按键"}
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
            <button onPointerDown={focus} onClick={() => send("\u001b")}>
              ESC
            </button>
            <button
              aria-label="方向键上"
              onPointerDown={focus}
              onClick={() => send("\u001b[A")}
            >
              <ArrowUp />
            </button>
            <button
              aria-label="退格"
              onPointerDown={focus}
              onClick={() => send("\u007f")}
            >
              DEL
            </button>
            <button
              aria-label="方向键左"
              onPointerDown={focus}
              onClick={() => send("\u001b[D")}
            >
              <ArrowLeft />
            </button>
            <button
              aria-label="方向键下"
              onPointerDown={focus}
              onClick={() => send("\u001b[B")}
            >
              <ArrowDown />
            </button>
            <button
              aria-label="方向键右"
              onPointerDown={focus}
              onClick={() => send("\u001b[C")}
            >
              <ArrowRight />
            </button>
          </div>
          <div className="terminal-functions">
            <button onPointerDown={focus} onClick={() => send("\t")}>
              TAB
            </button>
            <button onPointerDown={focus} onClick={() => send("\u001b[Z")}>
              SHIFT+TAB
            </button>
            <button onPointerDown={focus} onClick={() => send("/")}>
              /
            </button>
            <button onPointerDown={focus} onClick={() => send("\u0003")}>
              CTRL+C
            </button>
            <button onPointerDown={focus} onClick={() => void pasteClipboard()}>
              CTRL+V
            </button>
            <button onPointerDown={focus} onClick={() => send("\r")}>
              Enter
            </button>
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </section>
  );
}

type OpenSession = Session | LocalSession;

const openSessionKey = (session: OpenSession) =>
  `${session.kind}:${session.kind === "hermes" || session.kind === "pi" ? `${session.profile || "default"}:` : ""}${session.id}`;
const openSessionTitle = (session: OpenSession) =>
  session.kind === "local" ? "Bash" : displayTitle(session);
const openSessionLabel = (session: OpenSession) =>
  session.kind === "local"
    ? "Local"
    : session.kind === "hermes"
      ? "Hermes"
      : "Codex";
const readSessionCache = (username: string, kind: Kind): Session[] => {
  try {
    const value = JSON.parse(
      localStorage.getItem(sessionCacheKey(username, kind)) || "[]",
    );
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const writeSessionCache = (
  username: string,
  kind: Kind,
  sessions: Session[],
) => {
  try {
    localStorage.setItem(
      sessionCacheKey(username, kind),
      JSON.stringify(sessions),
    );
  } catch {}
};

function SessionTabs({
  sessions,
  activeKey,
  settingsOpen,
  select,
  openSettings,
  closeSettings,
  close,
  reorder,
}: {
  sessions: OpenSession[];
  activeKey: string | null;
  settingsOpen: boolean;
  select: (key: string) => void;
  openSettings: () => void;
  closeSettings: () => void;
  close: (key: string) => void;
  reorder: (from: string, to: string) => void;
}) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const sessionKeys = sessions.map(openSessionKey);
  const [order, setOrder] = useState(() => [...sessionKeys, "settings"]);
  const [settingsVisible, setSettingsVisible] = useState(true);
  useEffect(() => {
    if (settingsOpen) setSettingsVisible(true);
  }, [settingsOpen]);
  useEffect(() => {
    setOrder((current) => {
      const next = [
        ...current.filter((key) => (key === "settings" ? settingsVisible : sessionKeys.includes(key))),
        ...sessionKeys.filter((key) => !current.includes(key)),
      ];
      if (settingsVisible && !next.includes("settings")) next.push("settings");
      return next.join("\0") === current.join("\0") ? current : next;
    });
  }, [sessions, settingsVisible]);
  const removeSettings = () => {
    setSettingsVisible(false);
    setOrder((current) => current.filter((key) => key !== "settings"));
    closeSettings();
  };
  const move = (from: string, to: string) => {
    setOrder((current) => {
      const fromIndex = current.indexOf(from);
      const toIndex = current.indexOf(to);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return current;
      const next = [...current];
      const [tab] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, tab);
      return next;
    });
    if (from !== "settings" && to !== "settings") reorder(from, to);
  };
  return (
    <Tabs.Root
      className="session-tabs"
      value={settingsOpen ? "settings" : activeKey || "terminal"}
      onValueChange={(value) =>
        value === "settings" ? openSettings() : select(value)
      }
      orientation="horizontal"
    >
      <Tabs.List className="session-tabs-list" aria-label="已打开的会话">
        {order.map((key) => {
          if (key === "settings")
            return (
              <Tabs.Trigger
                key="settings"
                className={
                  "session-tab session-settings-tab " +
                  (dragKey === "settings" ? "dragging " : "") +
                  (dropKey === "settings" ? "drop-target" : "")
                }
                value="settings"
                draggable
                onDragStart={(event) => {
                  setDragKey("settings");
                  event.dataTransfer.setData("text/plain", "settings");
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (dragKey !== "settings") setDropKey("settings");
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const from =
                    event.dataTransfer.getData("text/plain") || dragKey;
                  if (from && from !== "settings") move(from, "settings");
                  setDragKey(null);
                  setDropKey(null);
                }}
                onDragEnd={() => {
                  setDragKey(null);
                  setDropKey(null);
                }}
              >
                <span className="session-tab-kind">Jian</span>
                <span className="session-tab-title">设置</span>
                <span
                  className="session-tab-close"
                  role="button"
                  tabIndex={-1}
                  aria-label="关闭设置"
                  title="关闭标签页"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    removeSettings();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      removeSettings();
                    }
                  }}
                >
                  <X />
                </span>
              </Tabs.Trigger>
            );
          const session = sessions.find((item) => openSessionKey(item) === key);
          if (!session) return null;
          return (
            <Tabs.Trigger
              className={
                "session-tab " +
                (dragKey === key ? "dragging " : "") +
                (dropKey === key ? "drop-target" : "")
              }
              value={key}
              key={key}
              title={session.workspace}
              draggable
              onDragStart={(event) => {
                setDragKey(key);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", key);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                if (dragKey !== key) setDropKey(key);
              }}
              onDragLeave={() =>
                setDropKey((value) => (value === key ? null : value))
              }
              onDrop={(event) => {
                event.preventDefault();
                const from =
                  event.dataTransfer.getData("text/plain") || dragKey;
                if (from && from !== key) move(from, key);
                setDragKey(null);
                setDropKey(null);
              }}
              onDragEnd={() => {
                setDragKey(null);
                setDropKey(null);
              }}
            >
              <span className="session-tab-kind">
                {openSessionLabel(session)}
              </span>
              <span className="session-tab-title">
                {openSessionTitle(session)}
              </span>
              <span
                className="session-tab-close"
                role="button"
                tabIndex={-1}
                aria-label={`关闭 ${openSessionTitle(session)}`}
                title="关闭标签页"
                onClick={(event) => {
                  event.stopPropagation();
                  close(key);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    close(key);
                  }
                }}
              >
                <X />
              </span>
            </Tabs.Trigger>
          );
        })}
      </Tabs.List>
    </Tabs.Root>
  );
}

function App() {
  const startKind = initialKind();
  const initialArea =
    localStorage.getItem(activeAreaKey) === "local" ? "local" : startKind;
  const [localSessions, setLocalSessions] = useState<LocalSession[]>([]),
    [settingsOpen, setSettingsOpen] = useState(
      () => sessionStorage.getItem("jian.settings-open") === "1",
    ),
    [agentEnabled, setAgentEnabled] = useState<Partial<Record<Kind, boolean>>>({
      codex: true,
      hermes: true,
      pi: true,
    });
  const [user, setUser] = useState<string | null>(null),
    [ready, setReady] = useState(false),
    [area, setArea] = useState<Kind | "local">(initialArea),
    [kind, setKind] = useState<Kind>(startKind),
    [theme, setTheme] = useState<Theme>(initialTheme),
    [all, setAll] = useState<Session[]>([]),
    [active, setActive] = useState<OpenSession | null>(null),
    [openSessions, setOpenSessions] = useState<OpenSession[]>([]),
    [activeKey, setActiveKey] = useState<string | null>(null),
    [profiles, setProfiles] = useState<string[]>([]),
    [profile, setProfile] = useState(
      () => localStorage.getItem(activeProfileKey) || "default",
    ),
    [error, setError] = useState(""),
    [progress, setProgress] = useState(""),
    [refreshingKind, setRefreshingKind] = useState<Kind | null>(null),
    [terminalRevision, setTerminalRevision] = useState(0),
    [terminalAttached, setTerminalAttached] = useState(true),
    [connectedSessionID, setConnectedSessionID] = useState<string | null>(null),
    [mobileNavigationOpen, setMobileNavigationOpen] = useState(false),
    [picking, setPicking] = useState(false),
    [dialog, setDialog] = useState<{
      mode: "rename" | "delete";
      session: Session;
    } | null>(null),
    [settingsKind, setSettingsKind] = useState<Kind | "local" | null>(null),
    [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const token = useRef<SessionLoadVersion>({ current: 0 }),
    sidebarRef = useRef<HTMLElement>(null),
    sessionCache = useRef<Partial<Record<Kind, Session[]>>>({}),
    hermesHomeSelected = useRef(false);
  const [terminalTheme, setTerminalTheme] =
      useState<TerminalTheme>(initialTerminalTheme),
    [terminalFontSize, setTerminalFontSize] = useState(initialTerminalFontSize);
  const changeFontSize = (size: number) =>
    window.dispatchEvent(
      new CustomEvent("jian-terminal-font-size", { detail: size }),
    );
  const me = async () => {
    const status = await api<{ authenticated: boolean; username?: string }>(
      "/auth/status",
    );
    setUser(status.authenticated ? status.username || null : null);
  };
  const load = async (target = kind) => {
    const currentTarget = target === kind;
    const t = currentTarget
      ? beginSessionLoad(token.current)
      : token.current.current;
    const cached = user
      ? readSessionCache(user, target)
      : sessionCache.current[target] || [];
    sessionCache.current[target] = cached;
    if (cached.length && currentTarget) setAll(cached);
    try {
      const rows = normalizeSessions(
        await api<Session[]>(`/agents/${target}/sessions/refresh`, {
          method: "POST",
        }),
      );
      if (currentTarget && !isCurrentSessionLoad(token.current, t)) return true;
      sessionCache.current[target] = rows;
      if (user) writeSessionCache(user, target, rows);
      if (currentTarget) {
        setAll(rows);
        setOpenSessions((sessions) =>
          sessions.map(
            (session) =>
              rows.find(
                (row) => row.id === session.id && row.kind === session.kind,
              ) || session,
          ),
        );
        setActive((session) =>
          session?.kind === target
            ? rows.find(
                (row) => row.id === session.id && row.kind === session.kind,
              ) || session
            : session,
        );
        setError("");
      }
      if (
        currentTarget &&
        shouldRestoreNativeSession({
          hasOpenSessions: !!openSessions.length,
          hasActiveSession: !!active,
          isLocalArea: localStorage.getItem(activeAreaKey) === "local",
          explicitHome: target === "hermes" && hermesHomeSelected.current,
        })
      ) {
        const restored = savedSession(
          rows,
          localStorage.getItem(activeSessionKey(target, profile)),
          target,
          profile,
        );
        if (restored) {
          setOpenSessions([restored]);
          setActiveKey(openSessionKey(restored));
          setActive(restored);
        }
      }
      return true;
    } catch (e) {
      if (currentTarget && isCurrentSessionLoad(token.current, t))
        setError(errorMessage(e));
      return false;
    }
  };
  const clearActive = () => {
    setActive(null);
    setActiveKey(null);
    setConnectedSessionID(null);
    setProgress("");
  };
  const activate = (session: OpenSession) => {
    setSettingsOpen(false);
    const key = openSessionKey(session);
    setOpenSessions((current) =>
      current.some((item) => openSessionKey(item) === key)
        ? current
        : [...current, session],
    );
    setActiveKey(key);
    setActive(session);
    setTerminalAttached(true);
    setConnectedSessionID(null);
    setProgress("正在加载会话…");
    setArea(session.kind);
    localStorage.setItem(selectedSessionKey(session, profile), session.id);
    if (session.kind === "local") localStorage.setItem(activeAreaKey, "local");
    else {
      const nextProfile = session.profile || profile;
      localStorage.setItem(activeAreaKey, session.kind);
      localStorage.setItem(activeKindKey, session.kind);
      setKind(session.kind);
      if (session.kind === "hermes") {
        hermesHomeSelected.current = false;
        localStorage.setItem(activeProfileKey, nextProfile);
        setProfile(nextProfile);
      }
    }
    if (isMobile()) setMobileNavigationOpen(false);
  };
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(themeKey, theme);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        theme === "light"
          ? "#f5f7f4"
          : theme === "black"
            ? "#050505"
            : "#09100f",
      );
  }, [theme]);
  useEffect(() => {
    if ("serviceWorker" in navigator)
      navigator.serviceWorker
        .register("/sw.js", { updateViaCache: "none" })
        .then((registration) => registration.update())
        .catch(() => {});
    void me()
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (user) {
      void load(kind);
      void load(kind === "codex" ? "hermes" : "codex");
    }
  }, [user, area, kind, profile]);
  useEffect(() => {
    if (user && kind === "hermes")
      void api<string[]>("/hermes/profiles")
        .then((v) => {
          setProfiles(v);
          if (v.length && !v.includes(profile)) {
            localStorage.setItem(activeProfileKey, v[0]);
            setProfile(v[0]);
          }
        })
        .catch(() => setProfiles([]));
  }, [user, kind]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (sidebarRef.current)
        sidebarRef.current.scrollTop =
          Number(localStorage.getItem(navScrollKey(kind, profile))) || 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [kind, profile, all.length]);
  useEffect(() => {
    localStorage.setItem(interfaceThemeKey, theme);
  }, [theme]);
  useEffect(() => {
    if (user && kind === "pi")
      void api<string[]>("/pi/agents")
        .then(setProfiles)
        .catch(() => setProfiles([]));
  }, [user, kind]);
  useEffect(() => {
    localStorage.setItem(terminalThemeKey, terminalTheme);
  }, [terminalTheme]);
  useEffect(() => {
    localStorage.setItem(terminalFontSizeKey, String(terminalFontSize));
  }, [terminalFontSize]);
  useEffect(() => {
    const change = (event: Event) =>
      setTerminalFontSize((event as CustomEvent<number>).detail);
    window.addEventListener("jian-terminal-font-size", change);
    return () => window.removeEventListener("jian-terminal-font-size", change);
  }, []);
  useEffect(() => {
    if (user)
      void api<SettingsResponse>("/settings")
        .then((value) =>
          setAgentEnabled({
            codex: value.settings.codex_enabled !== false,
            hermes: value.settings.hermes_enabled !== false,
            pi: value.settings.pi_enabled !== false,
          }),
        )
        .catch(() => {});
  }, [user]);
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("jian-agent-settings", { detail: agentEnabled }),
    );
  }, [agentEnabled.codex, agentEnabled.hermes, agentEnabled.pi]);
  useEffect(() => {
    if (settingsOpen) sessionStorage.setItem("jian.settings-open", "1");
    else sessionStorage.removeItem("jian.settings-open");
  }, [settingsOpen]);
  useEffect(() => {
    localStorage.setItem("jian.codex-enabled", String(agentEnabled.codex));
    localStorage.setItem("jian.hermes-enabled", String(agentEnabled.hermes));
    localStorage.setItem("jian.pi-enabled", String(agentEnabled.pi));
    if (area === "codex" && !agentEnabled.codex) {
      setArea("local");
      setActive(null);
      setActiveKey(null);
    }
    if (area === "hermes" && !agentEnabled.hermes) {
      setArea("local");
      setActive(null);
      setActiveKey(null);
    }
    if (area === "pi" && !agentEnabled.pi) {
      setArea("local");
      setActive(null);
      setActiveKey(null);
    }
  }, [agentEnabled.codex, agentEnabled.hermes, agentEnabled.pi, area]);
  useEffect(() => {
    if (!user) return;
    void api<LocalSession[]>("/local/sessions")
      .then(setLocalSessions)
      .catch((e) => setError(errorMessage(e)));
  }, [user]);
  useEffect(() => {
    const restart = () => {
      if (!active) return;
      setProgress("正在重启会话…");
      void api(`/settings/terminals/${encodeURIComponent(active.id)}/restart`, {
        method: "POST",
      })
        .then(() => {
          setTerminalAttached(true);
          setConnectedSessionID(null);
          setTerminalRevision((value) => value + 1);
          setProgress("正在重新连接…");
        })
        .catch((e) => setError(errorMessage(e)));
    };
    window.addEventListener("jian-restart-terminal", restart);
    return () => window.removeEventListener("jian-restart-terminal", restart);
  }, [active?.id]);
  useEffect(() => {
    const enter = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      const target =
        localSessions.find((session) => session.id === id) ||
        all.find((session) => session.id === id);
      if (target) activate(target);
    };
    window.addEventListener("jian-enter-terminal", enter);
    return () => window.removeEventListener("jian-enter-terminal", enter);
  }, [all, localSessions, profile]);
  useEffect(() => {
    const releaseAll = () => {
      setOpenSessions([]);
      clearActive();
      setTerminalAttached(false);
      setProgress("已释放所有会话");
      localStorage.removeItem(activeLocalSessionKey);
      localStorage.removeItem(activeSessionKey("codex"));
      localStorage.removeItem(activeSessionKey("hermes", profile));
    };
    window.addEventListener("jian-release-all-terminals", releaseAll);
    return () =>
      window.removeEventListener("jian-release-all-terminals", releaseAll);
  }, [profile]);
  if (!ready) return null;
  if (!user) return <Login done={me} />;
  const choose = (s: Session) => activate(activeView(s));
  const chooseLocal = (session: LocalSession) => activate(session);
  const selectTab = (key: string) => {
    const session = openSessions.find((item) => openSessionKey(item) === key);
    if (session) activate(session);
  };
  const reorderTabs = (from: string, to: string) =>
    setOpenSessions((current) => {
      const fromIndex = current.findIndex(
        (item) => openSessionKey(item) === from,
      );
      const toIndex = current.findIndex((item) => openSessionKey(item) === to);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  const closeTab = (key: string) => {
    const index = openSessions.findIndex(
      (item) => openSessionKey(item) === key,
    );
    const closed = openSessions[index];
    if (!closed) return;
    const next = openSessions.filter((item) => openSessionKey(item) !== key);
    setOpenSessions(next);
    if (key !== activeKey) return;
    const replacement = next[Math.max(0, index - 1)] || next[0];
    if (replacement) {
      activate(replacement);
      return;
    }
    localStorage.removeItem(selectedSessionKey(closed, profile));
    clearActive();
  };
  const createLocal = async () => {
    try {
      const x = await api<LocalSession>("/local/sessions", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setLocalSessions((rows) => [x, ...rows]);
      chooseLocal(x);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const removeLocal = async (session: LocalSession) => {
    try {
      await api(`/local/sessions/${encodeURIComponent(session.id)}`, {
        method: "DELETE",
      });
      setLocalSessions((rows) => rows.filter((x) => x.id !== session.id));
      const key = openSessionKey(session);
      setOpenSessions((rows) =>
        rows.filter((item) => openSessionKey(item) !== key),
      );
      if (activeKey === key) {
        localStorage.removeItem(selectedSessionKey(session));
        localStorage.removeItem(activeAreaKey);
        setActive(null);
        setActiveKey(null);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const refresh = async (k: Kind) => {
    if (refreshingKind) return;
    setRefreshingKind(k);
    setProgress("正在刷新会话…");
    if (await load(k)) setProgress("已刷新");
    else setProgress("刷新失败");
    setRefreshingKind(null);
  };
  const create = async (
    workspace: string,
    launchArgs: string[] = [],
    targetProfile = profile,
  ) => {
    invalidateSessionLoads(token.current);
    const x = activeView(
      await api<Session>(`/agents/${kind}/sessions`, {
        method: "POST",
        body: JSON.stringify({
          workspace,
          launch_args: launchArgs,
          ...(kind === "hermes" || kind === "pi"
            ? { profile: targetProfile }
            : {}),
        }),
      }),
    );
    invalidateSessionLoads(token.current);
    setPicking(false);
    choose(x);
    await load(kind);
  };
  const manage = async (
    mode: "rename" | "delete",
    s: Session,
    title?: string,
  ) => {
    if (mode === "rename") {
      const x = activeView(
        await api<Session>(
          `/agents/${kind}/sessions/${encodeURIComponent(s.id)}`,
          { method: "PATCH", body: JSON.stringify({ title }) },
        ),
      );
      choose(x);
    } else {
      await api(`/agents/${kind}/sessions/${encodeURIComponent(s.id)}`, {
        method: "DELETE",
      });
      sessionCache.current[kind] = (sessionCache.current[kind] || []).filter(
        (item) => item.id !== s.id,
      );
      const key = openSessionKey(s);
      setOpenSessions((rows) =>
        rows.filter((item) => openSessionKey(item) !== key),
      );
      if (activeKey === key) {
        setActive(null);
        setActiveKey(null);
      }
      localStorage.removeItem(selectedSessionKey(s, profile));
    }
    setDialog(null);
    await load(kind);
  };
  const releaseSession = async (target: OpenSession) => {
    await api(`/settings/terminals/${encodeURIComponent(target.id)}/release`, {
      method: "POST",
    });
    if (target.kind === "local")
      setLocalSessions((rows) => rows.filter((item) => item.id !== target.id));
    closeTab(openSessionKey(target));
    if (target.kind !== "local") await load(target.kind);
  };
  // Keep the existing Hermes restore-key contract covered while Pi uses the same profile flow.
  // const selectProfile = (nextProfile: string) => { localStorage.removeItem(activeSessionKey('hermes', nextProfile)); };
  const selectArea = (nextArea: Kind | "local") => {
    setSettingsOpen(false);
    localStorage.setItem(activeAreaKey, nextArea);
    localStorage.setItem(activeKindKey, nextArea);
    setArea(nextArea);
    if (nextArea !== "local") setKind(nextArea);
    else clearActive();
  };
  const selectProfile = (nextProfile: string) => {
    setSettingsOpen(false);
    hermesHomeSelected.current = kind === "hermes";
    localStorage.setItem(activeAreaKey, kind);
    localStorage.setItem(activeKindKey, kind);
    localStorage.setItem(activeProfileKey, nextProfile);
    localStorage.removeItem(activeSessionKey(kind, nextProfile));
    clearActive();
    setArea(kind);
    setProfile(nextProfile);
  };
  const openWorkspace = (targetKind: Kind, targetProfile?: string) => {
    setSettingsOpen(false);
    localStorage.setItem(activeAreaKey, targetKind);
    localStorage.setItem(activeKindKey, targetKind);
    setArea(targetKind);
    setKind(targetKind);
    if ((targetKind === "hermes" || targetKind === "pi") && targetProfile) {
      localStorage.setItem(activeProfileKey, targetProfile);
      setProfile(targetProfile);
    }
    if (targetKind === "pi" && targetProfile && targetProfile !== "default") {
      void create(`~/.pi/agents/${targetProfile}`, [], targetProfile);
    } else setPicking(true);
  };
  const showMore = (listKind: Kind, listProfile = "") => {
    const key = `${listKind}:${listProfile}`;
    setVisibleCounts((value) => ({ ...value, [key]: (value[key] || 8) + 8 }));
  };
  const logout = () => {
    void api("/auth/logout", { method: "POST" }).then(() => {
      Object.keys(localStorage)
        .filter((key) => key.startsWith("jian.") && key !== themeKey)
        .forEach((key) => localStorage.removeItem(key));
      setUser(null);
    });
  };
  const updateAgentEnabled = async (target: Kind, enabled: boolean) => {
    setAgentEnabled((value) => ({ ...value, [target]: enabled }));
    localStorage.setItem(`jian.${target}-enabled`, String(enabled));
    if (!enabled && area === target) selectArea("local");
  };
  const connected = !!active && connectedSessionID === active.id;
  const activeKind = active?.kind === "local" ? "local" : active?.kind || area;
  const disconnect = (session?: OpenSession) => {
    const target = session || active;
    if (!target) return;
    const key = openSessionKey(target);
    if (key === activeKey) {
      setTerminalAttached(false);
      setConnectedSessionID(null);
      setProgress("已断开连接");
    }
    closeTab(key);
  };
  const release = async () => {
    if (!active) return;
    try {
      await releaseSession(active);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const currentStatus = statusView(
    connected
      ? progress || active?.status
      : terminalAttached
        ? progress || active?.status
        : "已断开连接",
  );
  const reconnect = () => {
    setTerminalAttached(true);
    setConnectedSessionID(null);
    setProgress("正在重新连接…");
    setTerminalRevision((v) => v + 1);
  };
  return (
    <div className={"app " + (mobileNavigationOpen ? "nav-mobile-open" : "")}>
      <button
        className="icon mobile-nav-toggle"
        onClick={() => setMobileNavigationOpen((open) => !open)}
        aria-label={mobileNavigationOpen ? "关闭导航" : "打开导航"}
      >
        {mobileNavigationOpen ? <X /> : <Menu />}
      </button>
      {mobileNavigationOpen && (
        <button
          className="nav-scrim"
          aria-label="关闭导航"
          onClick={() => setMobileNavigationOpen(false)}
        />
      )}
      <SidebarNavigation
        active={active}
        currentKind={area}
        profile={profile}
        profiles={profiles}
        sessions={all}
        localSessions={localSessions}
        sidebarRef={sidebarRef}
        onScroll={(scrollTop) =>
          localStorage.setItem(navScrollKey(kind, profile), String(scrollTop))
        }
        onAreaChange={selectArea}
        onProfileChange={selectProfile}
        onSelectSession={choose}
        onSelectLocal={chooseLocal}
        onCreateLocal={() => void createLocal()}
        onRemoveLocal={(session) => void removeLocal(session)}
        onOpenWorkspace={openWorkspace}
        onRefresh={(target) => void refresh(target)}
        refreshingKind={refreshingKind}
        onSettings={setSettingsKind}
        onDialog={(mode, session) => setDialog({ mode, session })}
        onRelease={(session) =>
          void releaseSession(session).catch((e) => setError(errorMessage(e)))
        }
        connectedSessionID={connectedSessionID}
        onDisconnect={disconnect}
        visibleCount={(listKind, listProfile = "") =>
          visibleCounts[`${listKind}:${listProfile}`] || 8
        }
        onShowMore={showMore}
        username={user}
        onLogout={logout}
        settingsOpen={settingsOpen}
        onSettingsPage={() => {
          setSettingsOpen((open) => !open);
          setMobileNavigationOpen(false);
        }}
      />
      <div className="workspace-view">
        <main className="conversation">
          <header className="context-bar">
            <div className="context-copy">
              <span className="agent-label">
                <AgentIcon kind={activeKind} />
                {activeKind === "local"
                  ? "Local · Bash"
                  : activeKind === "hermes"
                    ? `Hermes · ${active?.kind === "hermes" ? active.profile || profile : profile}`
                    : "Codex"}
              </span>
              {active ? (
                <>
                  <h2 title={active.id}>
                    {active.kind === "local" ? "Bash" : displayTitle(active)}
                  </h2>
                  <div className="session-meta">
                    <span title={active.workspace}>
                      {displayWorkspace(active)}
                    </span>
                    {active.kind !== "codex" && (
                      <span>
                        {active.kind === "local"
                          ? "通道：本地终端"
                          : displayChannel(active)}
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <h2>
                    {activeKind === "local"
                      ? "Local 工作区"
                      : activeKind === "hermes"
                        ? "Hermes 工作区"
                        : "Codex 工作区"}
                  </h2>
                  <span className="muted">
                    {activeKind === "local"
                      ? "选择一个本地会话，或新建一个本地终端"
                      : "选择现有会话，或在工作目录中启动新会话"}
                  </span>
                </>
              )}
            </div>
            <div className="context-actions">
              <ThemeControls
                interfaceTheme={theme}
                terminalTheme={terminalTheme}
                onInterfaceThemeChange={setTheme}
                onTerminalThemeChange={setTerminalTheme}
              />
              <div className="mobile-terminal-font-size">
                <TerminalFontSizeControl
                  compact
                  size={terminalFontSize}
                  onChange={changeFontSize}
                />
              </div>
              <StatusMenu
                status={currentStatus}
                connected={connected}
                onReconnect={reconnect}
                onRelease={release}
              />
            </div>
          </header>
          <SessionTabs
            sessions={openSessions}
            activeKey={activeKey}
            settingsOpen={settingsOpen}
            select={selectTab}
              openSettings={() => setSettingsOpen(true)}
              closeSettings={() => setSettingsOpen(false)}
            close={closeTab}
            reorder={reorderTabs}
          />
          <ErrorDialog
            open={!!error}
            message={error}
            onClose={() => setError("")}
          />
          {settingsOpen ? (
            <SettingsPage
              theme={theme}
              onThemeChange={setTheme}
              terminalTheme={terminalTheme}
              onTerminalThemeChange={setTerminalTheme}
              onAgentEnabledChange={updateAgentEnabled}
            />
          ) : active ? (
            terminalAttached ? (
              <AgentTerminal
                key={`${active.id}:${terminalRevision}`}
                session={active}
                terminalTheme={terminalTheme}
                terminalPath={activeKind}
                onProgress={setProgress}
                onStatus={(value) => {
                  setProgress(value);
                  if (value === "running") setConnectedSessionID(active.id);
                  else setConnectedSessionID(null);
                  setActive(
                    (current) => current && { ...current, status: value },
                  );
                }}
              />
            ) : (
              <div className="terminal-disconnected">
                <span>终端已断开</span>
                <button onClick={reconnect}>
                  <RefreshCw />
                  重新连接
                </button>
              </div>
            )
          ) : (
            <div className="empty-state">
              <span className="empty-orbit">
                <AgentIcon kind={activeKind} />
              </span>
              <span className="eyebrow">
                {activeKind === "local"
                  ? "LOCAL · HOME"
                  : activeKind === "hermes"
                    ? `HERMES · ${profile}`
                    : "CODEX"}
              </span>
              <h1>
                {activeKind === "local"
                  ? "准备好开始本地工作"
                  : "从一个工作目录开始"}
              </h1>
              <p>
                {activeKind === "local"
                  ? "这里不会自动打开 Bash。选择一个已有会话，或新建一个本地终端。"
                  : "代理会在服务器拥有的终端中持续运行；关闭或刷新浏览器不会中止任务。"}
              </p>
              {activeKind === "local" ? (
                <button onClick={() => void createLocal()}>
                  <Plus />
                  新建本地 Bash 会话
                </button>
              ) : (
                <button onClick={() => openWorkspace(kind, profile)}>
                  <Plus />
                  选择目录并新建会话
                </button>
              )}
            </div>
          )}
        </main>
      </div>
      {picking && (
        <WorkspacePicker
          sessions={all}
          profile={profile}
          kind={kind}
          close={() => setPicking(false)}
          select={create}
        />
      )}
      {dialog && (
        <SessionDialog
          {...dialog}
          close={() => setDialog(null)}
          confirm={(title) => manage(dialog.mode, dialog.session, title)}
        />
      )}
      {settingsKind && (
        <AgentSettingsDialog
          kind={settingsKind}
          close={() => setSettingsKind(null)}
          saved={() => {
            void load();
            if (settingsKind === "hermes")
              void api<string[]>("/hermes/profiles").then(setProfiles);
          }}
        />
      )}
      <QuickNote username={user} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
