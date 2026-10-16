use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    os::fd::AsRawFd,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Result, anyhow};
use chrono::{DateTime, TimeZone, Utc};
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    model::{AgentKind, AgentSettings, EnvVar, Message, Session},
    remote::RemoteHub,
    store::dirs_home,
    terminal::{TerminalManager, TerminalSpec},
};

#[derive(Clone, Default, Serialize)]
pub struct CatalogState {
    pub rows: Vec<Session>,
    pub revision: u64,
    pub last_success_at: Option<DateTime<Utc>>,
    pub refreshing: bool,
    pub error: Option<String>,
    #[serde(skip)]
    completed: u64,
}

pub struct Runtime {
    pub terminals: Arc<TerminalManager>,
    pub remote: RemoteHub,
    settings: RwLock<AgentSettings>,
    cache: RwLock<HashMap<AgentKind, CatalogState>>,
    refresh_locks: HashMap<AgentKind, Mutex<()>>,
    settings_epoch: AtomicU64,
    pub catalog_updates: tokio::sync::broadcast::Sender<(AgentKind, u64)>,
    codex_app: Mutex<Option<AppServer>>,
}

impl Runtime {
    pub fn new(settings: AgentSettings) -> Arc<Self> {
        Arc::new(Self {
            terminals: Arc::new(TerminalManager::default()),
            remote: RemoteHub::default(),
            settings: RwLock::new(settings),
            cache: RwLock::new(HashMap::new()),
            refresh_locks: [AgentKind::Codex, AgentKind::Command, AgentKind::Local]
                .into_iter()
                .map(|kind| (kind, Mutex::new(())))
                .collect(),
            settings_epoch: AtomicU64::new(0),
            catalog_updates: tokio::sync::broadcast::channel(64).0,
            codex_app: Mutex::new(None),
        })
    }

