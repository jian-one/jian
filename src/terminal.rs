use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    io::{Read, Write},
    sync::{Arc, Mutex, RwLock},
};

use anyhow::{Result, anyhow};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use serde_json::json;
use tokio::sync::broadcast;

use crate::model::{AgentKind, Event, Session};

const MAX_BUFFER: usize = 1024 * 1024;
const MAX_TERMINAL_DIMENSION: u16 = 4096;

#[derive(Clone)]
pub struct TerminalSpec {
    pub session: Session,
    pub label: AgentKind,
    pub cwd: String,
    pub argv: Vec<String>,
    pub env: Vec<String>,
}

#[derive(Serialize)]
pub struct TerminalStatus {
    id: String,
    label: AgentKind,
    title: String,
    workspace: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    profile: String,
    running: bool,
    busy: bool,
    subscribers: usize,
}

struct Terminal {
    spec: TerminalSpec,
    session: RwLock<Session>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    state: Mutex<TerminalState>,
    events: broadcast::Sender<Event>,
}

struct TerminalState {
    buffer: Vec<u8>,
    seq: u64,
    running: bool,
    subscribers: usize,
}

#[derive(Default)]
pub struct TerminalManager {
    active: RwLock<HashMap<String, Arc<Terminal>>>,
}

impl TerminalManager {
    pub fn start(self: &Arc<Self>, spec: TerminalSpec) -> Result<()> {
        if spec.session.id.is_empty() || spec.argv.first().is_none_or(String::is_empty) {
            return Err(anyhow!("terminal command is required"));
        }
        if self.running(&spec.session.id) {
            return Ok(());
        }
        let pair = native_pty_system().openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let argv: Vec<OsString> = spec.argv.iter().map(OsString::from).collect();
        let mut command = CommandBuilder::from_argv(argv);
        command.cwd(&spec.cwd);
        command.env_clear();
        for item in &spec.env {
            if let Some((key, value)) = item.split_once('=') {
                command.env(key, value);
            }
        }
        let child = pair.slave.spawn_command(command)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let (events, _) = broadcast::channel(128);
        let id = spec.session.id.clone();
        let terminal = Arc::new(Terminal {
            session: RwLock::new(spec.session.clone()),
            spec,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            state: Mutex::new(TerminalState {
                buffer: vec![],
                seq: 0,
                running: true,
                subscribers: 0,
            }),
            events,
        });
        self.active
            .write()
            .unwrap()
            .insert(id.clone(), terminal.clone());
        let manager = Arc::downgrade(self);
        std::thread::spawn(move || {
            let mut chunk = [0_u8; 4096];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        terminal.publish("pty.output", json!(String::from_utf8_lossy(&chunk[..n])))
                    }
                }
            }
            terminal.publish("pty.exit", json!("terminal exited"));
            terminal.state.lock().unwrap().running = false;
            let _ = terminal.child.lock().unwrap().wait();
            if let Some(manager) = manager.upgrade() {
                manager.active.write().unwrap().remove(&id);
            }
        });
        Ok(())
    }

    pub fn subscribe(
        &self,
        id: &str,
    ) -> Result<(Vec<u8>, broadcast::Receiver<Event>, Arc<SubscriberGuard>)> {
        let terminal = self.lookup(id)?;
        let mut state = terminal.state.lock().unwrap();
        state.subscribers += 1;
        let guard = Arc::new(SubscriberGuard {
            terminal: terminal.clone(),
        });
        Ok((state.buffer.clone(), terminal.events.subscribe(), guard))
    }

    pub fn send(&self, id: &str, input: &str) -> Result<()> {
        if input.len() > 64 * 1024 {
            return Err(anyhow!("terminal input is too large"));
        }
        let terminal = self.lookup(id)?;
        if !terminal.state.lock().unwrap().running {
            return Err(anyhow!("terminal is not running"));
        }
        terminal
            .writer
            .lock()
            .unwrap()
            .write_all(input.as_bytes())?;
        terminal.writer.lock().unwrap().flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        if cols == 0 || rows == 0 || cols > MAX_TERMINAL_DIMENSION || rows > MAX_TERMINAL_DIMENSION
        {
            return Err(anyhow!(
                "terminal size must be between 1 and {MAX_TERMINAL_DIMENSION}"
            ));
        }
        self.lookup(id)?.master.lock().unwrap().resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn stop(&self, id: &str) -> Result<()> {
        let Some(terminal) = self.active.read().unwrap().get(id).cloned() else {
            return Ok(());
        };
        terminal.state.lock().unwrap().running = false;
        if let Some(pid) = terminal.child.lock().unwrap().process_id() {
            let descendants = descendants_of(pid as i32);
            // portable-pty creates a new Unix session, so its pid is also the process group id.
            let rc = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
            if rc != 0 {
                terminal.child.lock().unwrap().kill()?;
            }
            for descendant in descendants {
                unsafe { libc::kill(descendant, libc::SIGKILL) };
            }
        } else {
            terminal.child.lock().unwrap().kill()?;
        }
        self.active.write().unwrap().remove(id);
        Ok(())
    }

    pub fn stop_all(&self) -> Result<()> {
        let ids: Vec<String> = self.active.read().unwrap().keys().cloned().collect();
        let mut first_error = None;
        for id in ids {
            if let Err(error) = self.stop(&id) {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    pub fn running(&self, id: &str) -> bool {
        self.active
            .read()
            .unwrap()
            .get(id)
            .is_some_and(|t| t.state.lock().unwrap().running)
    }
    pub fn session(&self, id: &str) -> Option<Session> {
        self.active
            .read()
            .unwrap()
            .get(id)
            .filter(|t| t.state.lock().unwrap().running)
            .map(|t| t.session.read().unwrap().clone())
    }
    pub fn sessions(&self, label: AgentKind) -> Vec<Session> {
        self.active
            .read()
            .unwrap()
            .values()
            .filter(|t| t.spec.label == label && t.state.lock().unwrap().running)
            .map(|t| t.session.read().unwrap().clone())
            .collect()
    }
    pub fn update_session(&self, session: Session) {
        if let Some(terminal) = self.active.read().unwrap().get(&session.id) {
            *terminal.session.write().unwrap() = session;
        }
    }
    pub fn status(&self) -> Vec<TerminalStatus> {
        let mut out: Vec<_> = self
            .active
            .read()
            .unwrap()
            .values()
            .map(|t| {
                let state = t.state.lock().unwrap();
                let session = t.session.read().unwrap();
                TerminalStatus {
                    id: session.id.clone(),
                    label: t.spec.label,
                    title: session.title.clone(),
                    workspace: session.workspace.clone(),
                    profile: session.profile.clone(),
                    running: state.running,
                    busy: t.spec.label != AgentKind::Local,
                    subscribers: state.subscribers,
                }
            })
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }
    fn lookup(&self, id: &str) -> Result<Arc<Terminal>> {
        self.active
            .read()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("terminal is not running"))
    }
}

fn descendants_of(root: i32) -> Vec<i32> {
    let mut children = HashMap::<i32, Vec<i32>>::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return vec![];
    };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some((_, fields)) = stat.rsplit_once(')') else {
            continue;
        };
        let mut fields = fields.split_whitespace();
        let _ = fields.next();
        let Some(Ok(parent)) = fields.next().map(str::parse::<i32>) else {
            continue;
        };
        children.entry(parent).or_default().push(pid);
    }
    let mut descendants = children.remove(&root).unwrap_or_default();
    let mut seen = HashSet::from([root]);
    seen.extend(descendants.iter().copied());
    let mut index = 0;
    while let Some(&pid) = descendants.get(index) {
        index += 1;
        for child in children.remove(&pid).into_iter().flatten() {
            if seen.insert(child) {
                descendants.push(child);
            }
        }
    }
    descendants
}

