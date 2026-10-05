import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDown, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { SessionTabs } from "./features/session-catalog/SessionTabs";
import { WorkspacePicker } from "./features/session-catalog/WorkspacePicker";
import { AgentTerminal } from "./features/terminal/AgentTerminal";
import { ConfirmDialog } from "./shared/ui/ConfirmDialog";
import { openSessionKey, openSessionTitle, openSessionLabel, connectionView, type OpenSession, type ConnectionState } from "./shared/model";
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
import { adjacentTab, moveTab } from "./session-tabs";
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
  initialKind,
  initialTheme,
  initialTerminalFontSize,
  displayTitle,
  activeView,
  statusView,
  isMobile,
  type Kind,
  type LocalSession,
  type Theme,
  type Session,
  type SettingsResponse,
} from "./shared/model";
import {
  initialTerminalTheme,
  type TerminalTheme,
} from "./features/terminal/themes";
import { MenuPopup } from "./shared/ui/Popup";
import { ErrorDialog } from "./shared/ui/ErrorDialog";
import { SessionDialog } from "./features/session-catalog/SessionDialog";
import { Login } from "./features/auth/Login";
import { SidebarNavigation } from "./features/navigation/SidebarNavigation";
import { SettingsPage } from "./features/settings/SettingsPage";
import { AgentIcon } from "./shared/ui/AgentIcon";
import { SessionContext } from "./shared/ui/SessionContext";
import { WorkbenchTools } from "./shared/ui/WorkbenchTools";

import "./styles.css";
import "./layout.css";