    pub fn start_cache(self: &Arc<Self>) {
        let runtime = self.clone();
        let mut changes = self.terminals.changes.subscribe();
        tokio::spawn(async move {
            loop {
                match changes.recv().await {
                    Ok(session) => {
                        let revision = {
                            let mut cache = runtime.cache.write().unwrap();
                            let entry = cache.entry(session.kind).or_default();
                            if let Some(row) =
                                entry.rows.iter_mut().find(|row| row.id == session.id)
                            {
                                row.status = session.status.clone();
                                row.updated_at = session.updated_at;
                            }
                            entry.revision += 1;
                            entry.revision
                        };
                        let _ = runtime.catalog_updates.send((session.kind, revision));
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        for kind in [AgentKind::Local, AgentKind::Codex, AgentKind::Command] {
                            runtime.catalog_changed(kind);
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let kind = AgentKind::Codex;
        let runtime = self.clone();
        tokio::spawn(async move {
            loop {
                if runtime.enabled(kind)
                    && let Err(error) = runtime.refresh_async(kind).await
                {
                    tracing::warn!(agent = kind.as_str(), %error, "session cache refresh failed");
                }
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        });
    }

    pub async fn refresh_async(self: &Arc<Self>, kind: AgentKind) -> Result<Vec<Session>> {
        let runtime = self.clone();
        tokio::task::spawn_blocking(move || runtime.refresh(kind)).await?
    }

    pub fn set_settings(&self, settings: AgentSettings) {
        {
            let mut current = self.settings.write().unwrap();
            if serde_json::to_value(&*current).ok() == serde_json::to_value(&settings).ok() {
                return;
            }
            *current = settings;
            self.settings_epoch.fetch_add(1, Ordering::SeqCst);
        }
        if let Some(mut app) = self.codex_app.lock().unwrap().take() {
            let _ = app.child.kill();
        }
    }
    pub fn settings(&self) -> AgentSettings {
        self.settings.read().unwrap().clone()
    }

    pub fn available(&self, kind: AgentKind) -> bool {
        if kind == AgentKind::Command {
            return self
                .settings()
                .command_configs
                .iter()
                .any(|config| resolve_binary(&config.program, &config.name).is_some());
        }
        self.binary(kind).is_ok()
    }
    pub fn refresh(&self, kind: AgentKind) -> Result<Vec<Session>> {
        if !self.enabled(kind) {
            return Err(anyhow!("Agent 已停用"));
        }
        if kind == AgentKind::Command {
            return Ok(self.catalog_state(kind).rows);
        }
        self.refresh_with(kind, || self.discover(kind))
    }
    fn refresh_with(
        &self,
        kind: AgentKind,
        discover: impl FnOnce() -> Result<Vec<Session>>,
    ) -> Result<Vec<Session>> {
        let completed = self.catalog_state(kind).completed;
        let _scan = self.refresh_locks[&kind].lock().unwrap();
        let previous = self.catalog_state(kind);
        if previous.completed != completed {
            return previous
                .error
                .map_or_else(|| Ok(previous.rows), |error| Err(anyhow!(error)));
        }
        let epoch = self.settings_epoch.load(Ordering::SeqCst);
        self.cache
            .write()
            .unwrap()
            .entry(kind)
            .or_default()
            .refreshing = true;
        let mut result = discover();
        if kind == AgentKind::Codex
            && result.is_err()
            && let Some(mut app) = self.codex_app.lock().unwrap().take()
        {
            let _ = app.child.kill();
        }
        let _settings = self.settings.read().unwrap();
        let mut cache = self.cache.write().unwrap();
        let entry = cache.entry(kind).or_default();
        entry.refreshing = false;
        entry.completed += 1;
        if epoch != self.settings_epoch.load(Ordering::SeqCst)
            || entry.revision != previous.revision
        {
            result = Err(anyhow!("配置或会话已变化，请重新同步"));
        }
        match &result {
            Ok(rows) => {
                entry.rows = rows.clone();
                entry.last_success_at = Some(Utc::now());
                entry.error = None;
            }
            Err(error) => entry.error = Some(error.to_string()),
        }
        entry.revision += 1;
        let revision = entry.revision;
        drop(cache);
        let _ = self.catalog_updates.send((kind, revision));
        result
    }
    pub fn enabled(&self, kind: AgentKind) -> bool {
        let settings = self.settings.read().unwrap();
        !settings.agent_toggles_set
            || match kind {
                AgentKind::Codex => settings.codex_enabled,
                AgentKind::Command => settings.command_enabled,
                AgentKind::Local => true,
            }
    }
    pub fn catalog_state(&self, kind: AgentKind) -> CatalogState {
        self.cache
            .read()
            .unwrap()
            .get(&kind)
            .cloned()
            .unwrap_or_default()
    }
    pub fn catalog_changed(&self, kind: AgentKind) {
        let revision = {
            let mut cache = self.cache.write().unwrap();
            let entry = cache.entry(kind).or_default();
            entry.revision += 1;
            entry.revision
        };
        let _ = self.catalog_updates.send((kind, revision));
    }
    pub fn update_catalog_session(&self, session: Session) {
        let kind = session.kind;
        let revision = {
            let mut cache = self.cache.write().unwrap();
            let entry = cache.entry(kind).or_default();
            entry.rows.retain(|row| row.id != session.id);
            entry.rows.insert(0, session);
            entry.revision += 1;
            entry.revision
        };
        let _ = self.catalog_updates.send((kind, revision));
    }
    pub fn remove_catalog_session(&self, kind: AgentKind, id: &str) {
        let revision = {
            let mut cache = self.cache.write().unwrap();
            let entry = cache.entry(kind).or_default();
            entry.rows.retain(|row| row.id != id);
            entry.revision += 1;
            entry.revision
        };
        let _ = self.catalog_updates.send((kind, revision));
    }
    pub fn cached(&self, kind: AgentKind) -> Result<Vec<Session>> {
        let state = self.catalog_state(kind);
        if state.last_success_at.is_some() || !state.rows.is_empty() {
            return Ok(state.rows);
        }
        Err(anyhow!(state.error.unwrap_or_else(|| format!(
            "session cache is not ready: {}",
            kind.as_str()
        ))))
    }
    pub fn session(&self, kind: AgentKind, id: &str) -> Result<Session> {
        if let Some(session) = self.terminals.session(id).filter(|s| s.kind == kind) {
            return Ok(session);
        }
        self.cached(kind)?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| anyhow!("session not found"))
    }

    pub fn discover(&self, kind: AgentKind) -> Result<Vec<Session>> {
        let native = match kind {
            AgentKind::Codex => self.codex_threads()?,
            AgentKind::Command | AgentKind::Local => vec![],
        };
        let live = self.terminals.sessions(kind);
        let mut out = merge_sessions(native, live.clone());
        for session in &out {
            if live.iter().any(|running| running.id == session.id) {
                self.terminals.update_session(session.clone());
            }
        }
        out.sort_by_key(|value| std::cmp::Reverse(value.updated_at));
        Ok(out)
    }

    pub fn start_local(&self, mut session: Session, profiles: &[String]) -> Result<()> {
        session.status = "running".into();
        let shell = self.shell();
        let paths = profile_paths(profiles);
        let init = r#"exec "$0" --rcfile <(for profile in "$@"; do [ -r "$profile" ] && printf '. %q\n' "$profile"; done) -i"#;
        let mut argv = vec![shell.clone(), "-c".into(), init.into(), shell];
        argv.extend(paths);
        self.start_terminal(session, argv, local_environment())
    }

    pub fn start_agent(&self, mut session: Session) -> Result<()> {
        let settings = self.settings();
        let (binary, mut args, vars) = match session.kind {
            AgentKind::Codex => {
                if !session.native_id.is_empty() && !self.codex_thread_exists(&session.native_id) {
                    session.native_id.clear();
                }
                let mut args = vec![];
                if !session.native_id.is_empty() {
                    args.extend(["resume".into(), session.native_id.clone()]);
                }
                if session.yolo {
                    args.push("--yolo".into());
                }
                args.extend(preferred_args(&session.launch_args, &settings.codex_args));
                (self.binary(AgentKind::Codex)?, args, settings.codex_env)
            }
            AgentKind::Command => {
                let config = settings
                    .command_configs
                    .iter()
                    .find(|config| config.id == session.agent_id)
                    .ok_or_else(|| anyhow!("启动配置不存在"))?;
                let mut args = config.args.clone();
                args.extend(session.launch_args.clone());
                (
                    resolve_binary(&config.program, &config.program)
                        .ok_or_else(|| anyhow!("启动程序不可用"))?,
                    args,
                    config.env.clone(),
                )
            }
            AgentKind::Local => return Err(anyhow!("invalid agent")),
        };
        let overrides = environment_overrides(&vars);
        let env = merge_environment(local_environment(), &overrides);
        let mut command = vec![binary.to_string_lossy().into_owned()];
        command.append(&mut args);
        let argv = command_with_profiles(
            &self.shell(),
            &profile_paths(&settings.local_profiles),
            &overrides,
            &command,
        );
        self.start_terminal(session, argv, env)
    }

    fn start_terminal(&self, session: Session, argv: Vec<String>, env: Vec<String>) -> Result<()> {
        self.terminals.start(TerminalSpec {
            cwd: session.workspace.clone(),
            label: session.kind,
            session,
            argv,
            env,
        })
    }

    pub fn restart_terminal(&self, id: &str) -> Result<()> {
        let session = self
            .terminals
            .session(id)
            .ok_or_else(|| anyhow!("terminal is not running"))?;
        self.terminals.stop(id)?;
        if session.kind == AgentKind::Local {
            self.start_local(session, &self.settings().local_profiles)
        } else {
            self.start_agent(session)
        }
    }

    pub fn delete_native(&self, session: &Session) -> Result<()> {
        if session.native_id.is_empty() || session.kind != AgentKind::Codex {
            return Ok(());
        }
        self.run_command(AgentKind::Codex, &["delete", "--force", &session.native_id])?;
        Ok(())
    }
    pub fn history(&self, _session: &Session) -> Result<Vec<Message>> {
        Ok(vec![])
    }

    pub fn codex_rate_limits(&self) -> Result<Value> {
        let mut guard = self.codex_app.lock().unwrap();
        if guard.is_none() {
            *guard = Some(self.new_app_server()?);
        }
        let result = guard
            .as_mut()
            .unwrap()
            .call("account/rateLimits/read", json!({}));
        if result.is_err()
            && let Some(mut app) = guard.take()
        {
            let _ = app.child.kill();
            let _ = app.child.wait();
        }
        result
    }

    fn codex_threads(&self) -> Result<Vec<Session>> {
        let mut app_guard = self.codex_app.lock().unwrap();
        if app_guard.is_none() {
            *app_guard = Some(self.new_app_server()?);
        }
        let app = app_guard.as_mut().unwrap();
        let mut cursor = String::new();
        let mut rows = vec![];
        loop {
            let result = app.call(
                "thread/list",
                if cursor.is_empty() {
                    json!({})
                } else {
                    json!({"cursor": cursor})
                },
            )?;
            let data = result
                .get("data")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for row in data {
                rows.push(codex_row(&row));
            }
            let next = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if next.is_empty() || next == cursor {
                break;
            }
            cursor = next;
        }
        Ok(rows)
    }
    fn codex_thread_exists(&self, id: &str) -> bool {
        let mut guard = self.codex_app.lock().unwrap();
        if guard.is_none() {
            *guard = self.new_app_server().ok();
        }
        guard.as_mut().is_some_and(|app| {
            app.call(
                "thread/read",
                json!({"threadId": id, "includeTurns": false}),
            )
            .is_ok()
        })
    }
    fn new_app_server(&self) -> Result<AppServer> {
        let settings = self.settings();
        let binary = self.binary(AgentKind::Codex)?;
        let overrides = environment_overrides(&settings.codex_env);
        let command = command_with_profiles(
            &self.shell(),
            &profile_paths(&settings.local_profiles),
            &overrides,
            &[
                binary.to_string_lossy().into_owned(),
                "app-server".into(),
                "--stdio".into(),
            ],
        );
        let mut cmd = Command::new(&command[0]);
        cmd.args(&command[1..]).env_clear();
        for item in merge_environment(local_environment(), &overrides) {
            if let Some((k, v)) = item.split_once('=') {
                cmd.env(k, v);
            }
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("codex app-server stdin unavailable"))?;
        let stdout = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| anyhow!("codex app-server stdout unavailable"))?,
        );
        let mut app = AppServer {
            child,
            stdin,
            stdout,
            next: 0,
            timeout: Duration::from_secs(30),
        };
        app.call(
            "initialize",
            json!({"clientInfo":{"name":"jian","version":env!("CARGO_PKG_VERSION")},"protocolVersion":"2"}),
        )?;
        Ok(app)
    }
    fn run_command(&self, kind: AgentKind, args: &[&str]) -> Result<Vec<u8>> {
        if kind != AgentKind::Codex {
            return Err(anyhow!("unsupported command"));
        }
        let settings = self.settings();
        let binary = self.binary(AgentKind::Codex)?;
        let overrides = environment_overrides(&settings.codex_env);
        let mut raw = vec![binary.to_string_lossy().into_owned()];
        raw.extend(args.iter().map(|value| (*value).to_string()));
        let command = command_with_profiles(
            &self.shell(),
            &profile_paths(&settings.local_profiles),
            &overrides,
            &raw,
        );
        let mut cmd = Command::new(&command[0]);
        cmd.args(&command[1..]).env_clear();
        for item in merge_environment(local_environment(), &overrides) {
            if let Some((key, value)) = item.split_once('=') {
                cmd.env(key, value);
            }
        }
        let output = cmd.output()?;
        if !output.status.success() {
            return Err(anyhow!("codex exited with {}", output.status));
        }
        Ok(output.stdout)
    }
    fn binary(&self, kind: AgentKind) -> Result<PathBuf> {
        let settings = self.settings();
        let value = match kind {
            AgentKind::Codex => settings.codex_bin,
            AgentKind::Command => settings
                .command_configs
                .first()
                .map(|config| config.program.clone())
                .unwrap_or_default(),
            AgentKind::Local => self.shell(),
        };
        resolve_binary(&value, kind.as_str())
            .ok_or_else(|| anyhow!("{} CLI unavailable", capitalize(kind.as_str())))
    }
    fn shell(&self) -> String {
        std::env::var("JIAN_BASH_BIN")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "/bin/bash".into())
    }
}

struct AppServer {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next: u64,
    timeout: Duration,
}
impl AppServer {
    fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next += 1;
        let id = self.next;
        serde_json::to_writer(
            &mut self.stdin,
            &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
        )?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;
        let deadline = Instant::now() + self.timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(anyhow!("Codex app-server request timed out"));
            }
            if self.stdout.buffer().is_empty() {
                let mut pollfd = libc::pollfd {
                    fd: self.stdout.get_ref().as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                let timeout = remaining.as_millis().min(i32::MAX as u128) as i32;
                let ready = unsafe { libc::poll(&mut pollfd, 1, timeout.max(1)) };
                if ready == 0 {
                    return Err(anyhow!("Codex app-server request timed out"));
                }
                if ready < 0 {
                    let error = std::io::Error::last_os_error();
                    if error.kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error.into());
                }
            }
            let mut line = String::new();
            if self.stdout.read_line(&mut line)? == 0 {
                return Err(anyhow!("Codex app-server exited"));
            }
            let value: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = value.get("error") {
                return Err(anyhow!(
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex app-server error")
                        .to_string()
                ));
            }
            return Ok(value.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

fn codex_row(row: &Value) -> Session {
    let native_id = string(row, "id");
    let mut title = string(row, "title");
    if title.is_empty() {
        title = string(row, "name");
    }
    if title.is_empty() {
        title = string(row, "preview");
        if title.chars().count() > 80 {
            title = format!("{}…", title.chars().take(80).collect::<String>());
        }
    }
    if title.is_empty() {
        title = "无标题".into();
    }
    Session {
        id: format!("native-{native_id}"),
        kind: AgentKind::Codex,
        native_id,
        host_id: String::new(),
        agent_id: String::new(),
        run_id: String::new(),
        src: String::new(),
        channel: String::new(),
        workspace: string(row, "cwd"),
        yolo: false,
        launch_args: vec![],
        title,
        status: "ended".into(),
        created_at: json_time(row.get("createdAt")),
        updated_at: json_time(row.get("updatedAt")),
    }
}
fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
fn json_time(value: Option<&Value>) -> DateTime<Utc> {
    value
        .and_then(Value::as_f64)
        .and_then(|v| Utc.timestamp_opt(v as i64, 0).single())
        .or_else(|| {
            value
                .and_then(Value::as_str)
                .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
                .map(|v| v.with_timezone(&Utc))
        })
        .unwrap_or_else(zero_time)
}
fn zero_time() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(1, 1, 1, 0, 0, 0).single().unwrap()
}
fn session_key(s: &Session) -> String {
    format!("{}:{}", s.kind.as_str(), s.native_id)
}
fn merge_sessions(mut native: Vec<Session>, live: Vec<Session>) -> Vec<Session> {
    let mut out = Vec::with_capacity(native.len() + live.len());
    for live in live {
        let matches = |found: &Session| {
            if !live.native_id.is_empty() {
                return session_key(found) == session_key(&live);
            }
            found.kind == live.kind
                && found.workspace == live.workspace
                && found.agent_id == live.agent_id
                && found.created_at + chrono::Duration::seconds(1) >= live.created_at
        };
        let candidates: Vec<_> = native
            .iter()
            .enumerate()
            .filter_map(|(index, found)| matches(found).then_some(index))
            .collect();
        if candidates.len() == 1 {
            let mut found = native.remove(candidates[0]);
            found.id = live.id;
            found.status = "running".into();
            found.yolo = live.yolo;
            found.launch_args = live.launch_args;
            out.push(found);
        } else {
            out.push(Session {
                status: "running".into(),
                ..live
            });
        }
    }
    out.extend(native);
    out
}
fn local_environment() -> Vec<String> {
    let mut env: Vec<_> = std::env::vars()
        .filter(|(k, _)| k != "TERM")
        .map(|(k, v)| format!("{k}={v}"))
        .collect();
    env.push("TERM=xterm-256color".into());
    env
}
fn environment_overrides(values: &[EnvVar]) -> Vec<String> {
    values
        .iter()
        .filter(|item| {
            !item.key.trim().is_empty()
                && !item.key.contains(['=', '\0'])
                && !item.value.contains('\0')
        })
        .map(|item| format!("{}={}", item.key.trim(), item.value))
        .collect()
}
fn merge_environment(mut base: Vec<String>, overrides: &[String]) -> Vec<String> {
    for item in overrides {
        if let Some((key, value)) = item.split_once('=') {
            set_env(&mut base, key, value);
        }
    }
    base
}
fn set_env(env: &mut Vec<String>, key: &str, value: &str) {
    let prefix = format!("{key}=");
    if let Some(item) = env.iter_mut().find(|v| v.starts_with(&prefix)) {
        *item = format!("{prefix}{value}");
    } else {
        env.push(format!("{prefix}{value}"));
    }
}
fn profile_paths(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|v| {
            let v = v.trim();
            if v == "~" {
                dirs_home()
            } else if let Some(rest) = v.strip_prefix("~/") {
                dirs_home().join(rest)
            } else if Path::new(v).is_absolute() {
                PathBuf::from(v)
            } else {
                dirs_home().join(v)
            }
        })
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

fn preferred_args(custom: &[String], defaults: &[String]) -> Vec<String> {
    if custom.is_empty() {
        defaults.to_vec()
    } else {
        custom.to_vec()
    }
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default()
}

fn resolve_binary(configured: &str, fallback: &str) -> Option<PathBuf> {
    if !configured.is_empty() {
        return std::fs::canonicalize(configured)
            .ok()
            .or_else(|| Some(PathBuf::from(configured)));
    }
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(fallback))
            .find(|candidate| candidate.is_file())
    })
}

