use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

use anyhow::{Result, anyhow};
use chrono::{DateTime, TimeZone, Utc};
use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    model::{AgentKind, AgentSettings, EnvVar, Message, Session},
    store::dirs_home,
    terminal::{TerminalManager, TerminalSpec},
};

pub struct Runtime {
    pub terminals: Arc<TerminalManager>,
    settings: RwLock<AgentSettings>,
    cache: RwLock<HashMap<AgentKind, std::result::Result<Vec<Session>, String>>>,
    codex_app: Mutex<Option<AppServer>>,
}

impl Runtime {
    pub fn new(settings: AgentSettings) -> Arc<Self> {
        Arc::new(Self {
            terminals: Arc::new(TerminalManager::default()),
            settings: RwLock::new(settings),
            cache: RwLock::new(HashMap::new()),
            codex_app: Mutex::new(None),
        })
    }

    pub fn start_cache(self: &Arc<Self>) {
        for kind in [AgentKind::Codex, AgentKind::Hermes] {
            let runtime = self.clone();
            tokio::spawn(async move {
                loop {
                    if let Err(error) = runtime.refresh_async(kind).await {
                        tracing::warn!(agent = kind.as_str(), %error, "session cache refresh failed");
                    }
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
            });
        }
    }

    pub async fn refresh_async(self: &Arc<Self>, kind: AgentKind) -> Result<Vec<Session>> {
        let runtime = self.clone();
        tokio::task::spawn_blocking(move || runtime.refresh(kind)).await?
    }

    pub fn set_settings(&self, settings: AgentSettings) {
        *self.settings.write().unwrap() = settings;
        if let Some(mut app) = self.codex_app.lock().unwrap().take() {
            let _ = app.child.kill();
        }
    }
    pub fn settings(&self) -> AgentSettings {
        self.settings.read().unwrap().clone()
    }

    pub fn available(&self, kind: AgentKind) -> bool {
        self.binary(kind).is_ok()
    }
    pub fn refresh(&self, kind: AgentKind) -> Result<Vec<Session>> {
        let result = self.discover(kind);
        if kind == AgentKind::Codex
            && result.is_err()
            && let Some(mut app) = self.codex_app.lock().unwrap().take()
        {
            let _ = app.child.kill();
        }
        self.cache.write().unwrap().insert(
            kind,
            result
                .as_ref()
                .map(|v| v.clone())
                .map_err(ToString::to_string),
        );
        result
    }
    pub fn cached(&self, kind: AgentKind) -> Result<Vec<Session>> {
        match self.cache.read().unwrap().get(&kind) {
            Some(Ok(v)) => Ok(v.clone()),
            Some(Err(e)) => Err(anyhow!(e.clone())),
            None => Err(anyhow!("session cache is not ready: {}", kind.as_str())),
        }
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
            AgentKind::Hermes => self.hermes_sessions()?,
            AgentKind::Local => vec![],
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
        let binary = self.binary(session.kind)?;
        let mut overrides = match session.kind {
            AgentKind::Codex => environment_overrides(&settings.codex_env),
            AgentKind::Hermes => environment_overrides(&settings.hermes_env),
            AgentKind::Local => return Err(anyhow!("invalid agent")),
        };
        if session.kind == AgentKind::Hermes {
            if !settings.hermes_home.is_empty() {
                overrides.push(format!("HERMES_HOME={}", settings.hermes_home));
            }
            overrides.push("HERMES_TUI_BACKGROUND=#0d1117".into());
        }
        let args = match session.kind {
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
                args
            }
            AgentKind::Hermes => {
                session.profile = normalize_profile(&session.profile);
                let mut args = vec!["-p".into(), session.profile.clone(), "--cli".into()];
                if !session.native_id.is_empty() {
                    args.extend(["--resume".into(), session.native_id.clone()]);
                }
                args.extend(if session.id.starts_with("native") {
                    preferred_args(&session.launch_args, &settings.hermes_args)
                } else {
                    session.launch_args.clone()
                });
                args
            }
            AgentKind::Local => return Err(anyhow!("invalid agent")),
        };
        let env = merge_environment(local_environment(), &overrides);
        let mut command = vec![binary.to_string_lossy().into_owned()];
        command.extend(args);
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

    pub fn profiles(&self) -> Vec<String> {
        let settings = self.settings();
        if !settings.hermes_profiles.is_empty() {
            return unique(settings.hermes_profiles);
        }
        self.available_profiles()
    }
    pub fn available_profiles(&self) -> Vec<String> {
        let settings = self.settings();
        let root = if settings.hermes_home.is_empty() {
            std::env::var_os("JIAN_HERMES_HOME")
                .or_else(|| std::env::var_os("HERMES_HOME"))
                .map(PathBuf::from)
                .unwrap_or_else(|| dirs_home().join(".hermes"))
        } else {
            PathBuf::from(settings.hermes_home)
        };
        let mut out = vec!["default".into()];
        if let Ok(entries) = std::fs::read_dir(root.join("profiles")) {
            for entry in entries
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !out.contains(&name) {
                    out.push(name);
                }
            }
        }
        out
    }