impl Terminal {
    fn publish(&self, kind: &str, payload: serde_json::Value) {
        let mut state = self.state.lock().unwrap();
        state.seq += 1;
        if kind == "pty.output"
            && let Some(value) = payload.as_str()
        {
            state.buffer.extend_from_slice(value.as_bytes());
            if state.buffer.len() > MAX_BUFFER {
                let excess = state.buffer.len() - MAX_BUFFER;
                state.buffer.drain(..excess);
            }
        }
        let _ = self.events.send(Event {
            session_id: self.spec.session.id.clone(),
            seq: state.seq,
            kind: kind.into(),
            payload,
        });
    }
}

pub struct SubscriberGuard {
    terminal: Arc<Terminal>,
}
impl Drop for SubscriberGuard {
    fn drop(&mut self) {
        let mut state = self.terminal.state.lock().unwrap();
        state.subscribers = state.subscribers.saturating_sub(1);
    }
}
impl Drop for TerminalManager {
    fn drop(&mut self) {
        let ids: Vec<_> = self.active.get_mut().unwrap().keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn starts_replays_and_stops() {
        let manager = Arc::new(TerminalManager::default());
        let session = Session::new(AgentKind::Local, "/tmp".into(), "Bash".into());
        manager
            .start(TerminalSpec {
                session: session.clone(),
                label: AgentKind::Local,
                cwd: "/tmp".into(),
                argv: vec![
                    "/bin/bash".into(),
                    "-c".into(),
                    "printf ready; sleep 2".into(),
                ],
                env: std::env::vars().map(|(k, v)| format!("{k}={v}")).collect(),
            })
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(
            String::from_utf8_lossy(&manager.subscribe(&session.id).unwrap().0).contains("ready")
        );
        manager.stop(&session.id).unwrap();
    }

    #[test]
    fn stopping_missing_terminal_is_idempotent() {
        TerminalManager::default().stop("already-gone").unwrap();
    }

    #[test]
    fn stop_kills_detached_descendants() {
        let manager = Arc::new(TerminalManager::default());
        let session = Session::new(AgentKind::Codex, "/tmp".into(), "Codex".into());
        let pid_file =
            std::env::temp_dir().join(format!("jian-terminal-{}.pid", uuid::Uuid::new_v4()));
        manager
            .start(TerminalSpec {
                session: session.clone(),
                label: AgentKind::Codex,
                cwd: "/tmp".into(),
                argv: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    format!(
                        "setsid /bin/sh -c 'echo $$ > {}; exec sleep 30' & wait",
                        pid_file.display()
                    ),
                ],
                env: std::env::vars().map(|(k, v)| format!("{k}={v}")).collect(),
            })
            .unwrap();
        for _ in 0..100 {
            if pid_file.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let pid = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        manager.stop(&session.id).unwrap();
        let mut alive = true;
        for _ in 0..100 {
            alive = std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
                stat.rsplit_once(')')
                    .and_then(|(_, fields)| fields.split_whitespace().next())
                    != Some("Z")
            });
            if !alive {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if alive {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        let _ = std::fs::remove_file(pid_file);
        assert!(
            !alive,
            "detached descendant {pid} survived terminal release"
        );
    }

    #[test]
    fn rejects_invalid_terminal_sizes() {
        let manager = TerminalManager::default();
        assert!(manager.resize("missing", 0, 24).is_err());
        assert!(manager.resize("missing", 80, 0).is_err());
        assert!(
            manager
                .resize("missing", MAX_TERMINAL_DIMENSION + 1, 24)
                .is_err()
        );
    }
}