fn command_with_profiles(
    shell: &str,
    profiles: &[String],
    environment: &[String],
    command: &[String],
) -> Vec<String> {
    const SCRIPT: &str = r#"profiles=(); while [ "$1" != "--" ]; do profiles+=("$1"); shift; done; shift; environment=(); while [ "$1" != "--" ]; do environment+=("$1"); shift; done; shift; exec "$0" --rcfile <(for profile in "${profiles[@]}"; do [ -r "$profile" ] && printf '. %q\n' "$profile"; done) -ic 'count=$1; shift; while (( count > 0 )); do export "$1"; shift; ((count--)); done; exec "$@"' jian-agent "${#environment[@]}" "${environment[@]}" "$@""#;
    let mut out = vec![
        shell.into(),
        "--noprofile".into(),
        "--norc".into(),
        "-c".into(),
        SCRIPT.into(),
        shell.into(),
    ];
    out.extend_from_slice(profiles);
    out.push("--".into());
    out.extend_from_slice(environment);
    out.push("--".into());
    out.extend_from_slice(command);
    out
}

#[cfg(test)]
mod tests {
    use std::{fs, os::unix::fs::PermissionsExt, thread, time::Instant};

    use super::*;

    #[test]
    fn generic_launcher_availability_checks_all_configured_programs() {
        let settings = AgentSettings {
            command_configs: vec![
                crate::model::CommandConfig {
                    id: "missing".into(),
                    name: "Missing".into(),
                    program: "/jian-test-missing-program".into(),
                    args: vec![],
                    env: vec![],
                },
                crate::model::CommandConfig {
                    id: "available".into(),
                    name: "Available".into(),
                    program: std::env::current_exe()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    args: vec![],
                    env: vec![],
                },
            ],
            ..AgentSettings::default()
        };
        let runtime = Runtime::new(settings);

        assert!(runtime.available(AgentKind::Command));
    }

