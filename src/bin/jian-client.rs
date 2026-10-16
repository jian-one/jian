use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};

use anyhow::{Context, Result, anyhow};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::{Value, json};
use tokio::{sync::mpsc, time::sleep};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

const MAX_BUFFER: usize = 1024 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug)]
struct PermanentConnectionError(u16);

impl std::fmt::Display for PermanentConnectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "server rejected this client (HTTP {})", self.0)
    }
}

impl std::error::Error for PermanentConnectionError {}

#[derive(Default)]
struct OutputState {
    buffer: VecDeque<u8>,
    seq: u64,
}

struct ClientTerminal {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    output: Mutex<OutputState>,
    run_id: String,
    running: std::sync::atomic::AtomicBool,
}

impl ClientTerminal {
    fn spawn(
        program: &str,
        args: &[String],
        cwd: &str,
        env: &Value,
        run_id: &str,
    ) -> Result<Arc<Self>> {
        if program.trim().is_empty() {
            return Err(anyhow!("remote program is empty"));
        }
        let pair = native_pty_system().openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut command = CommandBuilder::new(program);
        command.args(args);
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
        command.cwd(expand_home_path(
            cwd,
            home.as_deref().map(std::path::Path::new),
        ));
        if let Some(values) = env.as_object() {
            for (key, value) in values {
                if let Some(value) = value.as_str() {
                    command.env(key, value);
                }
            }
        }
        let child = pair.slave.spawn_command(command)?;
        drop(pair.slave);
        let terminal = Arc::new(Self {
            writer: Mutex::new(pair.master.take_writer()?),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            output: Mutex::new(OutputState::default()),
            run_id: run_id.to_owned(),
            running: std::sync::atomic::AtomicBool::new(true),
        });
        Ok(terminal)
    }

    fn replay(&self, session_id: &str, attach_id: &str, outgoing: &mpsc::Sender<String>) {
        let output = self.output.lock().unwrap();
        let snapshot = output.buffer.iter().copied().collect::<Vec<_>>();
        let seq = output.seq;
        let running = self.running.load(Ordering::SeqCst);
        if !snapshot.is_empty() {
            let _ = outgoing.try_send(json!({"session_id":session_id,"run_id":self.run_id,"attach_id":attach_id,"seq":seq,"type":"pty.output","payload":String::from_utf8_lossy(&snapshot)}).to_string());
        }
        let _ = outgoing.try_send(json!({"session_id":session_id,"run_id":self.run_id,"attach_id":attach_id,"seq":seq,"type":"session.replay.complete","payload":{}}).to_string());
        let _ = outgoing.try_send(json!({"session_id":session_id,"run_id":self.run_id,"attach_id":attach_id,"seq":seq,"type":"session.started","payload":{"running":running}}).to_string());
    }

    fn record_output(&self, bytes: &[u8]) -> u64 {
        let mut output = self.output.lock().unwrap();
        output.seq += 1;
        if bytes.len() >= MAX_BUFFER {
            output.buffer.clear();
            output
                .buffer
                .extend(bytes[bytes.len() - MAX_BUFFER..].iter().copied());
        } else {
            output.buffer.extend(bytes.iter().copied());
            while output.buffer.len() > MAX_BUFFER {
                output.buffer.pop_front();
            }
        }
        output.seq
    }

    fn running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    fn write(&self, data: &str) -> Result<()> {
        let mut writer = self.writer.lock().unwrap();
        writer.write_all(data.as_bytes())?;
        writer.flush()?;
        Ok(())
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        if cols == 0 || rows == 0 || cols > 4096 || rows > 4096 {
            return Err(anyhow!("invalid terminal size"));
        }
        self.master.lock().unwrap().resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    fn stop(&self) {
        let mut child = self.child.lock().unwrap();
        #[cfg(unix)]
        if let Some(pid) = child.process_id().and_then(|pid| i32::try_from(pid).ok()) {
            // portable-pty starts commands in a new session on Unix; its process
            // group contains the shell and every agent child started from it.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        self.running.store(false, Ordering::SeqCst);
    }
}

fn decode_output(pending: &mut Vec<u8>, bytes: &[u8], flush: bool) -> String {
    pending.extend_from_slice(bytes);
    let mut output = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                output.push_str(text);
                pending.clear();
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                output.push_str(std::str::from_utf8(&pending[..valid]).unwrap_or_default());
                if let Some(length) = error.error_len() {
                    output.push_str(&String::from_utf8_lossy(&pending[valid..valid + length]));
                    pending.drain(..valid + length);
                } else if flush {
                    output.push_str(&String::from_utf8_lossy(&pending[valid..]));
                    pending.clear();
                    break;
                } else {
                    pending.drain(..valid);
                    break;
                }
            }
        }
    }
    output
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args
        .first()
        .is_some_and(|value| value == "--help" || value == "-h")
    {
        println!(
            "jian-client connect --server URL --host HOST_ID --token TOKEN\nConnect this host to a Jian server."
        );
        return Ok(());
    }
    let options = parse_args(&args)?;
    run(options).await
}