function StatusMenu({
  status,
  connected,
  onReconnect,
  onRelease,
}: {
  status: ReturnType<typeof statusView>;
  connected: boolean;
  onReconnect: () => void;
  onRelease: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
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
                window.dispatchEvent(new Event("jian-restart-terminal"));
              }}
            >
              <RefreshCw />
              重启会话
            </button>
            <button
              onClick={() => {
                setOpen(false);
                void onRelease();
              }}
            >
              <Trash2 />
              释放会话
            </button>
          </>
        }
      />
    </div>
  );
}

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
    [secondary, setSecondary] = useState<Session | null>(null),
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
    [compactNavigation, setCompactNavigation] = useState(isMobile),
    [tabOrder, setTabOrder] = useState<string[]>(() => []),
    [picking, setPicking] = useState(false),
    [settingsBusy, setSettingsBusyState] = useState(false),
    [creating, setCreating] = useState(false),
    [dialog, setDialog] = useState<{
      mode: "rename" | "delete";
      session: Session;
    } | null>(null),
    [settingsTarget, setSettingsTarget] = useState<Kind | "local" | null>(null),
    [settingsDirty, setSettingsDirty] = useState(false),
    [discardOpen, setDiscardOpen] = useState(false),
    [confirmation, setConfirmation] = useState<{ type: "release" | "restart" | "local-delete"; session: OpenSession } | null>(null),
    [operationBusy, setOperationBusy] = useState(false),
    [connection, setConnection] = useState<ConnectionState>("disconnected"),
    [wideScreen, setWideScreen] = useState(() => window.matchMedia("(min-width: 1200px)").matches),
    [catalogError, setCatalogError] = useState<{ kind: Kind; profile: string; message: string } | null>(null),
    [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const token = useRef<SessionLoadVersion>({ current: 0 }),
    sessionCache = useRef<Partial<Record<Kind, Session[]>>>({}),
    hermesHomeSelected = useRef(false);
  const settingsBusyRef = useRef(false), creatingRef = useRef(false), authEpoch = useRef(0);
  const leavingSettings = useRef<(() => void) | null>(null);
  const operationInFlight = useRef(false);
  const requestNavigation = (action: () => void) => {
    if (settingsBusyRef.current || creatingRef.current) return;
    if (settingsOpen && settingsDirty) { leavingSettings.current = action; setDiscardOpen(true); }
    else action();
  };
  const openSettings = (target: Kind | "local" | null = null) => {
    if (navigationLocked()) return;
    setSettingsTarget(target); setSettingsOpen(true); setMobileNavigationOpen(false);
  };
  const setSettingsBusy = (busy: boolean) => { settingsBusyRef.current = busy; setSettingsBusyState(busy); };
  const navigationLocked = () => settingsBusyRef.current || creatingRef.current;
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
  const load = async (target = kind, refresh = false) => {
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
        await api<Session[]>(
          refresh ? `/agents/${target}/sessions/refresh` : `/agents/${target}/sessions/cache`,
          refresh ? { method: "POST" } : undefined,
        ),
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
                (row) => openSessionKey(row) === openSessionKey(session),
              ) || session,
          ),
        );
        setActive((session) =>
          session?.kind === target
            ? rows.find(
                (row) => openSessionKey(row) === openSessionKey(session),
              ) || session
            : session,
        );
        setCatalogError(value => value?.kind === target && value.profile === profile ? null : value);
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
          localStorage.getItem(activeSessionKey(target, profile)) || (target === "pi" ? localStorage.getItem(activeSessionKey(target)) : null),
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
        setCatalogError({ kind: target, profile, message: errorMessage(e) });
      return false;
    }
  };
  const clearActive = () => {
    setActive(null);
    setActiveKey(null);
    setConnectedSessionID(null);
    setProgress("");
  };
  const activate = (session: OpenSession, completingCreation = false) => {
    if (navigationLocked() && !completingCreation) return;
    const key = openSessionKey(session);
    if (!settingsOpen && tabsRef.current.selected === key && tabsRef.current.attached) {
      setMobileNavigationOpen(false);
      return;
    }
    setSettingsOpen(false);
    setOpenSessions((current) =>
      current.some((item) => openSessionKey(item) === key)
        ? current
        : [...current, session],
    );
    setActiveKey(key);
    setActive(session);
    if (secondary && openSessionKey(secondary) === key) setSecondary(null);
    setTerminalAttached(true);
    setConnectedSessionID(null);
    setConnection("connecting");
    setProgress("正在加载会话…");
    setArea(session.kind);
    localStorage.setItem(selectedSessionKey(session, profile), session.id);
    if (session.kind === "local") localStorage.setItem(activeAreaKey, "local");
    else {
      const nextProfile = session.profile || "default";
      localStorage.setItem(activeAreaKey, session.kind);
      localStorage.setItem(activeKindKey, session.kind);
      setKind(session.kind);
      if (session.kind === "hermes" || session.kind === "pi") {
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
    const media = window.matchMedia('(max-width: 800px)');
    const update = () => { setCompactNavigation(media.matches); setMobileNavigationOpen(false); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!compactNavigation) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        document.documentElement.style.setProperty('--dialog-viewport-height', `${viewport?.height || window.innerHeight}px`);
        document.documentElement.style.setProperty('--dialog-viewport-top', `${viewport?.offsetTop || 0}px`);
      });
    };
    update(); viewport?.addEventListener('resize', update); viewport?.addEventListener('scroll', update); window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame); viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); window.removeEventListener('resize', update);
      document.documentElement.style.removeProperty('--dialog-viewport-height'); document.documentElement.style.removeProperty('--dialog-viewport-top');
    };
  }, [compactNavigation]);
  useEffect(() => {
    const keys = openSessions.map(openSessionKey);
    setTabOrder(current => {
      const next = [...current.filter(key => keys.includes(key)), ...keys.filter(key => !current.includes(key))];
      return next.join('\0') === current.join('\0') ? current : next;
    });
  }, [openSessions]);
  useEffect(() => { sessionStorage.removeItem("jian.settings-tab-open"); }, []);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1200px)");
    const update = () => setWideScreen(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
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
      if (active) setConfirmation({ type: "restart", session: active });
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
      if (target) requestNavigation(() => activate(target));
    };
    window.addEventListener("jian-enter-terminal", enter);
    return () => window.removeEventListener("jian-enter-terminal", enter);
  }, [all, localSessions, profile]);
  useEffect(() => {
    const releaseAll = () => {
      setOpenSessions([]);
      setSecondary(null);
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
  const tabsRef = useRef({ order: tabOrder, selected: activeKey, sessions: openSessions, underlying: activeKey, attached: terminalAttached });
  tabsRef.current = { order: tabOrder, selected: activeKey, sessions: openSessions, underlying: activeKey, attached: terminalAttached };
  if (!ready) return null;
  if (!user) return <Login done={me} />;
  const currentAuthEpoch = authEpoch.current;
  const isCurrentUser = () => currentAuthEpoch === authEpoch.current;
  const choose = (s: Session) => activate(activeView(s));
  const chooseLocal = (session: LocalSession) => activate(session);
  const selectTab = (key: string) => {
    if (navigationLocked()) return;
    const session = openSessions.find((item) => openSessionKey(item) === key);
    if (session) activate(session);
  };
  const reorderTabs = (from: string, to: string) => {
    if (!navigationLocked()) setTabOrder(current => moveTab(current, from, to));
  };
  const closeTab = (key: string) => {
    const { order, selected, sessions, underlying } = tabsRef.current;
    const closed = sessions.find(item => openSessionKey(item) === key);
    if (!closed) return;
    setSecondary(current => current && openSessionKey(current) === key ? null : current);
    const replacement = adjacentTab(order, key);
    setTabOrder(current => current.filter(item => item !== key));
    setOpenSessions(current => current.filter(item => openSessionKey(item) !== key));
    if (closed && localStorage.getItem(selectedSessionKey(closed, profile)) === closed.id)
      localStorage.removeItem(selectedSessionKey(closed, profile));
    if (key !== selected) {
      if (key === underlying) clearActive();
      return;
    }
    const next = sessions.find(item => openSessionKey(item) === replacement);
    if (next) activate(next); else clearActive();
  };
  const createLocal = async () => {
    try { await create(undefined, [], "default", "local"); }
    catch (e) { setError(errorMessage(e)); }
  };
  const removeLocal = async (session: LocalSession) => {
    await api(`/local/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
    setLocalSessions(rows => rows.filter(item => item.id !== session.id));
    closeTab(openSessionKey(session));
  };
  const refresh = async (k: Kind) => {
    if (refreshingKind) return;
    setRefreshingKind(k);
    await load(k, true);
    setRefreshingKind(null);
  };
  const create = async (
    workspace: string | undefined,
    launchArgs: string[] = [],
    targetProfile = profile,
    targetKind: Kind | "local" = kind,
  ) => {
    if (navigationLocked()) return;
    creatingRef.current = true; setCreating(true);
    const epoch = authEpoch.current;
    try {
      if (targetKind === "pi" && workspace === undefined) {
        const { settings } = await api<SettingsResponse>("/settings");
        if (epoch !== authEpoch.current) return;
        const role = settings.pi_roles.find(item => item.name === targetProfile);
        if (!role) throw new Error("Pi 角色不存在");
        workspace = role.home;
      }
      invalidateSessionLoads(token.current);
      const x = await api<OpenSession>(targetKind === "local" ? "/local/sessions" : `/agents/${targetKind}/sessions`, {
        method: "POST",
        body: JSON.stringify(targetKind === "local" ? {} : { workspace, launch_args: launchArgs, ...(targetKind === "hermes" || targetKind === "pi" ? { profile: targetProfile } : {}) }),
      });
      if (epoch !== authEpoch.current) return;
      invalidateSessionLoads(token.current);
      setPicking(false);
      if (x.kind === "local") setLocalSessions(rows => [x, ...rows]);
      activate(x.kind === "local" ? x : activeView(x), true);
      if (targetKind !== "local") void load(targetKind);
    } catch (e) { if (epoch === authEpoch.current) throw e; }
    finally { if (epoch === authEpoch.current) { creatingRef.current = false; setCreating(false); } }
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
      closeTab(openSessionKey(s));
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
    if (secondary?.id === target.id && secondary.kind === target.kind)
      setSecondary(null);
    if (target.kind !== "local") await load(target.kind);
  };
  // Keep the existing Hermes restore-key contract covered while Pi uses the same profile flow.
  // const selectProfile = (nextProfile: string) => { localStorage.removeItem(activeSessionKey('hermes', nextProfile)); };
  const selectArea = (nextArea: Kind | "local") => {
    if (navigationLocked()) return;
    setSettingsOpen(false);
    localStorage.setItem(activeAreaKey, nextArea);
    localStorage.setItem(activeKindKey, nextArea);
    setArea(nextArea);
    if (nextArea !== "local") setKind(nextArea);
    else clearActive();
  };
  const selectProfile = (nextProfile: string) => {
    if (navigationLocked()) return;
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
    if (navigationLocked()) return;
    setMobileNavigationOpen(false);
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
      void create(undefined, [], targetProfile, targetKind).catch(e => setError(errorMessage(e)));
    } else setPicking(true);
  };
  const showMore = (listKind: Kind, listProfile = "") => {
    const key = `${listKind}:${listProfile}`;
    setVisibleCounts((value) => ({ ...value, [key]: (value[key] || 8) + 8 }));
  };
  const logout = () => {
    authEpoch.current++; settingsBusyRef.current = false; creatingRef.current = false;
    setSettingsBusyState(false); setCreating(false);
    setSettingsOpen(false); setSettingsTarget(null); setPicking(false);
    void api("/auth/logout", { method: "POST" }).then(() => {
      Object.keys(localStorage)
        .filter((key) => key.startsWith("jian.") && key !== themeKey)
        .forEach((key) => localStorage.removeItem(key));
      setUser(null);
      setPicking(false); setSettingsTarget(null); setError("");
    }).catch(e => setError(errorMessage(e)));
  };
  const updateAgentEnabled = async (target: Kind, enabled: boolean) => {
    setAgentEnabled((value) => ({ ...value, [target]: enabled }));
    localStorage.setItem(`jian.${target}-enabled`, String(enabled));

  };
  const openSecondary = (session: Session) => {
    if (active && openSessionKey(active) === openSessionKey(session)) return;
    const target = activeView(session);
    setOpenSessions(current => current.some(item => openSessionKey(item) === openSessionKey(target)) ? current : [...current, target]);
    setSecondary(target);
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
      setConnection("disconnected");
      setProgress("已断开连接");
    }
    closeTab(key);
  };
  const currentStatus = connectionView(active ? connection : "disconnected");
  const confirmOperation = async () => {
    if (!confirmation || operationInFlight.current) return;
    const { type, session } = confirmation;
    operationInFlight.current = true; setOperationBusy(true);
    try {
      if (type === "release") await releaseSession(session);
      else if (type === "local-delete" && session.kind === "local") await removeLocal(session);
      else if (type === "restart") {
        await api(`/settings/terminals/${encodeURIComponent(session.id)}/restart`, { method: "POST" });
        if (active && openSessionKey(active) === openSessionKey(session)) {
          setTerminalAttached(true); setConnectedSessionID(null);
          setConnection("connecting"); setTerminalRevision(value => value + 1);
        }
      }
      setConfirmation(null);
    } catch (e) { setError(errorMessage(e)); }
    finally { operationInFlight.current = false; setOperationBusy(false); }
  };
  const reconnect = () => {
    setTerminalAttached(true);
    setConnectedSessionID(null);
    setConnection("connecting");
    setProgress("正在重新连接…");
    setTerminalRevision((v) => v + 1);
  };
  return (
    <div className={"app " + (mobileNavigationOpen ? "nav-mobile-open" : "")}>
      <SidebarNavigation
        active={active}
        currentKind={area}
        profile={profile}
        profiles={profiles}
        sessions={all}
        localSessions={localSessions}
        compact={compactNavigation}
        navigationOpen={mobileNavigationOpen}
        onNavigationOpenChange={setMobileNavigationOpen}
        handingOffFocus={settingsOpen || picking || !!dialog || !!error || !!confirmation || discardOpen}
        busy={settingsBusy || creating}
        creating={creating}
        onAreaChange={next => requestNavigation(() => selectArea(next))}
        onProfileChange={next => requestNavigation(() => selectProfile(next))}
        onSelectSession={next => requestNavigation(() => choose(next))}
        onSelectLocal={next => requestNavigation(() => chooseLocal(next))}
        onCreateLocal={() => requestNavigation(() => void createLocal())}
        onRemoveLocal={session => setConfirmation({ type: "local-delete", session })}
        onOpenWorkspace={(target, nextProfile) => requestNavigation(() => openWorkspace(target, nextProfile))}
        onRefresh={(target) => void refresh(target)}
        refreshingKind={refreshingKind}
        onSettings={target => openSettings(target)}
        onDialog={(mode, session) => { if (navigationLocked()) return; setMobileNavigationOpen(false); setDialog({ mode, session }); }}
        onRelease={session => setConfirmation({ type: "release", session })}
        connectedSessionID={connectedSessionID}
        onDisconnect={disconnect}
        onOpenSecondary={openSecondary}
        visibleCount={(listKind, listProfile = "") =>
          visibleCounts[`${listKind}:${listProfile}`] || 8
        }
        onShowMore={showMore}
        username={user}
        onLogout={() => settingsBusyRef.current ? logout() : requestNavigation(logout)}
        settingsOpen={settingsOpen}
        onSettingsPage={() => openSettings()}
        catalogError={catalogError?.kind === area && ((area !== "hermes" && area !== "pi") || catalogError.profile === profile) ? catalogError.message : ""}
      />
      <div className="workspace-view">
        {settingsOpen ? (
          <SettingsPage
              theme={theme}
              onThemeChange={setTheme}
              terminalTheme={terminalTheme}
              onTerminalThemeChange={setTerminalTheme}
              onBack={() => requestNavigation(() => { setConnection(terminalAttached ? "connecting" : "disconnected"); setSettingsOpen(false); })}
              targetAgent={settingsTarget}
              onDirtyChange={setSettingsDirty}
              terminalFontSize={terminalFontSize}
              onTerminalFontSizeChange={changeFontSize}
              onAgentEnabledChange={updateAgentEnabled}
              busy={settingsBusy}
              onBusyChange={setSettingsBusy}
              isCurrentUser={isCurrentUser}
            />
        ) : <main className="conversation">
          <header className="context-bar">
            <SessionContext session={active} kind={activeKind} profile={profile} />
            <div className="context-actions">
              <QuickNote key={user} username={user} />
              <WorkbenchTools theme={theme} terminalTheme={terminalTheme} fontSize={terminalFontSize}
                onThemeChange={setTheme} onTerminalThemeChange={setTerminalTheme} onFontSizeChange={changeFontSize} />
              {active && <StatusMenu
                status={currentStatus}
                connected={connected}
                onReconnect={reconnect}
                onRelease={async () => { if (active) setConfirmation({ type: "release", session: active }); }}
              />}
            </div>
          </header>
          <SessionTabs
            sessions={openSessions}
            order={tabOrder}
            value={activeKey}
            select={selectTab}
            close={closeTab}
            reorder={reorderTabs}
            locked={settingsBusy || creating}
          />
          {active ? (
            terminalAttached ? (
              <div className={secondary && wideScreen ? "terminal-split" : "terminal-single"}>
                <div className="terminal-pane primary-pane">
                  {secondary && wideScreen && <div className="terminal-pane-label"><span>主终端</span><small>{displayTitle(active)}</small></div>}
                  <AgentTerminal
                    key={`${openSessionKey(active)}:${terminalRevision}`}
                    session={active}
                    terminalTheme={terminalTheme}
                    terminalPath={activeKind}
                    onProgress={setProgress}
                    onStatus={(value) => {
                      setConnection(value === "running" ? "connected" : value === "ended" ? "ended" : "reconnecting");
                      if (value === "running") setConnectedSessionID(active.id);
                      else setConnectedSessionID(null);
                      if (value === "running" || value === "ended") setActive((current) => current && { ...current, status: value });
                    }}
                  />
                </div>
                {secondary && wideScreen && <div className="terminal-pane secondary-pane">
                  <div className="terminal-pane-label"><span>右侧终端</span><small title={secondary.workspace}>{displayTitle(secondary)}</small><button className="icon" aria-label="关闭右侧终端" title="关闭右侧终端" onClick={() => setSecondary(null)}><X /></button></div>
                  <AgentTerminal key={`secondary:${openSessionKey(secondary)}`} session={secondary} terminalTheme={terminalTheme} terminalPath={secondary.kind} onProgress={() => {}} onStatus={() => {}} />
                </div>}
              </div>
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
                    : openSessionLabel({ kind: activeKind })}
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
                <button disabled={creating || settingsBusy} onClick={() => void createLocal()}>
                  <Plus />
                  {creating ? "正在创建…" : "新建本地 Bash 会话"}
                </button>
              ) : (
                <button disabled={creating || settingsBusy} onClick={() => openWorkspace(kind, profile)}>
                  <Plus />
                  选择目录并新建会话
                </button>
              )}
            </div>
          )}
        </main>}
      </div>
      {picking && (
        <WorkspacePicker
          sessions={all}
          profile={profile}
          kind={kind}
          creating={creating}
          close={() => setPicking(false)}
          select={(path, args) => create(path, args, profile, kind)}
        />
      )}
      {dialog && (
        <SessionDialog
          {...dialog}
          close={() => setDialog(null)}
          confirm={(title) => manage(dialog.mode, dialog.session, title)}
        />
      )}
      <ConfirmDialog open={!!confirmation} title={confirmation?.type === "restart" ? "重启会话？" : confirmation?.type === "local-delete" ? "删除本地终端？" : "释放会话？"}
        description={`“${confirmation ? openSessionTitle(confirmation.session) : ""}”的进程将停止，正在执行的任务会中断。`}
        confirmLabel={confirmation?.type === "restart" ? "确认重启" : confirmation?.type === "local-delete" ? "确认删除" : "确认释放"}
        danger busy={operationBusy} onConfirm={() => void confirmOperation()} onClose={() => { if (!operationInFlight.current) setConfirmation(null); }} />
      <ConfirmDialog open={discardOpen} title="放弃未保存的修改？" cancelLabel="继续编辑" description="离开设置后，未保存的配置修改将丢失。" confirmLabel="放弃修改并离开"
        onConfirm={() => { setDiscardOpen(false); setSettingsDirty(false); const action = leavingSettings.current; leavingSettings.current = null; action?.(); }}
        onClose={() => { setDiscardOpen(false); leavingSettings.current = null; }} />
      <ErrorDialog open={!!error} message={error} onClose={() => setError("")} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