    #[test]
    fn catalog_keeps_last_success_when_discovery_fails() {
        let runtime = Runtime::new(AgentSettings::default());
        let row = Session::new(AgentKind::Command, "/work".into(), "Saved".into());
        runtime
            .refresh_with(AgentKind::Command, || Ok(vec![row.clone()]))
            .unwrap();
        let successful = runtime.catalog_state(AgentKind::Command);
        assert!(
            runtime
                .refresh_with(AgentKind::Command, || Err(anyhow!("offline")))
                .is_err()
        );
        let failed = runtime.catalog_state(AgentKind::Command);
        assert_eq!(failed.rows[0].id, row.id);
        assert_eq!(failed.last_success_at, successful.last_success_at);
        assert!(failed.revision > successful.revision);
        assert!(!failed.refreshing);
        assert_eq!(failed.error.as_deref(), Some("offline"));
    }

    #[test]
    fn catalog_coalesces_waiting_refreshes_and_invalidates_changed_settings() {
        let runtime = Runtime::new(AgentSettings::default());
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let first_runtime = runtime.clone();
        let first = thread::spawn(move || {
            first_runtime.refresh_with(AgentKind::Command, || {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(vec![])
            })
        });
        entered_rx.recv().unwrap();
        let second_runtime = runtime.clone();
        let second = thread::spawn(move || {
            second_runtime.refresh_with(AgentKind::Command, || panic!("duplicate native discovery"))
        });
        thread::sleep(Duration::from_millis(30));
        release_tx.send(()).unwrap();
        first.join().unwrap().unwrap();
        second.join().unwrap().unwrap();
        assert_eq!(runtime.catalog_state(AgentKind::Command).completed, 1);
        assert!(
            runtime
                .refresh_with(AgentKind::Command, || {
                    let mut settings = runtime.settings();
                    settings.command_enabled = false;
                    runtime.set_settings(settings);
                    Ok(vec![])
                })
                .is_err()
        );
        assert!(!runtime.catalog_state(AgentKind::Command).refreshing);
    }