struct Options {
    server: String,
    host: String,
    token: String,
}

fn parse_args(args: &[String]) -> Result<Options> {
    if args.first().map(String::as_str) != Some("connect") {
        return Err(anyhow!(
            "usage: jian-client connect --server URL --host HOST_ID --token TOKEN"
        ));
    }
    let mut server = String::new();
    let mut host = String::new();
    let mut token = String::new();
    let mut index = 1;
    while index < args.len() {
        let key = args[index].as_str();
        let value = args
            .get(index + 1)
            .ok_or_else(|| anyhow!("missing value for {key}"))?;
        match key {
            "--server" => server = value.clone(),
            "--host" => host = value.clone(),
            "--token" => token = value.clone(),
            _ => return Err(anyhow!("unknown argument: {key}")),
        }
        index += 2;
    }
    if server.is_empty() || host.is_empty() || token.is_empty() {
        return Err(anyhow!("server, host, and token are required"));
    }
    Ok(Options {
        server,
        host,
        token,
    })
}

async fn run(options: Options) -> Result<()> {
    let endpoint = websocket_url(&options.server, &options.host)?;
    let terminals = Arc::new(Mutex::new(HashMap::<String, Arc<ClientTerminal>>::new()));
    let (outgoing, outgoing_rx) = mpsc::channel::<String>(256);
    let outgoing_rx = Arc::new(tokio::sync::Mutex::new(outgoing_rx));
    let mut backoff = Duration::from_secs(1);
    loop {
        match connect(
            &endpoint,
            &options.token,
            terminals.clone(),
            outgoing.clone(),
            outgoing_rx.clone(),
        )
        .await
        {
            Ok(true) => {
                let active: Vec<_> = terminals.lock().unwrap().values().cloned().collect();
                for terminal in active {
                    terminal.stop();
                }
                return Ok(());
            }
            Ok(false) => backoff = Duration::from_secs(1),
            Err(error) if error.downcast_ref::<PermanentConnectionError>().is_some() => {
                let active: Vec<_> = terminals.lock().unwrap().values().cloned().collect();
                for terminal in active {
                    terminal.stop();
                }
                return Err(error);
            }
            Err(error) => eprintln!(
                "connection lost: {error:#}; retrying in {}s",
                backoff.as_secs()
            ),
        }
        sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

fn websocket_url(server: &str, host: &str) -> Result<String> {
    let (scheme, rest) = if let Some(rest) = server.strip_prefix("https://") {
        ("wss", rest)
    } else if let Some(rest) = server.strip_prefix("http://") {
        ("ws", rest)
    } else if let Some(rest) = server.strip_prefix("wss://") {
        ("wss", rest)
    } else if let Some(rest) = server.strip_prefix("ws://") {
        ("ws", rest)
    } else {
        return Err(anyhow!("server URL must start with http:// or https://"));
    };
    Ok(format!(
        "{scheme}://{}/api/client/connect/{host}",
        rest.trim_end_matches('/')
    ))
}

fn expand_home_path(value: &str, home: Option<&std::path::Path>) -> std::path::PathBuf {
    let Some(home) = home else {
        return value.into();
    };
    if value == "~" {
        home.to_path_buf()
    } else if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        home.join(rest)
    } else {
        value.into()
    }
}

async fn connect(
    endpoint: &str,
    token: &str,
    terminals: Arc<Mutex<HashMap<String, Arc<ClientTerminal>>>>,
    outgoing: mpsc::Sender<String>,
    outgoing_rx: Arc<tokio::sync::Mutex<mpsc::Receiver<String>>>,
) -> Result<bool> {
    let mut request = endpoint.into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {token}").parse().context("invalid token")?,
    );
    request
        .headers_mut()
        .insert("x-jian-platform", std::env::consts::OS.parse()?);
    let (socket, _) = match connect_async(request).await {
        Ok(connection) => connection,
        Err(tokio_tungstenite::tungstenite::Error::Http(response))
            if response.status().is_client_error() =>
        {
            return Err(PermanentConnectionError(response.status().as_u16()).into());
        }
        Err(error) => return Err(error).context("connect to Jian"),
    };
    let (mut sender, mut receiver) = socket.split();
    let active_sessions = terminals
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, terminal)| terminal.running())
        .map(|(id, terminal)| json!({"session_id":id,"run_id":terminal.run_id}))
        .collect::<Vec<_>>();
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    sender.send(Message::Text(json!({"type":"client.hello","protocol":1,"platform":std::env::consts::OS,"home":home,"sessions":active_sessions}).to_string().into())).await?;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(25));

    loop {
        tokio::select! {
            incoming = receiver.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let mut response = None;
                    if handle_command(&text, &terminals, &outgoing, &mut response) {
                        return Ok(true);
                    }
                    if let Some(response) = response {
                        sender.send(Message::Text(response.into())).await?;
                    }
                },
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(error)) => return Err(error.into()),
                _ => {}
            },
            text = async { outgoing_rx.lock().await.recv().await } => {
                if let Some(text) = text {
                    sender.send(Message::Text(text.into())).await?;
                }
            }
            _ = heartbeat.tick() => {
                sender.send(Message::Ping(Vec::new().into())).await?;
            }
        }
    }
    Ok(false)
}