    pub fn rename_hermes(&self, session: &Session, title: &str) -> Result<()> {
        self.run_hermes(&[
            "-p",
            &normalize_profile(&session.profile),
            "sessions",
            "rename",
            &session.native_id,
            title,
        ])
        .map(|_| ())
    }
    pub fn delete_native(&self, session: &Session) -> Result<()> {
        if session.native_id.is_empty() {
            return Ok(());
        }
        match session.kind {
            AgentKind::Codex => {
                self.run_command(AgentKind::Codex, &["delete", "--force", &session.native_id])?;
            }
            AgentKind::Hermes => {
                self.run_hermes(&[
                    "-p",
                    &normalize_profile(&session.profile),
                    "sessions",
                    "delete",
                    &session.native_id,
                ])?;
            }
            AgentKind::Local => {}
        }
        Ok(())
    }
    pub fn history(&self, session: &Session) -> Result<Vec<Message>> {
        if session.kind == AgentKind::Codex {
            return Ok(vec![]);
        }
        let out = self.run_hermes(&[
            "-p",
            &normalize_profile(&session.profile),
            "sessions",
            "export",
            "-",
            "--format",
            "jsonl",
            "--session-id",
            &session.native_id,
            "--redact",
        ])?;
        #[derive(Deserialize)]
        struct Row {
            role: String,
            content: String,
            timestamp: DateTime<Utc>,
        }
        Ok(String::from_utf8_lossy(&out)
            .lines()
            .filter_map(|line| serde_json::from_str::<Row>(line).ok())
            .filter(|r| !r.content.is_empty())
            .map(|r| Message {
                role: r.role,
                content: r.content,
                created_at: r.timestamp,
            })
            .collect())
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
        };
        app.call(
            "initialize",
            json!({"clientInfo":{"name":"jian","version":env!("CARGO_PKG_VERSION")},"protocolVersion":"2"}),
        )?;
        Ok(app)
    }
    fn hermes_sessions(&self) -> Result<Vec<Session>> {
        let mut all = vec![];
        for profile in self.profiles() {
            all.extend(self.hermes_sessions_for(&profile)?);
        }
        Ok(all)
    }
    fn hermes_sessions_for(&self, profile: &str) -> Result<Vec<Session>> {
        let out = self.run_hermes(&["-p", profile, "sessions", "list"])?;
        let columns = Regex::new(r"\s{2,}").unwrap();
        let id_re = Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_-]*$").unwrap();
        let mut rows = vec![];
        for line in String::from_utf8_lossy(&out).lines().map(str::trim) {
            if line.is_empty()
                || line.starts_with("Title")
                || line.starts_with("ID")
                || line.starts_with('-')
                || line.starts_with('─')
            {
                continue;
            }
            let parts: Vec<_> = columns.split(line).collect();
            if parts.len() < 4 {
                continue;
            }
            let native_id = parts.last().unwrap().to_string();
            if !id_re.is_match(&native_id) {
                continue;
            }
            let title = if parts[0].is_empty() || ["—", "-"].contains(&parts[0]) {
                "无标题"
            } else {
                parts[0]
            }
            .to_string();
            let timestamp = legacy_time(&native_id);
            let workspace = if Path::new(parts[1]).is_dir() {
                parts[1].to_string()
            } else {
                String::new()
            };
            rows.push(Session {
                id: format!("native:{profile}:{native_id}"),
                kind: AgentKind::Hermes,
                native_id,
                profile: profile.into(),
                src: "cli".into(),
                channel: "cli".into(),
                workspace,
                yolo: false,
                launch_args: vec![],
                title,
                status: "idle".into(),
                created_at: timestamp,
                updated_at: timestamp,
            });
        }
        Ok(rows)
    }
    fn run_hermes(&self, args: &[&str]) -> Result<Vec<u8>> {
        self.run_command(AgentKind::Hermes, args)
    }
    fn run_command(&self, kind: AgentKind, args: &[&str]) -> Result<Vec<u8>> {
        let settings = self.settings();
        let binary = self.binary(kind)?;
        let mut raw = vec![binary.to_string_lossy().into_owned()];
        raw.extend(args.iter().map(|v| (*v).to_string()));
        let vars = match kind {
            AgentKind::Codex => &settings.codex_env,
            AgentKind::Hermes => &settings.hermes_env,
            AgentKind::Local => unreachable!(),
        };
        let mut overrides = environment_overrides(vars);
        if kind == AgentKind::Hermes && !settings.hermes_home.is_empty() {
            overrides.push(format!("HERMES_HOME={}", settings.hermes_home));
        }
        let command = command_with_profiles(
            &self.shell(),
            &profile_paths(&settings.local_profiles),
            &overrides,
            &raw,
        );
        let env = merge_environment(local_environment(), &overrides);
        let mut cmd = Command::new(&command[0]);
        cmd.args(&command[1..]).env_clear();
        for item in env {
            if let Some((k, v)) = item.split_once('=') {
                cmd.env(k, v);
            }
        }
        let output = cmd.output()?;
        if !output.status.success() {
            return Err(anyhow!("{} exited with {}", kind.as_str(), output.status));
        }
        Ok(output.stdout)
    }
    fn binary(&self, kind: AgentKind) -> Result<PathBuf> {
        let settings = self.settings();
        let value = match kind {
            AgentKind::Codex => settings.codex_bin,
            AgentKind::Hermes => settings.hermes_bin,
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
        loop {
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
        profile: String::new(),
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
fn legacy_time(id: &str) -> DateTime<Utc> {
    id.get(..15)
        .and_then(|v| chrono::NaiveDateTime::parse_from_str(v, "%Y%m%d_%H%M%S").ok())
        .and_then(|value| chrono::Local.from_local_datetime(&value).single())
        .map(|value| value.with_timezone(&Utc))
        .unwrap_or_else(zero_time)
}
fn zero_time() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(1, 1, 1, 0, 0, 0).single().unwrap()
}
fn session_key(s: &Session) -> String {
    format!("{}:{}:{}", s.kind.as_str(), s.profile, s.native_id)
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
                && normalize_profile(&found.profile) == normalize_profile(&live.profile)
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
fn normalize_profile(value: &str) -> String {
    if value.trim().is_empty() {
        "default".into()
    } else {
        value.trim().into()
    }
}
fn unique(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty() && seen.insert(v.clone()))
        .collect()
}
fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    chars
        .next()
        .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
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
            .map(|dir| dir.join(fallback))
            .find(|p| p.is_file())
    })
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
    use std::{fs, os::unix::fs::PermissionsExt, thread};

    use super::*;

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