    #[test]
    fn catalog_does_not_replace_a_mutation_with_an_old_scan() {
        let runtime = Runtime::new(AgentSettings::default());
        let row = Session::new(AgentKind::Command, "/work".into(), "New".into());
        let mut updates = runtime.catalog_updates.subscribe();
        assert!(
            runtime
                .refresh_with(AgentKind::Command, || {
                    runtime.update_catalog_session(row.clone());
                    Ok(vec![])
                })
                .is_err()
        );
        let result = runtime.catalog_state(AgentKind::Command);
        assert_eq!(result.rows[0].id, row.id);
        assert!(!result.refreshing);
        assert!(result.error.is_some());
        assert!(updates.try_recv().is_ok());
        assert_eq!(updates.try_recv().unwrap().1, result.revision);
    }

    #[test]
    fn codex_rate_limits_preserves_all_fields_and_recovers_after_error() {
        let runtime = Runtime::new(AgentSettings::default());
        let expected = json!({
            "rateLimits": {"primary": {"usedPercent": 75, "windowDurationMins": 300}},
            "rateLimitsByLimitId": {"codex": {"planType": "pro"}},
            "rateLimitResetCredits": {"availableCount": 3, "credits": []},
            "futureField": {"untouched": true}
        });
        let reply = json!({"id": 1, "result": expected}).to_string();
        let mut child = Command::new("/bin/sh")
            .args(["-c", r#"read request; case "$request" in *account/rateLimits/read*) printf '%s\n' "$1";; *) exit 1;; esac; read request; printf '%s\n' '{"id":2,"error":{"message":"quota unavailable"}}'"#, "quota-fixture", &reply])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        *runtime.codex_app.lock().unwrap() = Some(AppServer {
            child,
            stdin,
            stdout,
            next: 0,
            timeout: Duration::from_secs(2),
        });
        assert_eq!(runtime.codex_rate_limits().unwrap(), expected);
        assert!(
            runtime
                .codex_rate_limits()
                .unwrap_err()
                .to_string()
                .contains("quota unavailable")
        );
        assert!(runtime.codex_app.lock().unwrap().is_none());
    }