fn handle_command(
    text: &str,
    terminals: &Arc<Mutex<HashMap<String, Arc<ClientTerminal>>>>,
    outgoing: &mpsc::Sender<String>,
    response: &mut Option<String>,
) -> bool {
    let Ok(command) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    let kind = command
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if kind == "client.revoke" {
        return true;
    }
    if kind == "client.incompatible" {
        eprintln!(
            "this jian-client version is incompatible with the server; upgrade both binaries"
        );
        return true;
    }
    let session = command
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if session.is_empty() {
        return false;
    }
    let run_id = command
        .get("run_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match kind {
        "pty.open" => {
            if run_id.is_empty() {
                return false;
            }
            let previous = terminals.lock().unwrap().get(session).cloned();
            if previous
                .as_ref()
                .is_some_and(|terminal| terminal.run_id == run_id && terminal.running())
            {
                return false;
            }
            if let Some(previous) = terminals.lock().unwrap().remove(session) {
                previous.stop();
            }
            let program = command
                .get("program")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let args = command
                .get("args")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let cwd = command
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let env = command.get("env").unwrap_or(&Value::Null);
            match ClientTerminal::spawn(program, &args, cwd, env, run_id) {
                Ok(terminal) => {
                    terminals
                        .lock()
                        .unwrap()
                        .insert(session.to_owned(), terminal.clone());
                    let _ = outgoing.try_send(json!({"session_id":session,"run_id":run_id,"seq":0,"type":"session.started","payload":{"running":true}}).to_string());
                    let output = terminal.clone();
                    let session_id = session.to_owned();
                    let run_id = run_id.to_owned();
                    let events = outgoing.clone();
                    let terminal_map = terminals.clone();
                    std::thread::spawn(move || {
                        let mut reader = match output.master.lock().unwrap().try_clone_reader() {
                            Ok(reader) => reader,
                            Err(error) => {
                                output.stop();
                                let mut state = output.output.lock().unwrap();
                                state.seq += 1;
                                let seq = state.seq;
                                drop(state);
                                let _ = events.blocking_send(json!({"session_id":session_id,"run_id":run_id,"seq":seq,"type":"pty.exit","payload":error.to_string()}).to_string());
                                remove_terminal_if_current(&terminal_map, &session_id, &output);
                                return;
                            }
                        };
                        let mut chunk = [0_u8; 4096];
                        let mut pending_utf8 = Vec::with_capacity(4);
                        loop {
                            match reader.read(&mut chunk) {
                                Ok(0) | Err(_) => break,
                                Ok(size) => {
                                    let seq = output.record_output(&chunk[..size]);
                                    let data =
                                        decode_output(&mut pending_utf8, &chunk[..size], false);
                                    if !data.is_empty() {
                                        let _ = events.try_send(json!({"session_id":session_id,"run_id":run_id,"seq":seq,"type":"pty.output","payload":data}).to_string());
                                    }
                                }
                            }
                        }
                        let tail = decode_output(&mut pending_utf8, &[], true);
                        if !tail.is_empty() {
                            let seq = output.record_output(&[]);
                            let _ = events.try_send(json!({"session_id":session_id,"run_id":run_id,"seq":seq,"type":"pty.output","payload":tail}).to_string());
                        }
                        let _ = output.child.lock().unwrap().wait();
                        output.running.store(false, Ordering::SeqCst);
                        let mut state = output.output.lock().unwrap();
                        state.seq += 1;
                        let seq = state.seq;
                        drop(state);
                        let _ = events.blocking_send(json!({"session_id":session_id,"run_id":run_id,"seq":seq,"type":"pty.exit","payload":"terminal exited"}).to_string());
                        remove_terminal_if_current(&terminal_map, &session_id, &output);
                    });
                }
                Err(error) => {
                    let _ = outgoing.try_send(json!({"session_id":session,"run_id":run_id,"seq":1,"type":"pty.exit","payload":error.to_string()}).to_string());
                }
            }
        }
        "pty.attach" => {
            let attach_id = command
                .get("attach_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if attach_id.is_empty() {
                return false;
            }
            if let Some(terminal) = terminals
                .lock()
                .unwrap()
                .get(session)
                .filter(|terminal| terminal.run_id == run_id)
                .cloned()
            {
                terminal.replay(session, attach_id, outgoing);
            } else {
                let _ = outgoing.try_send(json!({"session_id":session,"run_id":run_id,"attach_id":attach_id,"seq":0,"type":"session.replay.complete","payload":{}}).to_string());
                let _ = outgoing.try_send(json!({"session_id":session,"run_id":run_id,"attach_id":attach_id,"seq":0,"type":"session.started","payload":{"running":false}}).to_string());
            }
        }
        "pty.input" => {
            if let (Some(terminal), Some(data)) = (
                terminals
                    .lock()
                    .unwrap()
                    .get(session)
                    .filter(|terminal| terminal.run_id == run_id)
                    .cloned(),
                command.get("data").and_then(Value::as_str),
            ) {
                let _ = terminal.write(data);
            }
        }
        "pty.attachment" => {
            if let (Some(terminal), Some(data)) = (
                terminals
                    .lock()
                    .unwrap()
                    .get(session)
                    .filter(|terminal| terminal.run_id == run_id)
                    .cloned(),
                command.get("data").and_then(Value::as_str),
            ) && data.len() <= MAX_ATTACHMENT_BYTES.div_ceil(3) * 4
                && let Ok(bytes) =
                    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data)
                && bytes.len() <= MAX_ATTACHMENT_BYTES
            {
                let name = command
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("attachment.bin");
                let extension = std::path::Path::new(name)
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .filter(|ext| {
                        ext.len() <= 10 && ext.bytes().all(|byte| byte.is_ascii_alphanumeric())
                    })
                    .unwrap_or("bin");
                let path = std::env::temp_dir().join(format!(
                    "jian-{}.{}",
                    uuid::Uuid::new_v4(),
                    extension
                ));
                let written = {
                    use std::fs::OpenOptions;
                    let mut options = OpenOptions::new();
                    options.write(true).create_new(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.mode(0o600);
                    }
                    options
                        .open(&path)
                        .and_then(|mut file| file.write_all(&bytes))
                };
                if written.is_ok() {
                    let _ = terminal.write(&format!("{} ", shell_quote(&path.to_string_lossy())));
                }
            }
        }
        "pty.resize" => {
            if let (Some(terminal), Some(cols), Some(rows)) = (
                terminals
                    .lock()
                    .unwrap()
                    .get(session)
                    .filter(|terminal| terminal.run_id == run_id)
                    .cloned(),
                command
                    .get("cols")
                    .and_then(Value::as_u64)
                    .and_then(|v| u16::try_from(v).ok()),
                command
                    .get("rows")
                    .and_then(Value::as_u64)
                    .and_then(|v| u16::try_from(v).ok()),
            ) {
                let _ = terminal.resize(cols, rows);
            }
        }
        "pty.interrupt" => {
            if let Some(terminal) = terminals
                .lock()
                .unwrap()
                .get(session)
                .filter(|terminal| terminal.run_id == run_id)
                .cloned()
            {
                let _ = terminal.write("\x03");
            }
        }
        "pty.stop" => {
            let terminal = {
                let mut terminals = terminals.lock().unwrap();
                if terminals
                    .get(session)
                    .is_some_and(|terminal| terminal.run_id == run_id)
                {
                    terminals.remove(session)
                } else {
                    None
                }
            };
            if let Some(terminal) = terminal {
                terminal.stop();
            }
            *response = Some(json!({"session_id":session,"run_id":run_id,"seq":0,"type":"pty.stopped","payload":{}}).to_string());
        }
        _ => {}
    }
    false
}

