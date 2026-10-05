import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, Folder, FolderOpen, Home, Plus, Trash2, X } from "lucide-react";
import { Checkbox, Dialog, Collapsible } from "radix-ui";
import { api, errorMessage } from "../../shared/api";
import type { Session, Kind, BrowseResult, SettingsResponse } from "../../shared/model";
import { recentWorkspaces } from "../../shared/persistence";
import { beginSessionLoad, invalidateSessionLoads, isCurrentSessionLoad, type SessionLoadVersion } from "../../session-load-guard";
import { restoreDialogFocus } from "../../shared/ui/dialog-focus";

export function WorkspacePicker({
  sessions,
  close,
  select,
  profile,
  kind,
  creating,
}: {
  sessions: Session[];
  close: () => void;
  select: (path: string, launchArgs: string[]) => Promise<void>;
  profile?: string;
  kind: Kind;
  creating: boolean;
}) {
  const [current, setCurrent] = useState(""),
    [parent, setParent] = useState(""),
    [entries, setEntries] = useState<BrowseResult["entries"]>([]),
    [manual, setManual] = useState("~"),
    [launchArgs, setLaunchArgs] = useState<string[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [showHidden, setShowHidden] = useState(false),
    [browseReady, setBrowseReady] = useState(false),
    [argsReady, setArgsReady] = useState(false),
    [argsError, setArgsError] = useState("");
  const mounted = useRef(true);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const starting = useRef(false);
  const launchArgumentRefs = useRef<(HTMLInputElement | null)[]>([]);
  const browseVersion = useRef<SessionLoadVersion>({ current: 0 });
  const closeRef = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);
  const readingArgs = useRef(false);
  const recent = recentWorkspaces(sessions);
  const visibleEntries = entries.filter((entry) => showHidden || !entry.name.startsWith("."));
  const browse = async (path: string) => {
    if (creating || starting.current) return;
    const version = beginSessionLoad(browseVersion.current);
    setLoading(true);
    setBrowseReady(false);
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
      setBrowseReady(true);
    } catch (e) {
      if (isCurrentSessionLoad(browseVersion.current, version))
        setError(errorMessage(e));
    } finally {
      if (isCurrentSessionLoad(browseVersion.current, version))
        setLoading(false);
    }
  };
  const loadArgs = async () => {
    if (readingArgs.current) return;
    readingArgs.current = true;
    setArgsReady(false); setArgsError("");
    try {
      const value = await api<SettingsResponse>("/settings");
      if (mounted.current) { setLaunchArgs(value.settings[`${kind}_args`] || []); setArgsReady(true); }
    } catch (e) { if (mounted.current) setArgsError(errorMessage(e)); }
    finally { readingArgs.current = false; }
  };
  useEffect(() => {
    mounted.current = true; void browse("~"); void loadArgs();
    return () => { mounted.current = false; invalidateSessionLoads(browseVersion.current); };
  }, [kind]);
  const start = async () => {
    if (starting.current || creating || !browseReady || !argsReady || loading) return;
    starting.current = true; submitted.current = true; setError("");
    try { await select(current, launchArgs.filter(argument => argument.trim())); }
    catch (e) { submitted.current = false; if (mounted.current) setError(errorMessage(e)); }
    finally { starting.current = false; }
  };
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
    <Dialog.Root open onOpenChange={open => { if (!open && !creating && !starting.current) close(); }}><Dialog.Portal>
      <Dialog.Overlay className="workspace-overlay" />
      <Dialog.Content className="workspace-picker" aria-label="选择工作目录" aria-busy={creating}
        onOpenAutoFocus={event => { event.preventDefault(); closeRef.current?.focus({ preventScroll: true }); }}
        onCloseAutoFocus={event => { if (submitted.current) event.preventDefault(); else restoreDialogFocus(event, previousFocus.current); }}
        onEscapeKeyDown={event => { if (creating || starting.current) event.preventDefault(); }}
        onInteractOutside={event => { if (creating || starting.current) event.preventDefault(); }}>
        <header>
          <div>
            <span className="eyebrow">
              {kind === "hermes" ? `Hermes · ${profile || "default"}` : kind === "pi" ? `Pi · ${profile || "default"}` : "Codex"}
            </span>
            <Dialog.Title asChild><h3>选择工作目录</h3></Dialog.Title>
            <Dialog.Description asChild><span>新会话将在此目录启动</span></Dialog.Description>
          </div>
          <button ref={closeRef} className="icon" aria-label="关闭目录选择器" onClick={close} disabled={creating}>
            <X />
          </button>
        </header>
        <div className="workspace-picker-body">
        {recent.length > 0 && (
          <div className="recent-workspaces">
            <strong>最近使用</strong>
            <div>
              {recent.map((p) => (
                <button key={p} onClick={() => void browse(p)} title={p} disabled={creating}>
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
            disabled={creating}
            onClick={() => void browse("~")}
          >
            <Home />
          </button>
          <button
            type="button"
            aria-label="上级目录"
            title="上级目录"
            disabled={creating || !parent || parent === current}
            onClick={() => void browse(parent)}
          >
            <ChevronLeft />
          </button>
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            aria-label="文件目录路径"
            disabled={creating}
          />
          <button type="submit" disabled={creating}>前往</button>
        </form>
        <label className="workspace-hidden-files" htmlFor="show-hidden-files">
          <Checkbox.Root id="show-hidden-files" disabled={creating} checked={showHidden} onCheckedChange={(checked) => setShowHidden(checked === true)}>
            <Checkbox.Indicator>✓</Checkbox.Indicator>
          </Checkbox.Root>
          显示隐藏文件
        </label>
        <div className="directory-list" aria-busy={loading}>
          {loading ? (
            <p className="muted">正在读取目录…</p>
          ) : visibleEntries.length ? (
            visibleEntries.map((x) => (
              <button key={x.name} onClick={() => enter(x.name)} disabled={creating}>
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
        <Collapsible.Root className="workspace-advanced"><Collapsible.Trigger asChild><button type="button" disabled={creating}>启动参数 <ChevronDown /></button></Collapsible.Trigger><Collapsible.Content><fieldset className="workspace-launch-args" disabled={creating || !argsReady}>
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
        </Collapsible.Content></Collapsible.Root>
        {argsError && <p className="error workspace-error" role="alert">启动参数读取失败：{argsError}<button onClick={() => void loadArgs()}>重试</button></p>}
        {!argsReady && !argsError && <p className="workspace-status" role="status">正在读取启动参数…</p>}
        {error && <p className="error workspace-error" role="alert">{error}</p>}
        </div>
        <footer>
          <span title={current}>{current || "~"}</span>
          <button
            type="button"
            disabled={loading || !current || !browseReady || !argsReady || creating}
            onClick={() => void start()}
          >
            {creating ? "正在创建…" : "在此启动会话"}
          </button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>
  );
}