    #[test]
    fn app_server_call_times_out_when_codex_stops_replying() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "read request; sleep 2"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let mut app = AppServer {
            child,
            stdin,
            stdout,
            next: 0,
            timeout: Duration::from_millis(100),
        };

        let started = Instant::now();
        let error = app.call("thread/list", json!({})).unwrap_err();

        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(error.to_string().contains("timed out"), "{error:#}");
    }

    #[test]
    fn discovered_native_session_replaces_its_unbound_terminal_session() {
        let live = Session::new(AgentKind::Codex, "/work".into(), "无标题".into());
        let mut native = live.clone();
        native.id = "native-thread-1".into();
        native.native_id = "thread-1".into();
        native.title = "默认标题".into();
        native.created_at += chrono::Duration::seconds(1);

        let sessions = merge_sessions(vec![native], vec![live.clone()]);

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, live.id);
        assert_eq!(sessions[0].native_id, "thread-1");
        assert_eq!(sessions[0].title, "默认标题");
    }

    #[test]
    fn custom_launch_arguments_override_defaults() {
        assert_eq!(preferred_args(&[], &["default".into()]), ["default"]);
        assert_eq!(
            preferred_args(&["custom".into()], &["default".into()]),
            ["custom"]
        );
    }

    #[test]
    fn codex_settings_environment_wins_over_local_profiles() {
        let root = std::env::temp_dir().join(format!("jian-codex-env-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let profile = root.join("profile");
        fs::write(&profile, "export JIAN_TEST_CODEX_ENV=profile\n").unwrap();
        let codex = root.join("codex");
        fs::write(
            &codex,
            "#!/bin/sh\nprintf 'codex-env=%s\\n' \"$JIAN_TEST_CODEX_ENV\"\nsleep 2\n",
        )
        .unwrap();
        fs::set_permissions(&codex, fs::Permissions::from_mode(0o700)).unwrap();

        let settings = AgentSettings {
            codex_bin: codex.to_string_lossy().into_owned(),
            local_profiles: vec![profile.to_string_lossy().into_owned()],
            codex_env: vec![EnvVar {
                key: "JIAN_TEST_CODEX_ENV".into(),
                value: "settings".into(),
            }],
            ..AgentSettings::default()
        };
        let runtime = Runtime::new(settings);
        let session = Session::new(
            AgentKind::Codex,
            root.to_string_lossy().into_owned(),
            "test".into(),
        );
        runtime.start_agent(session.clone()).unwrap();
        thread::sleep(Duration::from_millis(150));
        let output = runtime.terminals.subscribe(&session.id).unwrap().0;
        assert!(
            String::from_utf8_lossy(&output).contains("codex-env=settings"),
            "{}",
            String::from_utf8_lossy(&output)
        );
        let mut updated = runtime.settings();
        updated.codex_env[0].value = "restarted".into();
        runtime.set_settings(updated);
        runtime.restart_terminal(&session.id).unwrap();
        thread::sleep(Duration::from_millis(150));
        let output = runtime.terminals.subscribe(&session.id).unwrap().0;
        assert!(
            String::from_utf8_lossy(&output).contains("codex-env=restarted"),
            "{}",
            String::from_utf8_lossy(&output)
        );
        runtime.terminals.stop(&session.id).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