fn remove_terminal_if_current(
    terminals: &Arc<Mutex<HashMap<String, Arc<ClientTerminal>>>>,
    session_id: &str,
    expected: &Arc<ClientTerminal>,
) {
    let mut terminals = terminals.lock().unwrap();
    if terminals
        .get(session_id)
        .is_some_and(|current| Arc::ptr_eq(current, expected))
    {
        terminals.remove(session_id);
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_connection_arguments() {
        let options = parse_args(&[
            "connect".into(),
            "--server".into(),
            "https://jian.example".into(),
            "--host".into(),
            "host-1".into(),
            "--token".into(),
            "secret".into(),
        ])
        .unwrap();

        assert_eq!(options.server, "https://jian.example");
        assert_eq!(options.host, "host-1");
        assert_eq!(options.token, "secret");
        assert!(parse_args(&["connect".into()]).is_err());
    }

    #[test]
    fn output_decoder_keeps_utf8_sequences_split_across_reads() {
        let mut pending = Vec::new();
        assert_eq!(decode_output(&mut pending, &[0xe4, 0xb8], false), "");
        assert_eq!(decode_output(&mut pending, &[0xad], false), "中");
        assert_eq!(decode_output(&mut pending, &[0xff], true), "�");
    }

    #[test]
    fn attachment_paths_are_quoted_as_single_shell_arguments() {
        assert_eq!(
            shell_quote("/tmp/a b; it's.txt"),
            "'/tmp/a b; it'\\''s.txt'"
        );
    }

    #[test]
    fn websocket_url_uses_secure_scheme_and_normalizes_trailing_slash() {
        assert_eq!(
            websocket_url("https://jian.example/", "host-1").unwrap(),
            "wss://jian.example/api/client/connect/host-1"
        );
        assert_eq!(
            websocket_url("http://127.0.0.1:8080", "host-1").unwrap(),
            "ws://127.0.0.1:8080/api/client/connect/host-1"
        );
        assert!(websocket_url("jian.example", "host-1").is_err());
    }

    #[test]
    fn remote_workspaces_expand_only_home_prefixes() {
        let home = std::path::Path::new("/home/jian");
        assert_eq!(expand_home_path("~", Some(home)), home);
        assert_eq!(
            expand_home_path("~/work/project", Some(home)),
            home.join("work/project")
        );
        assert_eq!(
            expand_home_path("~other/project", Some(home)),
            std::path::PathBuf::from("~other/project")
        );
        assert_eq!(
            expand_home_path("~/work", None),
            std::path::PathBuf::from("~/work")
        );
    }

    #[test]
    fn stop_command_returns_ack_without_using_the_outgoing_queue() {
        let terminals = Arc::new(Mutex::new(HashMap::new()));
        let (outgoing, _receiver) = mpsc::channel(1);
        let mut response = None;
        let close = handle_command(
            r#"{"type":"pty.stop","session_id":"session-1","run_id":"run-1"}"#,
            &terminals,
            &outgoing,
            &mut response,
        );

        assert!(!close);
        let response: Value = serde_json::from_str(response.as_deref().unwrap()).unwrap();
        assert_eq!(response["type"], "pty.stopped");
        assert_eq!(response["session_id"], "session-1");
        assert_eq!(response["run_id"], "run-1");
        assert_eq!(outgoing.capacity(), 1);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn stop_kills_the_terminal_process_group() {
        let pid_file =
            std::env::temp_dir().join(format!("jian-client-{}.pid", uuid::Uuid::new_v4()));
        let terminal = ClientTerminal::spawn(
            "/bin/sh",
            &[
                "-c".into(),
                format!("sleep 30 & echo $! > {}; wait", pid_file.display()),
            ],
            "/tmp",
            &Value::Null,
            "test-run",
        )
        .unwrap();
        for _ in 0..100 {
            if pid_file.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let pid = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();

        terminal.stop();
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
            std::thread::sleep(Duration::from_millis(10));
        }
        if alive {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        let _ = std::fs::remove_file(pid_file);
        assert!(!alive, "remote child process {pid} survived terminal stop");
    }
}
