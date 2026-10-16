#![allow(clippy::result_large_err)]

mod model;
mod remote;
mod runtime;
mod store;
mod terminal;

use std::{
    collections::HashMap,
    fs,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex, RwLock},
    time::{Duration, SystemTime},
};

use anyhow::{Context, Result, anyhow};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{
        ConnectInfo, Path as AxumPath, Query, State, WebSocketUpgrade,
        ws::{Message as WsMessage, WebSocket},
    },
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use bcrypt::{DEFAULT_COST, hash, verify};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, oneshot};
use tower::ServiceExt;
use yrs::{Doc, GetString, ReadTxn, StateVector, Transact, Update, updates::decoder::Decode};

use crate::{
    model::{AgentKind, AgentSettings, HostView, RegisteredHost, Session},
    runtime::Runtime,
    store::{Store, default_path, dirs_home, token_hash},
};

const COOKIE: &str = "jian_session";
const SESSION_TTL_SECS: i64 = 30 * 24 * 60 * 60;
const QUICK_NOTE_STATE_LIMIT: usize = 1024 * 1024;
const QUICK_NOTE_TEXT_LIMIT: usize = 100_000;

#[derive(Clone)]
struct QuickNoteEvent {
    username: String,
    update: String,
}

type QuickNoteResult<T> = std::result::Result<T, (StatusCode, String)>;

enum QuickNoteCommand {
    Get {
        username: String,
        reply: oneshot::Sender<QuickNoteResult<String>>,
    },
    Put {
        username: String,
        update: Vec<u8>,
        reply: oneshot::Sender<QuickNoteResult<()>>,
    },
}

struct QuickNoteWorker(mpsc::Sender<QuickNoteCommand>);

impl QuickNoteWorker {
    fn start(store: Arc<Store>) -> Result<Self> {
        let (sender, mut receiver) = mpsc::channel(64);
        std::thread::Builder::new()
            .name("jian-quick-note".into())
            .spawn(move || {
                while let Some(command) = receiver.blocking_recv() {
                    match command {
                        QuickNoteCommand::Get { username, reply } => {
                            let _ = reply.send(load_quick_note(&store, &username));
                        }
                        QuickNoteCommand::Put {
                            username,
                            update,
                            reply,
                        } => {
                            let _ = reply.send(save_quick_note(&store, &username, update));
                        }
                    }
                }
            })
            .context("start quick note worker")?;
        Ok(Self(sender))
    }

    async fn get(&self, username: String) -> QuickNoteResult<String> {
        let (reply, response) = oneshot::channel();
        self.0
            .send(QuickNoteCommand::Get { username, reply })
            .await
            .map_err(|_| quick_note_unavailable())?;
        response.await.map_err(|_| quick_note_unavailable())?
    }

    async fn put(&self, username: String, update: Vec<u8>) -> QuickNoteResult<()> {
        let (reply, response) = oneshot::channel();
        self.0
            .send(QuickNoteCommand::Put {
                username,
                update,
                reply,
            })
            .await
            .map_err(|_| quick_note_unavailable())?;
        response.await.map_err(|_| quick_note_unavailable())?
    }
}

fn quick_note_unavailable() -> (StatusCode, String) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "quick note worker unavailable".into(),
    )
}

#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct Assets;

struct AppState {
    store: Arc<Store>,
    runtime: Arc<Runtime>,
    locals: RwLock<HashMap<String, Session>>,
    hosts: RwLock<Vec<RegisteredHost>>,
    remote_sessions: RwLock<Vec<Session>>,
    settings_write: Mutex<()>,
    attempts: Mutex<HashMap<String, Vec<SystemTime>>>,
    quick_notes: QuickNoteWorker,
    quick_note_updates: broadcast::Sender<QuickNoteEvent>,
    resize_owners: Mutex<HashMap<String, String>>,
    secure_cookie: bool,
}

#[derive(Serialize, Deserialize)]
struct AuthSession {
    username: String,
    expires: chrono::DateTime<chrono::Utc>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_target(false).init();
    if let Err(error) = dispatch().await {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

async fn dispatch() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args
        .first()
        .is_some_and(|arg| !matches!(arg.as_str(), "run" | "serve" | "--config" | "-c"))
    {
        return cli(&args);
    }
    let args = if args.first().is_some_and(|v| v == "run" || v == "serve") {
        &args[1..]
    } else {
        &args[..]
    };
    let config = parse_config_arg(args)?;
    run_server(config).await
}

async fn run_server(config_path: Option<PathBuf>) -> Result<()> {
    let (config, resolved) = load_config(config_path)?;
    tracing::info!("jian config: {}", resolved.display());
    let store = Arc::new(Store::open(default_path())?);
    let username = std::env::var("JIAN_ADMIN_USER").unwrap_or_else(|_| "admin".into());
    let password = std::env::var("JIAN_ADMIN_PASSWORD").unwrap_or_else(|_| "change-me".into());
    store.ensure_admin(&username, &hash(password, DEFAULT_COST)?)?;
    let settings = match store.get_optional::<AgentSettings>("instance_config", "agents")? {
        Some(settings) => settings,
        None => store
            .get_optional::<AgentSettings>("agent_settings", &username)?
            .unwrap_or_default(),
    };
    store.save_instance_settings(&settings)?;
    let runtime = Runtime::new(settings);
    runtime.start_cache();
    let quick_notes = QuickNoteWorker::start(store.clone())?;
    let (quick_note_updates, _) = broadcast::channel(64);
    let hosts = store
        .get_optional::<Vec<RegisteredHost>>("registered_hosts", "all")?
        .unwrap_or_default();
    let mut remote_sessions = store
        .get_optional::<Vec<Session>>("remote_sessions", "all")?
        .unwrap_or_default();
    for session in &mut remote_sessions {
        if session.status == "running" {
            session.status = "offline".into();
        }
    }
    store.put("remote_sessions", "all", &remote_sessions)?;
    let state = Arc::new(AppState {
        store,
        runtime,
        locals: RwLock::new(HashMap::new()),
        hosts: RwLock::new(hosts),
        remote_sessions: RwLock::new(remote_sessions),
        settings_write: Mutex::new(()),
        attempts: Mutex::new(HashMap::new()),
        quick_notes,
        quick_note_updates,
        resize_owners: Mutex::new(HashMap::new()),
        secure_cookie: std::env::var("JIAN_SECURE_COOKIE").as_deref() == Ok("1"),
    });
    let app = routes(state).fallback(static_asset);
    let addr = SocketAddr::new(config.bind_ip, config.listen_port);
    tracing::info!("jian listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    Ok(())
}

fn routes(state: Arc<AppState>) -> Router {
    api_routes(state.clone()).merge(
        Router::new()
            .route("/api/ws", get(api_websocket))
            .route("/api/client/connect/{id}", get(client_connect))
            .with_state(state),
    )
}

fn api_routes(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/status", get(auth_status))
        .route("/api/auth/me", get(me))
        .route("/api/workspaces/browse", get(browse))
        .route(
            "/api/hosts/{id}/workspaces/browse",
            get(browse_remote_workspace),
        )
        .route("/api/workspaces/file", get(read_workspace_file))
        .route("/api/hosts", get(list_hosts).post(register_host))
        .route("/api/hosts/{id}", delete(remove_host))
        .route("/api/hosts/{id}/rotate", post(rotate_host))
        .route("/api/local/sessions", post(create_local).get(list_local))
        .route("/api/local/sessions/{id}", delete(remove_local))
        .route("/api/local/sessions/{id}/terminal", get(local_terminal))
        .route("/api/sessions/catalog", get(session_catalog))
        .route("/api/settings", get(settings).put(save_settings))
        .route("/api/quick-note", get(quick_note).put(put_quick_note))
        .route("/api/settings/terminal-status", get(terminal_status))
        .route(
            "/api/settings/terminals/{id}/release",
            post(release_terminal),
        )
        .route(
            "/api/settings/terminals/{id}/restart",
            post(restart_terminal),
        )
        .route("/api/settings/terminals/release-all", post(release_all))
        .route("/api/agents/codex/rate-limits", get(codex_rate_limits))
        .route(
            "/api/agents/codex/sessions",
            get(list_codex).post(create_codex),
        )
        .route("/api/agents/codex/sessions/cache", get(list_codex))
        .route("/api/agents/codex/sessions/refresh", post(refresh_codex))
        .route(
            "/api/agents/codex/sessions/{id}",
            get(get_codex).patch(rename_codex).delete(remove_codex),
        )
        .route(
            "/api/agents/codex/sessions/{id}/history",
            get(history_codex),
        )
        .route("/api/agents/codex/sessions/{id}/stop", post(stop_codex))
        .route(
            "/api/agents/codex/sessions/{id}/terminal",
            get(codex_terminal),
        )
        .route(
            "/api/agents/command/sessions",
            get(list_command).post(create_command),
        )
        .route("/api/agents/command/sessions/cache", get(list_command))
        .route(
            "/api/agents/command/sessions/refresh",
            post(refresh_command),
        )
        .route(
            "/api/agents/command/sessions/{id}",
            get(get_command)
                .patch(rename_command)
                .delete(remove_command),
        )
        .route(
            "/api/agents/command/sessions/{id}/history",
            get(history_command),
        )
        .route("/api/agents/command/sessions/{id}/stop", post(stop_command))
        .route(
            "/api/agents/command/sessions/{id}/terminal",
            get(command_terminal),
        )
        .with_state(state)
}

type Api = std::result::Result<Response, Response>;
fn response(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}
fn ok<T: Serialize>(value: T) -> Api {
    Ok((StatusCode::OK, Json(value)).into_response())
}
fn fail(status: StatusCode, error: impl ToString) -> Api {
    Err(response(status, json!({"error": error.to_string()})))
}
fn no_content() -> Api {
    Ok(StatusCode::NO_CONTENT.into_response())
}

fn cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .map(str::trim)
        .find_map(|v| v.strip_prefix(&format!("{COOKIE}=")).map(str::to_owned))
}
fn current(state: &AppState, headers: &HeaderMap) -> Option<String> {
    let token = cookie(headers)?;
    let key = token_hash(&token);
    let now = chrono::Utc::now();
    let mut session = state.store.get::<AuthSession>("auth_sessions", &key).ok()?;
    if session.expires <= now {
        state.store.delete("auth_sessions", &key).ok()?;
        return None;
    }
    if session.expires <= now + chrono::Duration::seconds(SESSION_TTL_SECS - 300) {
        session = state
            .store
            .update_existing("auth_sessions", &key, |mut stored: AuthSession| {
                if stored.expires <= now {
                    return None;
                }
                stored.expires = now + chrono::Duration::seconds(SESSION_TTL_SECS);
                Some(stored)
            })
            .ok()??;
    }
    Some(session.username)
}
fn require(state: &AppState, headers: &HeaderMap) -> std::result::Result<String, Response> {
    current(state, headers).ok_or_else(|| {
        response(
            StatusCode::UNAUTHORIZED,
            json!({"error":"authentication required"}),
        )
    })
}
fn set_cookie(token: &str, secure: bool, max_age: i32) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{COOKIE}={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Strict{}",
        if secure { "; Secure" } else { "" }
    ))
    .unwrap()
}

#[derive(Deserialize)]
struct Login {
    username: String,
    password: String,
}
async fn login(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(input): Json<Login>,
) -> Api {
    let ip = addr.ip().to_string();
    let now = SystemTime::now();
    {
        let mut attempts = state.attempts.lock().unwrap();
        let recent = attempts.entry(ip.clone()).or_default();
        recent.retain(|t| now.duration_since(*t).unwrap_or_default() < Duration::from_secs(60));
        if recent.len() >= 10 {
            return fail(StatusCode::UNAUTHORIZED, "invalid credentials");
        }
        recent.push(now);
    }
    let stored_hash = state.store.admin_hash(&input.username);
    let password = input.password.clone();
    let valid = tokio::task::spawn_blocking(move || {
        stored_hash.is_some_and(|hash| verify(&password, &hash).unwrap_or(false))
    })
    .await
    .unwrap_or(false);
    if !valid {
        return fail(StatusCode::UNAUTHORIZED, "invalid credentials");
    }
    state.attempts.lock().unwrap().remove(&ip);
    let mut raw = [0_u8; 32];
    rand::rng().fill_bytes(&mut raw);
    let token = URL_SAFE_NO_PAD.encode(raw);
    let session = AuthSession {
        username: input.username.clone(),
        expires: chrono::Utc::now() + chrono::Duration::seconds(SESSION_TTL_SECS),
    };
    if let Err(e) = state
        .store
        .put("auth_sessions", &token_hash(&token), &session)
    {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    let _ = state.store.put(
        "audit_events",
        &chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap_or_default()
            .to_string(),
        &json!({"type":"login","username":input.username}),
    );
    let mut rsp = response(StatusCode::OK, json!({"username": input.username}));
    rsp.headers_mut().insert(
        header::SET_COOKIE,
        set_cookie(&token, state.secure_cookie, SESSION_TTL_SECS as i32),
    );
    Ok(rsp)
}
async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Api {
    if let Some(token) = cookie(&headers) {
        let _ = state.store.delete("auth_sessions", &token_hash(&token));
    }
    let mut rsp = StatusCode::NO_CONTENT.into_response();
    rsp.headers_mut()
        .insert(header::SET_COOKIE, set_cookie("", state.secure_cookie, -1));
    Ok(rsp)
}
async fn auth_status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Api {
    match current(&state, &headers) {
        Some(username) => {
            let mut response = response(
                StatusCode::OK,
                json!({"authenticated":true,"username":username}),
            );
            if let Some(token) = cookie(&headers) {
                response.headers_mut().insert(
                    header::SET_COOKIE,
                    set_cookie(&token, state.secure_cookie, SESSION_TTL_SECS as i32),
                );
            }
            Ok(response)
        }
        None => ok(json!({"authenticated":false})),
    }
}
async fn me(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Api {
    let username = require(&state, &headers)?;
    let settings = settings_view(&state, &username);
    ok(json!({"username":username,"settings":settings,"hosts":host_views(&state)}))
}

#[derive(Deserialize)]
struct QuickNoteUpdate {
    update: String,
}

fn quick_note_doc(state: Option<&str>) -> Result<Doc> {
    let doc = Doc::new();
    if let Some(state) = state {
        let bytes = URL_SAFE_NO_PAD.decode(state)?;
        if bytes.len() > QUICK_NOTE_STATE_LIMIT {
            return Err(anyhow!("quick note state is too large"));
        }
        doc.transact_mut()
            .apply_update(Update::decode_v1(&bytes)?)?;
    }
    Ok(doc)
}

fn quick_note_state(doc: &Doc) -> Result<String> {
    let text = doc.get_or_insert_text("body");
    let txn = doc.transact();
    let bytes = txn.encode_state_as_update_v1(&StateVector::default());
    if bytes.len() > QUICK_NOTE_STATE_LIMIT {
        return Err(anyhow!("quick note state exceeds 1 MiB"));
    }
    if text.get_string(&txn).chars().count() > QUICK_NOTE_TEXT_LIMIT {
        return Err(anyhow!("quick note text exceeds 100,000 characters"));
    }
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn load_quick_note(store: &Store, username: &str) -> QuickNoteResult<String> {
    let state = store.quick_note(username).map(|note| note.state);
    quick_note_doc(state.as_deref())
        .and_then(|doc| quick_note_state(&doc))
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}

fn save_quick_note(store: &Store, username: &str, update: Vec<u8>) -> QuickNoteResult<()> {
    let saved = store.quick_note(username);
    let doc = quick_note_doc(saved.as_ref().map(|note| note.state.as_str()))
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let update = Update::decode_v1(&update)
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid quick note update".into()))?;
    doc.transact_mut()
        .apply_update(update)
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid quick note update".into()))?;
    let note = store::QuickNote {
        state: quick_note_state(&doc)
            .map_err(|error| (StatusCode::PAYLOAD_TOO_LARGE, error.to_string()))?,
        updated_at: chrono::Utc::now(),
        version: 1,
    };
    store
        .save_quick_note(username, &note)
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}

fn decode_quick_note_update(value: &str) -> Result<Vec<u8>, base64::DecodeError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| STANDARD.decode(value))
}

async fn quick_note(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Api {
    let username = require(&state, &headers)?;
    match state.quick_notes.get(username).await {
        Ok(state) => ok(json!({"state": state, "version": 1})),
        Err((status, error)) => fail(status, error),
    }
}

async fn put_quick_note(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<QuickNoteUpdate>,
) -> Api {
    let username = require(&state, &headers)?;
    let update = match decode_quick_note_update(&input.update) {
        Ok(update) if update.len() <= QUICK_NOTE_STATE_LIMIT => update,
        Ok(_) => {
            return fail(
                StatusCode::PAYLOAD_TOO_LARGE,
                "quick note update exceeds 1 MiB",
            );
        }
        Err(_) => {
            return fail(
                StatusCode::BAD_REQUEST,
                "invalid quick note update encoding",
            );
        }
    };
    let broadcast_update = URL_SAFE_NO_PAD.encode(&update);
    if let Err((status, error)) = state.quick_notes.put(username.clone(), update).await {
        return fail(status, error);
    }
    let _ = state.quick_note_updates.send(QuickNoteEvent {
        username,
        update: broadcast_update,
    });
    no_content()
}

fn merged_settings(state: &AppState, _username: &str) -> AgentSettings {
    let mut settings = state.runtime.settings();
    settings.path = std::env::var("PATH").unwrap_or_default();
    settings
}

fn settings_view(state: &AppState, username: &str) -> AgentSettings {
    merged_settings(state, username)
}

fn host_views(state: &AppState) -> Vec<HostView> {
    state
        .hosts
        .read()
        .unwrap()
        .iter()
        .map(|host| HostView {
            id: host.id.clone(),
            name: host.name.clone(),
            platform: host.platform.clone(),
            home: host.home.clone(),
            connected: state.runtime.remote.is_connected(&host.id),
            created_at: host.created_at,
        })
        .collect()
}

fn save_hosts(state: &AppState, hosts: &[RegisteredHost]) -> Result<()> {
    state.store.put("registered_hosts", "all", hosts)
}

fn new_client_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[derive(Deserialize)]
struct RegisterHost {
    name: String,
}

async fn list_hosts(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Api {
    require(&state, &headers)?;
    ok(host_views(&state))
}

async fn register_host(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<RegisterHost>,
) -> Api {
    require(&state, &headers)?;
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return fail(StatusCode::BAD_REQUEST, "主机名称长度需为 1 至 100 个字符");
    }
    let token = new_client_token();
    let host = RegisteredHost {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        token_hash: token_hash(&token),
        platform: "unknown".into(),
        home: String::new(),
        created_at: chrono::Utc::now(),
    };
    let mut hosts = state.hosts.write().unwrap();
    let mut next = hosts.clone();
    next.push(host.clone());
    if let Err(error) = save_hosts(&state, &next) {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, error);
    }
    *hosts = next;
    ok(
        json!({"host":{"id":host.id,"name":host.name,"platform":host.platform,"home":host.home,"connected":false,"created_at":host.created_at},"token":token}),
    )
}

async fn rotate_host(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Api {
    require(&state, &headers)?;
    let token = new_client_token();
    let mut hosts = state.hosts.write().unwrap();
    let mut next = hosts.clone();
    let Some(host) = next.iter_mut().find(|host| host.id == id) else {
        return fail(StatusCode::NOT_FOUND, "主机不存在");
    };
    host.token_hash = token_hash(&token);
    let view = json!({"id":host.id,"name":host.name,"platform":host.platform,"home":host.home,"connected":false,"created_at":host.created_at});
    if let Err(error) = save_hosts(&state, &next) {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, error);
    }
    *hosts = next;
    drop(hosts);
    let _ = state
        .runtime
        .remote
        .send(&id, json!({"type":"client.revoke"}));
    ok(json!({"host":view,"token":token}))
}

async fn remove_host(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Api {
    require(&state, &headers)?;
    if !state.hosts.read().unwrap().iter().any(|host| host.id == id) {
        return fail(StatusCode::NOT_FOUND, "主机不存在");
    }
    let initial_sessions: Vec<_> = state
        .remote_sessions
        .read()
        .unwrap()
        .iter()
        .filter(|session| session.host_id == id && session.status != "ended")
        .cloned()
        .collect();
    if initial_sessions
        .iter()
        .any(|session| !state.runtime.remote.is_connected(&session.host_id))
    {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "主机离线时仍有未结束的终端，无法安全删除",
        );
    }
    if let Err(error) = stop_remote_sessions(&state, &initial_sessions).await {
        return fail(StatusCode::SERVICE_UNAVAILABLE, error);
    }

    let mut hosts = state.hosts.write().unwrap();
    let Some(host_index) = hosts.iter().position(|host| host.id == id) else {
        return fail(StatusCode::NOT_FOUND, "主机不存在");
    };
    let mut remote_sessions = state.remote_sessions.write().unwrap();
    let stopped: std::collections::HashSet<_> = initial_sessions
        .iter()
        .map(|session| (session.id.as_str(), session.run_id.as_str()))
        .collect();
    if remote_sessions.iter().any(|session| {
        session.host_id == id
            && session.status != "ended"
            && !stopped.contains(&(session.id.as_str(), session.run_id.as_str()))
    }) {
        return fail(StatusCode::CONFLICT, "删除期间主机新增了终端，请重试");
    }
    let removed: Vec<_> = remote_sessions
        .iter()
        .filter(|session| session.host_id == id)
        .cloned()
        .collect();
    let mut next_hosts = hosts.clone();
    next_hosts.remove(host_index);
    let next_sessions: Vec<_> = remote_sessions
        .iter()
        .filter(|session| session.host_id != id)
        .cloned()
        .collect();
    let hosts_value = match serde_json::to_value(&next_hosts) {
        Ok(value) => value,
        Err(error) => return fail(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    let sessions_value = match serde_json::to_value(&next_sessions) {
        Ok(value) => value,
        Err(error) => return fail(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    let values = [
        ("registered_hosts", "all", hosts_value),
        ("remote_sessions", "all", sessions_value),
    ];
    if let Err(error) = state.store.put_many(&values) {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, error);
    }
    *hosts = next_hosts;
    *remote_sessions = next_sessions;
    drop(remote_sessions);
    drop(hosts);
    let _ = state
        .runtime
        .remote
        .send(&id, json!({"type":"client.revoke"}));
    for session in removed {
        state
            .runtime
            .remove_catalog_session(session.kind, &session.id);
        state.runtime.remote.forget_session(&session.id);
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn settings(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Api {
    let username = require(&state, &headers)?;
    ok(json!({"settings":settings_view(&state, &username),"hosts":host_views(&state)}))
}

async fn save_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(update): Json<Value>,
) -> Api {
    require(&state, &headers)?;
    let field_mask = match update.as_object().and_then(|object| object.get("_fields")) {
        None => None,
        Some(Value::Array(fields)) => {
            let mut mask = Vec::with_capacity(fields.len());
            for field in fields {
                let Some(field) = field.as_str() else {
                    return fail(StatusCode::BAD_REQUEST, "设置字段列表无效");
                };
                mask.push(field.to_owned());
            }
            Some(mask)
        }
        Some(_) => return fail(StatusCode::BAD_REQUEST, "设置字段列表无效"),
    };
    let mut update = update;
    if let Some(object) = update.as_object_mut() {
        object.remove("_fields");
    }
    let incoming = match serde_json::from_value::<AgentSettings>(update) {
        Ok(settings) => settings,
        Err(error) => return fail(StatusCode::BAD_REQUEST, error),
    };
    let _settings_write = state.settings_write.lock().unwrap();
    let mut input = if let Some(fields) = field_mask {
        let mut merged = state.runtime.settings();
        for field in fields {
            match field.as_str() {
                "codex_bin" => merged.codex_bin = incoming.codex_bin.clone(),
                "local_profiles" => merged.local_profiles = incoming.local_profiles.clone(),
                "codex_args" => merged.codex_args = incoming.codex_args.clone(),
                "codex_env" => merged.codex_env = incoming.codex_env.clone(),
                "command_configs" => merged.command_configs = incoming.command_configs.clone(),
                "codex_enabled" => merged.codex_enabled = incoming.codex_enabled,
                "command_enabled" => merged.command_enabled = incoming.command_enabled,
                _ => return fail(StatusCode::BAD_REQUEST, "设置字段不可更新"),
            }
        }
        merged
    } else {
        incoming
    };
    let current = state.runtime.settings();
    input.codex_bin = input.codex_bin.trim().to_string();
    if input.codex_bin.is_empty() {
        input.codex_bin = current.codex_bin;
    }
    input.path = std::env::var("PATH").unwrap_or_default();
    input.local_enabled = true;
    input.agent_toggles_set = true;
    input.local_profiles = normalize_profiles(&input.local_profiles);
    input.codex_args = clean_args(&input.codex_args);
    if !valid_args(&input.codex_args) {
        return fail(
            StatusCode::BAD_REQUEST,
            "Codex 最多允许 128 个参数且参数不能包含 NUL",
        );
    }
    let mut ids = std::collections::HashSet::new();
    for config in &mut input.command_configs {
        config.id = config.id.trim().to_string();
        config.name = config.name.trim().to_string();
        config.program = config.program.trim().to_string();
        if config.id.is_empty()
            || config.id.len() > 64
            || !config
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            || config.name.is_empty()
            || config.name.chars().count() > 100
            || config.program.is_empty()
            || config.program.len() > 4096
            || config.program.contains('\0')
            || !ids.insert(config.id.clone())
        {
            return fail(
                StatusCode::BAD_REQUEST,
                "启动配置的 ID、名称和程序必须有效且 ID 唯一",
            );
        }
        config.args = clean_args(&config.args);
        if config.args.len() > 128
            || config.env.len() > 128
            || config.args.iter().any(|arg| arg.contains('\0'))
        {
            return fail(
                StatusCode::BAD_REQUEST,
                "每个启动配置最多允许 128 个参数和环境变量",
            );
        }
        for env in &mut config.env {
            env.key = env.key.trim().to_string();
            if env.key.is_empty()
                || !env.key.chars().enumerate().all(|(index, c)| {
                    c == '_' || c.is_ascii_alphabetic() || index > 0 && c.is_ascii_digit()
                })
                || env.value.contains('\0')
            {
                return fail(StatusCode::BAD_REQUEST, "启动配置包含无效环境变量");
            }
        }
    }
    if input.command_configs.len() > 64 {
        return fail(StatusCode::BAD_REQUEST, "最多允许 64 个启动配置");
    }
    if let Err(error) = state.store.save_instance_settings(&input) {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, error);
    }
    state.runtime.set_settings(input.clone());
    for kind in [AgentKind::Codex, AgentKind::Command] {
        state.runtime.catalog_changed(kind);
    }
    ok(input)
}

#[derive(Deserialize)]
struct BrowseQuery {
    path: String,
    #[serde(default = "default_browse_type")]
    r#type: String,
    file_ext: Option<String>,
}

fn default_browse_type() -> String {
    "all".into()
}

fn resolve_workspace_path(value: &str) -> std::result::Result<PathBuf, (StatusCode, String)> {
    let home = match fs::canonicalize(dirs_home()) {
        Ok(v) => v,
        Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    };
    match fs::canonicalize(expand_path(value)) {
        Ok(path) if path.starts_with(&home) => Ok(path),
        Ok(_) => Err((
            StatusCode::FORBIDDEN,
            "path is outside the home directory".into(),
        )),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            Err((StatusCode::FORBIDDEN, e.to_string()))
        }
        Err(e) => Err((StatusCode::BAD_REQUEST, e.to_string())),
    }
}

async fn browse(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<BrowseQuery>,
) -> Api {
    require(&state, &headers)?;
    let filter = match query.r#type.as_str() {
        "all" => None,
        "dir" | "directory" => Some(true),
        "file" => Some(false),
        value => return fail(StatusCode::BAD_REQUEST, format!("invalid type: {value}")),
    };
    let file_ext = query
        .file_ext
        .as_deref()
        .map(|value| value.trim_start_matches('.').to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let path = match resolve_workspace_path(&query.path) {
        Ok(path) => path,
        Err((status, error)) => return fail(status, error),
    };
    let home = match fs::canonicalize(dirs_home()) {
        Ok(home) => home,
        Err(error) => return fail(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    if !path.is_dir() {
        return fail(StatusCode::BAD_REQUEST, "path is not a directory");
    }
    let entries = match fs::read_dir(&path) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return fail(StatusCode::FORBIDDEN, e);
        }
        Err(e) => return fail(StatusCode::BAD_REQUEST, e),
    };
    let values: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let directory = entry.file_type().ok()?.is_dir();
            if filter.is_some_and(|want_directory| directory != want_directory) {
                return None;
            }
            if !directory
                && let Some(extension) = &file_ext
                && entry
                    .path()
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref()
                    != Some(extension)
            {
                return None;
            }
            Some(json!({
                "name": entry.file_name().to_string_lossy(),
                "directory": directory,
            }))
        })
        .collect();
    let parent = path
        .parent()
        .filter(|parent| parent.starts_with(&home))
        .unwrap_or(&home);
    ok(json!({"path":path,"parent":parent.to_string_lossy(),"entries":values}))
}

async fn browse_remote_workspace(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(host_id): AxumPath<String>,
    Query(query): Query<BrowseQuery>,
) -> Api {
    require(&state, &headers)?;
    if query.path.len() > 4096 {
        return fail(StatusCode::BAD_REQUEST, "path is too long");
    }
    match query.r#type.as_str() {
        "all" | "dir" | "directory" | "file" => {}
        value => return fail(StatusCode::BAD_REQUEST, format!("invalid type: {value}")),
    }
    let file_ext = query
        .file_ext
        .as_deref()
        .map(|value| value.trim_start_matches('.').to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    if file_ext.as_ref().is_some_and(|value| value.len() > 32) {
        return fail(StatusCode::BAD_REQUEST, "file extension is too long");
    }
    if !state
        .hosts
        .read()
        .unwrap()
        .iter()
        .any(|host| host.id == host_id)
    {
        return fail(StatusCode::NOT_FOUND, "registered host not found");
    }
    if !state.runtime.remote.is_connected(&host_id) {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "目标主机当前未连接");
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let response = match state
        .runtime
        .remote
        .request(
            &host_id,
            json!({
                "type":"workspace.browse",
                "request_id":request_id,
                "path":query.path,
                "filter":query.r#type,
                "file_ext":file_ext,
            }),
        )
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return fail(
                StatusCode::SERVICE_UNAVAILABLE,
                format!(
                    "远程目录请求未完成，请更新 jian-client 并检查 WAF WebSocket 双向转发：{error}"
                ),
            );
        }
    };
    match response.get("type").and_then(Value::as_str) {
        Some("workspace.browse.result") => match response.get("result") {
            Some(result) => ok(result.clone()),
            None => fail(
                StatusCode::BAD_GATEWAY,
                "remote host returned an invalid directory",
            ),
        },
        Some("workspace.browse.error") => {
            let status = response
                .get("status")
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .and_then(|value| StatusCode::from_u16(value).ok())
                .filter(|status| status.is_client_error() || status.is_server_error())
                .unwrap_or(StatusCode::BAD_GATEWAY);
            fail(
                status,
                response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("remote directory request failed"),
            )
        }
        _ => fail(
            StatusCode::BAD_GATEWAY,
            "remote host returned an invalid directory",
        ),
    }
}

#[derive(Deserialize)]
struct WorkspaceFileQuery {
    path: String,
}

async fn read_workspace_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<WorkspaceFileQuery>,
) -> Api {
    require(&state, &headers)?;
    let path = match resolve_workspace_path(&query.path) {
        Ok(path) => path,
        Err((status, error)) => return fail(status, error),
    };
    match fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return fail(StatusCode::BAD_REQUEST, "path is not a file"),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return fail(StatusCode::FORBIDDEN, e);
        }
        Err(e) => return fail(StatusCode::BAD_REQUEST, e),
    }
    match fs::read_to_string(&path) {
        Ok(content) => ok(json!({"path": path, "content": content})),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            fail(StatusCode::FORBIDDEN, e)
        }
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
            fail(StatusCode::BAD_REQUEST, "file is not valid UTF-8")
        }
        Err(e) => fail(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize, Default)]
struct CreateLocal {
    workspace: Option<String>,
}
async fn create_local(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    input: Option<Json<CreateLocal>>,
) -> Api {
    require(&state, &headers)?;
    let workspace = expand_path(
        input
            .and_then(|v| v.workspace.clone())
            .as_deref()
            .unwrap_or("~"),
    );
    let workspace = match fs::canonicalize(workspace) {
        Ok(v) if v.is_dir() => v,
        _ => return fail(StatusCode::BAD_REQUEST, "workspace is not a directory"),
    };
    let mut session = Session::new(
        AgentKind::Local,
        workspace.to_string_lossy().into_owned(),
        "Bash".into(),
    );
    session.id = format!("local-{}", session.id);
    session.status = "idle".into();
    state
        .locals
        .write()
        .unwrap()
        .insert(session.id.clone(), session.clone());
    state.runtime.update_catalog_session(session.clone());
    Ok((StatusCode::CREATED, Json(session)).into_response())
}
async fn list_local(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Api {
    require(&state, &headers)?;
    let mut values: Vec<_> = state.locals.read().unwrap().values().cloned().collect();
    values.sort_by_key(|value| std::cmp::Reverse(value.updated_at));
    ok(values)
}
async fn remove_local(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Api {
    require(&state, &headers)?;
    if state.locals.write().unwrap().remove(&id).is_none() {
        return fail(StatusCode::NOT_FOUND, "session not found");
    }
    let _ = state.runtime.terminals.stop(&id);
    state.runtime.remove_catalog_session(AgentKind::Local, &id);
    no_content()
}

#[derive(Deserialize, Default)]
struct CatalogQuery {
    areas: Option<String>,
}

async fn session_catalog(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<CatalogQuery>,
) -> Api {
    require(&state, &headers)?;
    let mut areas = serde_json::Map::new();
    for area in query
        .areas
        .as_deref()
        .unwrap_or("local,codex,command")
        .split(',')
    {
        let kind = match area {
            "local" => AgentKind::Local,
            "codex" => AgentKind::Codex,
            "command" => AgentKind::Command,
            _ => return fail(StatusCode::BAD_REQUEST, "invalid catalog area"),
        };
        let mut catalog = state.runtime.catalog_state(kind);
        if kind == AgentKind::Local {
            let remembered = catalog.rows.clone();
            catalog.rows = state
                .locals
                .read()
                .unwrap()
                .values()
                .map(|session| {
                    let mut row = session.clone();
                    row.status = if state.runtime.terminals.running(&row.id) {
                        "running".into()
                    } else {
                        remembered
                            .iter()
                            .find(|value| value.id == row.id)
                            .map(|value| {
                                if value.status == "running" {
                                    "ended".into()
                                } else {
                                    value.status.clone()
                                }
                            })
                            .unwrap_or(row.status)
                    };
                    row
                })
                .collect();
            catalog.last_success_at = Some(chrono::Utc::now());
        }
        // A snapshot is cached discovery plus current server-owned processes; no CLI runs here.
        for live in state.runtime.terminals.sessions(kind) {
            if let Some(row) = catalog.rows.iter_mut().find(|row| row.id == live.id) {
                *row = live;
            } else {
                catalog.rows.push(live);
            }
        }
        for remote in state
            .remote_sessions
            .read()
            .unwrap()
            .iter()
            .filter(|session| session.kind == kind)
        {
            if let Some(row) = catalog.rows.iter_mut().find(|row| row.id == remote.id) {
                *row = remote.clone();
            } else {
                catalog.rows.push(remote.clone());
            }
        }
        catalog
            .rows
            .sort_by_key(|row| std::cmp::Reverse(row.updated_at));
        areas.insert(area.into(), serde_json::to_value(catalog).unwrap());
    }
    ok(json!({"areas":areas}))
}
async fn terminal_status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Api {
    require(&state, &headers)?;
    ok(json!({"active_pool":state.runtime.terminals.status()}))
}
async fn release_terminal(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Api {
    require(&state, &headers)?;
    let remote_session = {
        state
            .remote_sessions
            .read()
            .unwrap()
            .iter()
            .find(|session| session.id == id)
            .cloned()
    };
    if let Some(mut session) = remote_session {
        if let Err(error) = stop_remote_session(&state, &session).await {
            return fail(StatusCode::SERVICE_UNAVAILABLE, error);
        }
        session.status = "ended".into();
        session.updated_at = chrono::Utc::now();
        let persisted = modify_remote_sessions(&state, |sessions| {
            if let Some(row) = sessions.iter_mut().find(|row| row.id == id) {
                *row = session.clone();
                Ok(true)
            } else {
                Ok(false)
            }
        });
        if let Err(error) = persisted {
            return fail(StatusCode::INTERNAL_SERVER_ERROR, error);
        }
        state.runtime.update_catalog_session(session);
        return ok(json!({"released":true,"id":id}));
    }
    let session = state.runtime.terminals.session(&id);
    state.locals.write().unwrap().remove(&id);
    if let Err(e) = state.runtime.terminals.stop(&id) {
        return fail(StatusCode::NOT_FOUND, e);
    }
    if let Some(mut session) = session {
        if session.kind == AgentKind::Local {
            state.runtime.remove_catalog_session(session.kind, &id);
        } else {
            session.status = "ended".into();
            session.updated_at = chrono::Utc::now();
            state.runtime.update_catalog_session(session);
        }
    }
    ok(json!({"released":true,"id":id}))
}
async fn restart_terminal(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Api {
    require(&state, &headers)?;
    let remote_session = {
        state
            .remote_sessions
            .read()
            .unwrap()
            .iter()
            .find(|session| session.id == id)
            .cloned()
    };
    if let Some(mut session) = remote_session {
        if !state.runtime.remote.is_connected(&session.host_id) {
            return fail(StatusCode::SERVICE_UNAVAILABLE, "目标主机当前未连接");
        }
        let settings = merged_settings(&state, "");
        let (program, args, env) = match command_spec(&session, &settings) {
            Ok(command) => command,
            Err(error) => return fail(StatusCode::BAD_REQUEST, error),
        };
        if let Err(error) = stop_remote_session(&state, &session).await {
            return fail(StatusCode::SERVICE_UNAVAILABLE, error);
        }
        session.run_id = uuid::Uuid::new_v4().to_string();
        session.status = "running".into();
        session.updated_at = chrono::Utc::now();
        if let Err(error) = modify_remote_sessions(&state, |sessions| {
            if let Some(row) = sessions.iter_mut().find(|row| row.id == id) {
                *row = session.clone();
                Ok(())
            } else {
                anyhow::bail!("远程终端记录不存在")
            }
        }) {
            return fail(StatusCode::INTERNAL_SERVER_ERROR, error);
        }
        if let Err(error) = state.runtime.remote.send(&session.host_id, json!({"type":"pty.open","session_id":id,"run_id":session.run_id,"program":program,"args":args,"env":env,"cwd":session.workspace})) {
            session.status = "offline".into();
            let _ = modify_remote_sessions(&state, |sessions| {
                if let Some(row) = sessions.iter_mut().find(|row| row.id == id) { *row = session.clone(); }
                Ok(())
            });
            return fail(StatusCode::SERVICE_UNAVAILABLE, error);
        }
        state.runtime.update_catalog_session(session);
        return ok(json!({"restarted":true,"id":id}));
    }
    if let Err(e) = state.runtime.restart_terminal(&id) {
        return fail(StatusCode::BAD_REQUEST, e);
    }
    if let Some(session) = state.runtime.terminals.session(&id) {
        state.runtime.update_catalog_session(session);
    }
    ok(json!({"restarted":true,"id":id}))
}
async fn release_all(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Api {
    require(&state, &headers)?;
    state.locals.write().unwrap().clear();
    if let Err(e) = state.runtime.terminals.stop_all() {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    for kind in [AgentKind::Local, AgentKind::Codex, AgentKind::Command] {
        let rows = state.runtime.catalog_state(kind).rows;
        for mut row in rows {
            row.status = "ended".into();
            state.runtime.update_catalog_session(row);
        }
        state.runtime.catalog_changed(kind);
    }
    for session in state.remote_sessions.write().unwrap().iter_mut() {
        let _ = state.runtime.remote.send(
            &session.host_id,
            json!({"type":"pty.stop","session_id":session.id}),
        );
        session.status = "ended".into();
        session.updated_at = chrono::Utc::now();
        state.runtime.update_catalog_session(session.clone());
    }
    if let Err(error) = persist_remote_sessions(&state) {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, error);
    }
    ok(json!({"released":true}))
}

#[derive(Deserialize)]
struct CreateAgent {
    workspace: String,
    #[serde(default)]
    host_id: String,
    #[serde(default)]
    agent_id: String,
    #[serde(default)]
    yolo: bool,
    launch_args: Option<Vec<String>>,
    #[serde(default)]
    title: String,
}

fn command_spec(
    session: &Session,
    settings: &AgentSettings,
) -> Result<(String, Vec<String>, serde_json::Map<String, Value>)> {
    let (program, args, env) = match session.kind {
        AgentKind::Codex => {
            let mut args = Vec::new();
            if session.yolo {
                args.push("--yolo".to_string());
            }
            let custom = if session.launch_args.is_empty() {
                &settings.codex_args
            } else {
                &session.launch_args
            };
            args.extend(custom.iter().cloned());
            (
                if !session.host_id.is_empty() || settings.codex_bin.is_empty() {
                    "codex".into()
                } else {
                    settings.codex_bin.clone()
                },
                args,
                settings.codex_env.clone(),
            )
        }
        AgentKind::Command => {
            let config = settings
                .command_configs
                .iter()
                .find(|item| item.id == session.agent_id)
                .ok_or_else(|| anyhow!("启动配置不存在"))?;
            let mut args = config.args.clone();
            args.extend(session.launch_args.clone());
            (config.program.clone(), args, config.env.clone())
        }
        AgentKind::Local => return Err(anyhow!("本地终端不通过远程启动配置运行")),
    };
    let mut environment = serde_json::Map::new();
    for item in env {
        environment.insert(item.key, Value::String(item.value));
    }
    Ok((program, args, environment))
}

fn persist_remote_sessions(state: &AppState) -> Result<()> {
    state.store.put(
        "remote_sessions",
        "all",
        &*state.remote_sessions.read().unwrap(),
    )
}

fn modify_remote_sessions<T>(
    state: &AppState,
    update: impl FnOnce(&mut Vec<Session>) -> Result<T>,
) -> Result<T> {
    let mut current = state.remote_sessions.write().unwrap();
    let mut next = current.clone();
    let result = update(&mut next)?;
    state.store.put("remote_sessions", "all", &next)?;
    *current = next;
    Ok(result)
}

fn update_remote_session_status(
    sessions: &mut [Session],
    host_id: &str,
    session_id: &str,
    run_id: &str,
    status: &str,
) -> Option<(Session, bool)> {
    let session = sessions.iter_mut().find(|session| {
        session.id == session_id && session.host_id == host_id && session.run_id == run_id
    })?;
    if session.status == status {
        return Some((session.clone(), false));
    }
    session.status = status.into();
    session.updated_at = chrono::Utc::now();
    Some((session.clone(), true))
}

async fn stop_remote_session(state: &AppState, session: &Session) -> Result<()> {
    stop_remote_sessions(state, std::slice::from_ref(session)).await
}

async fn stop_remote_sessions(state: &AppState, sessions: &[Session]) -> Result<()> {
    let mut pending = Vec::new();
    for session in sessions.iter().filter(|session| session.status != "ended") {
        if !state.runtime.remote.is_connected(&session.host_id) {
            anyhow::bail!("目标主机当前未连接，无法确认终端已停止");
        }
        let events = state.runtime.remote.subscribe(&session.id);
        state.runtime.remote.send(
            &session.host_id,
            json!({"type":"pty.stop","session_id":session.id,"run_id":session.run_id}),
        )?;
        pending.push((session.run_id.clone(), events));
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        for (expected_run_id, events) in &mut pending {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        anyhow::bail!("远程终端事件流已关闭")
                    }
                };
                let Ok(value) = serde_json::from_str::<Value>(&event) else {
                    continue;
                };
                let kind = value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let run_id = value
                    .get("run_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if run_id == expected_run_id && matches!(kind, "pty.stopped" | "pty.exit") {
                    break;
                }
            }
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .map_err(|_| anyhow::anyhow!("等待远程终端停止超时"))??;
    Ok(())
}

fn agent_rows(state: &AppState, kind: AgentKind) -> Vec<Session> {
    let mut rows = state.runtime.catalog_state(kind).rows;
    for session in state
        .remote_sessions
        .read()
        .unwrap()
        .iter()
        .filter(|session| session.kind == kind)
    {
        if let Some(row) = rows.iter_mut().find(|row| row.id == session.id) {
            *row = session.clone();
        } else {
            rows.push(session.clone());
        }
    }
    rows.sort_by_key(|row| std::cmp::Reverse(row.updated_at));
    rows
}

async fn codex_rate_limits(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Api {
    require(&state, &headers)?;
    let runtime = state.runtime.clone();
    match tokio::task::spawn_blocking(move || runtime.codex_rate_limits()).await {
        Ok(Ok(value)) => ok(value),
        Ok(Err(error)) => fail(StatusCode::SERVICE_UNAVAILABLE, error),
        Err(error) => fail(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn agent_list(state: &Arc<AppState>, headers: &HeaderMap, kind: AgentKind) -> Api {
    require(state, headers)?;
    let rows = agent_rows(state, kind);
    if kind == AgentKind::Codex
        && rows.is_empty()
        && state.runtime.catalog_state(kind).last_success_at.is_none()
    {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "Codex 会话目录尚未就绪");
    }
    ok(rows)
}

async fn agent_refresh(state: &Arc<AppState>, headers: &HeaderMap, kind: AgentKind) -> Api {
    require(state, headers)?;
    if kind == AgentKind::Command {
        return ok(agent_rows(state, kind));
    }
    match state.runtime.refresh_async(kind).await {
        Ok(_) => ok(agent_rows(state, kind)),
        Err(error) => fail(StatusCode::SERVICE_UNAVAILABLE, error),
    }
}

fn agent_session(state: &AppState, kind: AgentKind, id: &str) -> Option<Session> {
    if kind == AgentKind::Local {
        return state.locals.read().unwrap().get(id).cloned();
    }
    state
        .remote_sessions
        .read()
        .unwrap()
        .iter()
        .find(|session| session.kind == kind && session.id == id)
        .cloned()
        .or_else(|| state.runtime.session(kind, id).ok())
}

async fn agent_create(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    kind: AgentKind,
    input: CreateAgent,
) -> Api {
    let username = match require(state, headers) {
        Ok(username) => username,
        Err(response) => return Err(response),
    };
    let workspace = input.workspace.trim();
    if workspace.is_empty() || workspace.len() > 4096 {
        return fail(StatusCode::BAD_REQUEST, "workspace is required");
    }
    let settings = merged_settings(state, &username);
    if kind == AgentKind::Codex && !state.runtime.enabled(kind) {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "Codex 已停用");
    }
    if kind == AgentKind::Command {
        if !state.runtime.enabled(kind) {
            return fail(StatusCode::SERVICE_UNAVAILABLE, "通用启动器已停用");
        }
        if !settings
            .command_configs
            .iter()
            .any(|config| config.id == input.agent_id)
        {
            return fail(StatusCode::BAD_REQUEST, "启动配置不存在");
        }
    }
    let workspace = if input.host_id.is_empty() {
        match std::path::absolute(expand_path(workspace)) {
            Ok(path) => path.to_string_lossy().into_owned(),
            Err(_) => return fail(StatusCode::BAD_REQUEST, "invalid workspace"),
        }
    } else {
        workspace.to_string()
    };
    let mut session = Session::new(
        kind,
        workspace,
        if input.title.trim().is_empty() {
            "无标题".into()
        } else {
            input.title.trim().to_string()
        },
    );
    session.host_id = input.host_id;
    session.agent_id = input.agent_id;
    if !session.host_id.is_empty() {
        session.run_id = uuid::Uuid::new_v4().to_string();
    }
    session.yolo = input.yolo;
    session.launch_args = input.launch_args.unwrap_or_default();
    if !valid_args(&session.launch_args) {
        return fail(
            StatusCode::BAD_REQUEST,
            "启动参数最多允许 128 项且参数不能包含 NUL",
        );
    }

    if !session.host_id.is_empty() {
        let hosts = state.hosts.read().unwrap();
        if !hosts.iter().any(|host| host.id == session.host_id) {
            return fail(StatusCode::NOT_FOUND, "注册主机不存在");
        }
        if !state.runtime.remote.is_connected(&session.host_id) {
            return fail(StatusCode::SERVICE_UNAVAILABLE, "目标主机当前未连接");
        }
        let (program, args, env) = match command_spec(&session, &settings) {
            Ok(spec) => spec,
            Err(error) => return fail(StatusCode::BAD_REQUEST, error),
        };
        let command = json!({"type":"pty.open","session_id":session.id,"run_id":session.run_id,"program":program,"args":args,"env":env,"cwd":session.workspace});
        if let Err(error) = modify_remote_sessions(state, |sessions| {
            sessions.push(session.clone());
            Ok(())
        }) {
            return fail(StatusCode::INTERNAL_SERVER_ERROR, error);
        }
        if let Err(error) = state.runtime.remote.send(&session.host_id, command) {
            let _ = modify_remote_sessions(state, |sessions| {
                sessions.retain(|row| row.id != session.id);
                Ok(())
            });
            return fail(StatusCode::SERVICE_UNAVAILABLE, error);
        }
        drop(hosts);
    } else {
        if !state.runtime.available(kind) {
            return fail(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("{} CLI unavailable", kind.as_str()),
            );
        }
        if let Err(error) = state.runtime.start_agent(session.clone()) {
            return fail(StatusCode::INTERNAL_SERVER_ERROR, error);
        }
    }
    state.runtime.update_catalog_session(session.clone());
    Ok((StatusCode::CREATED, Json(session)).into_response())
}

async fn agent_get(state: &Arc<AppState>, headers: &HeaderMap, kind: AgentKind, id: &str) -> Api {
    require(state, headers)?;
    match agent_session(state, kind, id) {
        Some(session) => ok(session),
        None => fail(StatusCode::NOT_FOUND, "session not found"),
    }
}

#[derive(Deserialize)]
struct Rename {
    title: String,
}

async fn agent_rename(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    kind: AgentKind,
    id: &str,
    input: Rename,
) -> Api {
    require(state, headers)?;
    if kind == AgentKind::Codex {
        return fail(StatusCode::CONFLICT, "Codex 原生会话不支持重命名");
    }
    if input.title.trim().is_empty() {
        return fail(StatusCode::BAD_REQUEST, "title is required");
    }
    let Some(mut session) = agent_session(state, kind, id) else {
        return fail(StatusCode::NOT_FOUND, "session not found");
    };
    session.title = input.title.trim().into();
    session.updated_at = chrono::Utc::now();
    if !session.host_id.is_empty() {
        match modify_remote_sessions(state, |sessions| {
            if let Some(row) = sessions.iter_mut().find(|row| row.id == id) {
                *row = session.clone();
                Ok(true)
            } else {
                Ok(false)
            }
        }) {
            Ok(true) => {}
            Ok(false) => return fail(StatusCode::NOT_FOUND, "session not found"),
            Err(error) => return fail(StatusCode::INTERNAL_SERVER_ERROR, error),
        }
    } else {
        state.runtime.terminals.update_session(session.clone());
    }
    state.runtime.update_catalog_session(session.clone());
    ok(session)
}

async fn agent_history(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    kind: AgentKind,
    id: &str,
) -> Api {
    require(state, headers)?;
    let Some(session) = agent_session(state, kind, id) else {
        return fail(StatusCode::NOT_FOUND, "session not found");
    };
    match state.runtime.history(&session) {
        Ok(rows) => ok(rows),
        Err(error) => fail(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn agent_stop(state: &Arc<AppState>, headers: &HeaderMap, kind: AgentKind, id: &str) -> Api {
    require(state, headers)?;
    let Some(mut session) = agent_session(state, kind, id) else {
        return fail(StatusCode::NOT_FOUND, "session not found");
    };
    if !session.host_id.is_empty() {
        if let Err(error) = stop_remote_session(state, &session).await {
            return fail(StatusCode::SERVICE_UNAVAILABLE, error);
        }
        session.status = "ended".into();
        session.updated_at = chrono::Utc::now();
        if let Err(error) = modify_remote_sessions(state, |sessions| {
            if let Some(row) = sessions.iter_mut().find(|row| row.id == id) {
                *row = session.clone();
            }
            Ok(())
        }) {
            return fail(StatusCode::INTERNAL_SERVER_ERROR, error);
        }
    } else {
        if let Err(error) = state.runtime.terminals.stop(id) {
            return fail(StatusCode::INTERNAL_SERVER_ERROR, error);
        }
        if let Some(updated) = agent_session(state, kind, id) {
            session = updated;
        }
        session.status = "ended".into();
    }
    state.runtime.update_catalog_session(session);
    no_content()
}

async fn agent_remove(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    kind: AgentKind,
    id: &str,
) -> Api {
    require(state, headers)?;
    let Some(session) = agent_session(state, kind, id) else {
        return fail(StatusCode::NOT_FOUND, "session not found");
    };
    if !session.host_id.is_empty() {
        if let Err(error) = stop_remote_session(state, &session).await {
            return fail(StatusCode::SERVICE_UNAVAILABLE, error);
        }
        if let Err(error) = modify_remote_sessions(state, |sessions| {
            sessions.retain(|row| row.id != id);
            Ok(())
        }) {
            return fail(StatusCode::INTERNAL_SERVER_ERROR, error);
        }
    } else {
        let _ = state.runtime.terminals.stop(id);
        if let Err(error) = state.runtime.delete_native(&session) {
            return fail(StatusCode::BAD_GATEWAY, error);
        }
    }
    state.runtime.remote.forget_session(id);
    state.runtime.remove_catalog_session(kind, id);
    no_content()
}

macro_rules! kind_handlers {
    ($list:ident,$refresh:ident,$create:ident,$get:ident,$rename:ident,$history:ident,$stop:ident,$remove:ident,$kind:expr) => {
        async fn $list(State(s): State<Arc<AppState>>, h: HeaderMap) -> Api {
            agent_list(&s, &h, $kind).await
        }
        async fn $refresh(State(s): State<Arc<AppState>>, h: HeaderMap) -> Api {
            agent_refresh(&s, &h, $kind).await
        }
        async fn $create(
            State(s): State<Arc<AppState>>,
            h: HeaderMap,
            Json(i): Json<CreateAgent>,
        ) -> Api {
            agent_create(&s, &h, $kind, i).await
        }
        async fn $get(
            State(s): State<Arc<AppState>>,
            h: HeaderMap,
            AxumPath(id): AxumPath<String>,
        ) -> Api {
            agent_get(&s, &h, $kind, &id).await
        }
        async fn $rename(
            State(s): State<Arc<AppState>>,
            h: HeaderMap,
            AxumPath(id): AxumPath<String>,
            Json(i): Json<Rename>,
        ) -> Api {
            agent_rename(&s, &h, $kind, &id, i).await
        }
        async fn $history(
            State(s): State<Arc<AppState>>,
            h: HeaderMap,
            AxumPath(id): AxumPath<String>,
        ) -> Api {
            agent_history(&s, &h, $kind, &id).await
        }
        async fn $stop(
            State(s): State<Arc<AppState>>,
            h: HeaderMap,
            AxumPath(id): AxumPath<String>,
        ) -> Api {
            agent_stop(&s, &h, $kind, &id).await
        }
        async fn $remove(
            State(s): State<Arc<AppState>>,
            h: HeaderMap,
            AxumPath(id): AxumPath<String>,
        ) -> Api {
            agent_remove(&s, &h, $kind, &id).await
        }
    };
}
kind_handlers!(
    list_codex,
    refresh_codex,
    create_codex,
    get_codex,
    rename_codex,
    history_codex,
    stop_codex,
    remove_codex,
    AgentKind::Codex
);
kind_handlers!(
    list_command,
    refresh_command,
    create_command,
    get_command,
    rename_command,
    history_command,
    stop_command,
    remove_command,
    AgentKind::Command
);

async fn local_terminal(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    ws: WebSocketUpgrade,
) -> Api {
    session_terminal(state, headers, id, ws, AgentKind::Local).await
}
async fn codex_terminal(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    ws: WebSocketUpgrade,
) -> Api {
    session_terminal(state, headers, id, ws, AgentKind::Codex).await
}
async fn command_terminal(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    ws: WebSocketUpgrade,
) -> Api {
    session_terminal(state, headers, id, ws, AgentKind::Command).await
}
async fn session_terminal(
    state: Arc<AppState>,
    headers: HeaderMap,
    id: String,
    ws: WebSocketUpgrade,
    kind: AgentKind,
) -> Api {
    let username = require(&state, &headers)?;
    same_origin(&headers)?;
    let Some(session) = find_terminal_session(&state, kind, &id) else {
        return fail(StatusCode::NOT_FOUND, "session not found");
    };
    if !session.host_id.is_empty() {
        if !state.runtime.remote.is_connected(&session.host_id) {
            return fail(StatusCode::SERVICE_UNAVAILABLE, "目标主机当前未连接");
        }
        let auth_headers = headers.clone();
        return Ok(ws
            .on_upgrade(move |socket| remote_terminal_socket(socket, state, auth_headers, session))
            .into_response());
    }
    if !state.runtime.terminals.running(&id) {
        let result = match kind {
            AgentKind::Local => state
                .runtime
                .start_local(session, &merged_settings(&state, &username).local_profiles),
            _ => state.runtime.start_agent(session),
        };
        if let Err(error) = result {
            return fail(StatusCode::INTERNAL_SERVER_ERROR, error);
        }
    }
    let auth_headers = headers.clone();
    Ok(ws
        .on_upgrade(move |socket| terminal_socket(socket, state, auth_headers, id))
        .into_response())
}
fn find_terminal_session(state: &AppState, kind: AgentKind, id: &str) -> Option<Session> {
    agent_session(state, kind, id)
}

async fn client_connect(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    ws: WebSocketUpgrade,
) -> Api {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let Some(token) = token else {
        return fail(StatusCode::UNAUTHORIZED, "client token required");
    };
    let host = state
        .hosts
        .read()
        .unwrap()
        .iter()
        .find(|host| host.id == id)
        .cloned();
    let Some(mut host) = host.filter(|host| host.token_hash == token_hash(token)) else {
        return fail(StatusCode::UNAUTHORIZED, "invalid client token");
    };
    let platform = headers
        .get("x-jian-platform")
        .and_then(|value| value.to_str().ok())
        .filter(|platform| platform.len() <= 32);
    let home = headers
        .get("x-jian-home")
        .and_then(|value| value.to_str().ok())
        .filter(|home| home.len() <= 4096);
    if platform.is_some() || home.is_some() {
        let mut hosts = state.hosts.write().unwrap();
        let mut next = hosts.clone();
        {
            let Some(updated) = next.iter_mut().find(|registered| registered.id == id) else {
                return fail(StatusCode::NOT_FOUND, "主机不存在");
            };
            if updated.token_hash != token_hash(token) {
                return fail(StatusCode::UNAUTHORIZED, "invalid client token");
            }
            if let Some(platform) = platform {
                updated.platform = platform.to_string();
            }
            if let Some(home) = home {
                updated.home = home.to_string();
            }
        }
        let Some(updated) = next.iter().find(|registered| registered.id == id).cloned() else {
            return fail(StatusCode::NOT_FOUND, "主机不存在");
        };
        if let Err(error) = save_hosts(&state, &next) {
            return fail(StatusCode::INTERNAL_SERVER_ERROR, error);
        }
        host = updated;
        *hosts = next;
    }
    Ok(ws
        .on_upgrade(move |socket| remote_client_socket(socket, state, host))
        .into_response())
}

async fn remote_client_socket(socket: WebSocket, state: Arc<AppState>, host: RegisteredHost) {
    let (connection_id, mut commands) = {
        let hosts = state.hosts.read().unwrap();
        let authorized = hosts
            .iter()
            .any(|current| current.id == host.id && current.token_hash == host.token_hash);
        if !authorized {
            return;
        }
        state.runtime.remote.connect(host.id.clone())
    };
    let (mut sender, mut receiver) = socket.split();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(25));
    let mut handshaken = false;
    let handshake_timeout = tokio::time::sleep(Duration::from_secs(10));
    tokio::pin!(handshake_timeout);
    loop {
        tokio::select! {
            _ = &mut handshake_timeout, if !handshaken => break,
            _ = heartbeat.tick() => {
                if sender.send(WsMessage::Ping(Vec::new().into())).await.is_err() { break; }
            }
            command = commands.recv() => match command {
                Some(text) => {
                    let revoke = serde_json::from_str::<Value>(&text).ok().and_then(|value| value.get("type").and_then(Value::as_str).map(str::to_owned)).as_deref() == Some("client.revoke");
                    if sender.send(WsMessage::Text(text.into())).await.is_err() || revoke { break; }
                }
                None => break,
            },
            message = receiver.next() => match message {
                Some(Ok(WsMessage::Text(text))) => {
                    if !state.runtime.remote.owns_connection(&host.id, &connection_id) {
                        break;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                    match value.get("type").and_then(Value::as_str) {
                        Some("client.hello") => {
                            if value.get("protocol").and_then(Value::as_u64) != Some(1) {
                                let _ = sender.send(WsMessage::Text(json!({"type":"client.incompatible","protocol":1}).to_string().into())).await;
                                break;
                            }
                            handshaken = true;
                            let platform = value.get("platform").and_then(Value::as_str).filter(|value| value.len() <= 32);
                            let home = value.get("home").and_then(Value::as_str).filter(|value| value.len() <= 4096);
                            if platform.is_some() || home.is_some() {
                                let mut hosts = state.hosts.write().unwrap();
                                let mut next = hosts.clone();
                                if let Some(current) = next.iter_mut().find(|current| current.id == host.id) {
                                    let changed = platform.is_some_and(|value| current.platform != value)
                                        || home.is_some_and(|value| current.home != value);
                                    if let Some(platform) = platform { current.platform = platform.to_string(); }
                                    if let Some(home) = home { current.home = home.to_string(); }
                                    if changed {
                                        match save_hosts(&state, &next) {
                                            Ok(()) => *hosts = next,
                                            Err(error) => tracing::error!(%error, "could not persist remote host details"),
                                        }
                                    }
                                }
                            }
                            let active = value.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter_map(|value| {
                                Some((value.get("session_id")?.as_str()?.to_owned(), value.get("run_id")?.as_str()?.to_owned()))
                            }).collect::<HashMap<_, _>>();
                            let reconciled = modify_remote_sessions(&state, |sessions| {
                                let mut changed = Vec::new();
                                let mut stale = Vec::new();
                                for session in sessions.iter_mut().filter(|session| session.host_id == host.id) {
                                    let old_status = session.status.clone();
                                    let old_run = session.run_id.clone();
                                    if let Some(run_id) = active.get(&session.id) {
                                        if session.run_id.is_empty() {
                                            session.run_id = run_id.clone();
                                        }
                                        if session.run_id == *run_id {
                                            session.status = "running".into();
                                        } else {
                                            stale.push((session.id.clone(), run_id.clone()));
                                            session.status = "ended".into();
                                        }
                                    } else {
                                        session.status = "ended".into();
                                    }
                                    if session.status != old_status || session.run_id != old_run {
                                        session.updated_at = chrono::Utc::now();
                                        changed.push(session.clone());
                                    }
                                }
                                Ok((changed, stale))
                            });
                            match reconciled {
                                Ok((changed, stale)) => {
                                    for session in changed { state.runtime.update_catalog_session(session); }
                                    for (session_id, run_id) in stale {
                                        let _ = state.runtime.remote.send(&host.id, json!({"type":"pty.stop","session_id":session_id,"run_id":run_id}));
                                    }
                                }
                                Err(error) => tracing::error!(%error, "could not reconcile remote sessions"),
                            }
                        }
                        Some("workspace.browse.result" | "workspace.browse.error") if handshaken => {
                            let request_id = value.get("request_id").and_then(Value::as_str).unwrap_or_default().to_owned();
                            if !request_id.is_empty() && request_id.len() <= 64 {
                                state.runtime.remote.respond(&host.id, &request_id, value);
                            }
                        }
                        Some("pty.output" | "pty.exit" | "pty.stopped" | "pty.input.error" | "session.started" | "session.replay.complete") if handshaken => {
                            let session_id = value.get("session_id").and_then(Value::as_str).unwrap_or_default();
                            let run_id = value.get("run_id").and_then(Value::as_str).unwrap_or_default();
                            if session_id.is_empty() || run_id.is_empty() { continue; }
                            let event_type = value.get("type").and_then(Value::as_str).unwrap_or_default();
                            let status_update = if matches!(event_type, "pty.exit" | "pty.stopped") {
                                Some("ended")
                            } else if event_type == "session.started" {
                                Some(if value.pointer("/payload/running").and_then(Value::as_bool).unwrap_or(false) { "running" } else { "ended" })
                            } else { None };
                            let updated = if let Some(status) = status_update {
                                match modify_remote_sessions(&state, |sessions| {
                                    Ok(update_remote_session_status(sessions, &host.id, session_id, run_id, status))
                                }) {
                                    Ok(session) => session,
                                    Err(error) => { tracing::error!(%error, "could not persist remote session state"); continue; }
                                }
                            } else {
                                state.remote_sessions.read().unwrap().iter().find(|session| session.id == session_id && session.host_id == host.id && session.run_id == run_id).cloned().map(|session| (session, false))
                            };
                            let Some((session, changed)) = updated else { continue; };
                            if changed {
                                state.runtime.update_catalog_session(session.clone());
                            }
                            state.runtime.remote.publish(session_id, text.to_string());
                        }
                        _ => {}
                    }
                }
                Some(Ok(WsMessage::Ping(data))) => { let _ = sender.send(WsMessage::Pong(data)).await; }
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
    if state.runtime.remote.disconnect(&host.id, &connection_id) {
        match modify_remote_sessions(&state, |sessions| {
            let mut changed = Vec::new();
            for session in sessions
                .iter_mut()
                .filter(|session| session.host_id == host.id && session.status == "running")
            {
                session.status = "offline".into();
                session.updated_at = chrono::Utc::now();
                changed.push(session.clone());
            }
            Ok(changed)
        }) {
            Ok(changed) => {
                for session in changed {
                    state.runtime.update_catalog_session(session);
                }
            }
            Err(error) => tracing::error!(%error, "could not mark remote sessions offline"),
        }
    }
}

async fn remote_terminal_socket(
    socket: WebSocket,
    state: Arc<AppState>,
    headers: HeaderMap,
    session: Session,
) {
    let session_id = session.id.clone();
    let host_id = session.host_id.clone();
    let mut attach_id = uuid::Uuid::new_v4().to_string();
    let mut events = state.runtime.remote.subscribe(&session_id);
    let _ = state.runtime.remote.send(
        &host_id,
        json!({"type":"pty.attach","session_id":session_id,"run_id":session.run_id,"attach_id":attach_id}),
    );
    let mut replaying = true;
    let mut buffered: Vec<String> = Vec::new();
    let mut connection_check = tokio::time::interval(Duration::from_secs(1));
    let connection_id = uuid::Uuid::new_v4().to_string();
    let mut owns_resize = claim_resize_owner(
        &mut state.resize_owners.lock().unwrap(),
        &session_id,
        &connection_id,
    );
    let (mut sender, mut receiver) = socket.split();
    loop {
        tokio::select! {
            _ = connection_check.tick() => {
                if !state.runtime.remote.is_connected(&host_id) {
                    let _ = sender.send(WsMessage::Text(json!({"session_id":session_id,"run_id":session.run_id,"seq":0,"type":"session.disconnected","payload":{}}).to_string().into())).await;
                    break;
                }
            }
            event = events.recv() => match event {
                Ok(text) => {
                    let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                    if value.get("run_id").and_then(Value::as_str) != Some(session.run_id.as_str()) { continue; }
                    let event_attach = value.get("attach_id").and_then(Value::as_str);
                    if let Some(event_attach) = event_attach {
                        if event_attach != attach_id { continue; }
                        if value.get("type").and_then(Value::as_str) == Some("session.replay.complete") {
                            let replay_seq = value.get("seq").and_then(Value::as_u64).unwrap_or(0);
                            replaying = false;
                            if sender.send(WsMessage::Text(text.clone().into())).await.is_err() { break; }
                            for queued in buffered.drain(..) {
                                let Ok(queued_value) = serde_json::from_str::<Value>(&queued) else { continue; };
                                let seq = queued_value.get("seq").and_then(Value::as_u64).unwrap_or(0);
                                if seq > replay_seq && sender.send(WsMessage::Text(queued.into())).await.is_err() { break; }
                            }
                            continue;
                        }
                        if sender.send(WsMessage::Text(text.into())).await.is_err() { break; }
                    } else if replaying && value.get("type").and_then(Value::as_str) != Some("pty.stopped") {
                        if buffered.len() < 128 { buffered.push(text.to_string()); }
                    } else if sender.send(WsMessage::Text(text.into())).await.is_err() { break; }
                },
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    attach_id = uuid::Uuid::new_v4().to_string();
                    replaying = true;
                    buffered.clear();
                    let _ = state.runtime.remote.send(&host_id, json!({"type":"pty.attach","session_id":session_id,"run_id":session.run_id,"attach_id":attach_id}));
                },
                Err(_) => break,
            },
            message = receiver.next() => match message {
                Some(Ok(WsMessage::Text(text))) => {
                    if current(&state, &headers).is_none() {
                        let _ = sender.send(WsMessage::Text(json!({"session_id":session_id,"run_id":session.run_id,"seq":0,"type":"auth.expired","payload":{}}).to_string().into())).await;
                        break;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                    let command = match value.get("type").and_then(Value::as_str) {
                        Some("input") => value.get("data").and_then(Value::as_str).filter(|data| data.len() <= 64 * 1024).map(|data| json!({"type":"pty.input","session_id":session_id,"run_id":session.run_id,"data":data})),
                        Some("resize") => {
                            if let (Some(cols), Some(rows)) = (value.get("cols").and_then(Value::as_u64).and_then(|v| u16::try_from(v).ok()), value.get("rows").and_then(Value::as_u64).and_then(|v| u16::try_from(v).ok())) {
                                if !owns_resize {
                                    owns_resize = claim_resize_owner(&mut state.resize_owners.lock().unwrap(), &session_id, &connection_id);
                                }
                                owns_resize.then(|| json!({"type":"pty.resize","session_id":session_id,"run_id":session.run_id,"cols":cols,"rows":rows}))
                            } else { None }
                        }
                        Some("interrupt") => Some(json!({"type":"pty.interrupt","session_id":session_id,"run_id":session.run_id})),
                        Some("attachment") => value.get("data").and_then(Value::as_str).filter(|data| data.len() <= (16_usize * 1024 * 1024).div_ceil(3) * 4).map(|data| json!({"type":"pty.attachment","session_id":session_id,"run_id":session.run_id,"name":value.get("name").and_then(Value::as_str).unwrap_or("attachment.bin"),"data":data})),
                        Some("ping") => {
                            let _ = sender.send(WsMessage::Text(json!({"type":"pong"}).to_string().into())).await;
                            None
                        }
                        _ => None,
                    };
                    if let Some(command) = command
                        && state.runtime.remote.send(&host_id, command).is_err()
                    {
                        let _ = sender.send(WsMessage::Text(json!({"session_id":session_id,"seq":0,"type":"session.disconnected","payload":{}}).to_string().into())).await;
                        break;
                    }
                }
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
    if owns_resize {
        let mut owners = state.resize_owners.lock().unwrap();
        if owners.get(&session_id) == Some(&connection_id) {
            owners.remove(&session_id);
        }
    }
}

fn same_origin(headers: &HeaderMap) -> std::result::Result<(), Response> {
    if let (Some(origin), Some(host)) = (
        headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()),
        headers.get(header::HOST).and_then(|v| v.to_str().ok()),
    ) && origin
        .parse::<Uri>()
        .ok()
        .and_then(|uri| uri.authority().map(|value| value.as_str() == host))
        != Some(true)
    {
        return Err(response(
            StatusCode::FORBIDDEN,
            json!({"error":"invalid origin"}),
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
struct RpcRequest {
    id: u64,
    method: String,
    path: String,
    body: Option<Value>,
}

async fn api_websocket(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Api {
    let username = require(&state, &headers)?;
    same_origin(&headers)?;
    let token = cookie(&headers);
    let secure_cookie = state.secure_cookie;
    let mut response = ws
        .on_upgrade(move |socket| api_socket(socket, state, headers, username))
        .into_response();
    if let Some(token) = token {
        response.headers_mut().insert(
            header::SET_COOKIE,
            set_cookie(&token, secure_cookie, SESSION_TTL_SECS as i32),
        );
    }
    Ok(response)
}

async fn api_socket(socket: WebSocket, state: Arc<AppState>, headers: HeaderMap, username: String) {
    let (mut sender, mut receiver) = socket.split();
    let (outgoing, mut replies) = mpsc::channel::<WsMessage>(32);
    let api = api_routes(state.clone());
    let inflight = Arc::new(tokio::sync::Semaphore::new(16));
    let writer = tokio::spawn(async move {
        let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
        loop {
            tokio::select! {
                _ = heartbeat.tick() => if sender.send(WsMessage::Ping(Vec::new().into())).await.is_err() { break },
                message = replies.recv() => match message {
                    Some(message) => if sender.send(message).await.is_err() { break },
                    None => break,
                }
            }
        }
    });
    let mut updates = state.quick_note_updates.subscribe();
    let mut catalog_updates = state.runtime.catalog_updates.subscribe();
    let outgoing_notifications = outgoing.clone();
    let notifications = tokio::spawn(async move {
        loop {
            let message = tokio::select! {
                event = updates.recv() => match event {
                    Ok(event) if event.username == username => json!({"type":"quick-note.update","update":event.update}),
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                },
                event = catalog_updates.recv() => match event {
                    Ok((area, revision)) => json!({"type":"sessions.catalog.changed","area":area,"revision":revision}),
                    Err(broadcast::error::RecvError::Lagged(_)) => json!({"type":"sessions.catalog.resync"}),
                    Err(_) => break,
                },
            };
            if outgoing_notifications
                .send(WsMessage::Text(message.to_string().into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });
    while let Some(Ok(message)) = receiver.next().await {
        let WsMessage::Text(text) = message else {
            if matches!(message, WsMessage::Close(_)) {
                break;
            }
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("ping") {
            if current(&state, &headers).is_none() {
                let _ = outgoing
                    .send(WsMessage::Text(
                        json!({"type":"auth.expired"}).to_string().into(),
                    ))
                    .await;
                break;
            }
            let _ = outgoing
                .send(WsMessage::Text(json!({"type":"pong"}).to_string().into()))
                .await;
            continue;
        }
        let Ok(input) = serde_json::from_value::<RpcRequest>(value) else {
            continue;
        };
        let permit = match inflight.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                let _ = outgoing.send(WsMessage::Text(json!({"id":input.id,"status":503,"body":{"error":"too many concurrent API requests"}}).to_string().into())).await;
                continue;
            }
        };
        let (api, headers, outgoing) = (api.clone(), headers.clone(), outgoing.clone());
        tokio::spawn(async move {
            let _permit = permit;
            let reply = rpc_response(api, headers, input).await;
            let _ = outgoing
                .send(WsMessage::Text(reply.to_string().into()))
                .await;
        });
    }
    writer.abort();
    notifications.abort();
}

async fn rpc_response(api: Router, headers: HeaderMap, input: RpcRequest) -> Value {
    let bad_request = |error: &str| json!({"id":input.id,"status":400,"body":{"error":error}});
    let (method, uri) = match rpc_target(&input.method, &input.path) {
        Ok(target) => target,
        Err(error) => return bad_request(error),
    };
    let Ok(mut request) = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            input.body.map(|body| body.to_string()).unwrap_or_default(),
        ))
    else {
        return bad_request("invalid API request");
    };
    if let Some(cookie) = headers.get(header::COOKIE) {
        request.headers_mut().insert(header::COOKIE, cookie.clone());
    }
    let response = api.oneshot(request).await.unwrap();
    let (parts, body) = response.into_parts();
    let bytes = match to_bytes(body, 16 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(error) => return json!({"id":input.id,"status":502,"body":{"error":error.to_string()}}),
    };
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"error":"invalid server response"}))
    };
    json!({"id":input.id,"status":parts.status.as_u16(),"body":body})
}

fn rpc_target(method: &str, path: &str) -> std::result::Result<(Method, Uri), &'static str> {
    if !path.starts_with('/') || path.starts_with("//") || path == "/ws" {
        return Err("invalid API path");
    }
    let method = method
        .parse::<Method>()
        .map_err(|_| "invalid HTTP method")?;
    if !matches!(
        method,
        Method::GET | Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) {
        return Err("unsupported HTTP method");
    }
    let uri = format!("/api{path}")
        .parse::<Uri>()
        .map_err(|_| "invalid API request")?;
    Ok((method, uri))
}

fn claim_resize_owner(
    owners: &mut HashMap<String, String>,
    session_id: &str,
    connection_id: &str,
) -> bool {
    if owners.contains_key(session_id) {
        false
    } else {
        owners.insert(session_id.into(), connection_id.into());
        true
    }
}

async fn terminal_socket(socket: WebSocket, state: Arc<AppState>, headers: HeaderMap, id: String) {
    let Ok((buffer, mut events, _guard)) = state.runtime.terminals.subscribe(&id) else {
        return;
    };
    let connection_id = uuid::Uuid::new_v4().to_string();
    let mut owns_resize = claim_resize_owner(
        &mut state.resize_owners.lock().unwrap(),
        &id,
        &connection_id,
    );
    let (mut sender, mut receiver) = socket.split();
    if !buffer.is_empty() {
        let _ = sender
            .send(WsMessage::Text(
                json!({"session_id":id,"seq":0,"type":"pty.output","payload":String::from_utf8_lossy(&buffer)})
                    .to_string()
                    .into(),
            ))
            .await;
    }
    let _ = sender
        .send(WsMessage::Text(
            json!({"session_id":id,"seq":0,"type":"session.replay.complete","payload":{}})
                .to_string()
                .into(),
        ))
        .await;
    let _ = sender
        .send(WsMessage::Text(
            json!({"session_id":id,"seq":0,"type":"session.started","payload":{"running":true}})
                .to_string()
                .into(),
        ))
        .await;
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(event) => {
                    let Ok(text) = serde_json::to_string(&event) else { continue };
                    if sender.send(WsMessage::Text(text.into())).await.is_err() { break }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            },
            message = receiver.next() => match message {
                Some(Ok(WsMessage::Text(text))) => {
                    if current(&state, &headers).is_none() {
                        let _ = sender.send(WsMessage::Text(json!({"session_id":id,"seq":0,"type":"auth.expired","payload":{}}).to_string().into())).await;
                        break;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                    match value.get("type").and_then(Value::as_str) {
                        Some("input") => {
                            if let Some(data) = value.get("data").and_then(Value::as_str) {
                                let _ = state.runtime.terminals.send(&id, data);
                            }
                        }
                        Some("attachment") => {
                            let Some(data) = value.get("data").and_then(Value::as_str) else { continue };
                            if data.len() > 16 * 1024 * 1024 { continue; }
                            let Ok(bytes) = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data) else { continue };
                            let extension = value.get("name").and_then(Value::as_str).and_then(|name| std::path::Path::new(name).extension()).and_then(|ext| ext.to_str()).filter(|ext| ext.len() <= 10).unwrap_or("bin");
                            let directory = std::env::temp_dir().join("jian-attachments");
                            if std::fs::create_dir_all(&directory).is_err() { continue; }
                            let path = directory.join(format!("{}.{}", uuid::Uuid::new_v4(), extension));
                            if std::fs::write(&path, bytes).is_ok() {
                                let _ = state.runtime.terminals.send(&id, &format!("{} ", path.display()));
                            }
                        }
                        Some("resize") => {
                            if let (Some(cols), Some(rows)) = (
                                value.get("cols").and_then(Value::as_u64).and_then(|v| u16::try_from(v).ok()),
                                value.get("rows").and_then(Value::as_u64).and_then(|v| u16::try_from(v).ok()),
                            ) {
                                if !owns_resize {
                                    owns_resize = claim_resize_owner(
                                        &mut state.resize_owners.lock().unwrap(),
                                        &id,
                                        &connection_id,
                                    );
                                }
                                if owns_resize {
                                    let _ = state.runtime.terminals.resize(&id, cols, rows);
                                }
                            }
                        }
                        Some("interrupt") => { let _ = state.runtime.terminals.send(&id, "\x03"); }
                        Some("ping") => {
                            let _ = current(&state, &headers);
                            match sender.send(WsMessage::Text(json!({"type":"pong"}).to_string().into())).await {
                            Ok(()) => {}
                            Err(_) => break,
                            }
                        }
                        _ => {}
                    }
                }
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
    if owns_resize {
        let mut owners = state.resize_owners.lock().unwrap();
        if owners.get(&id) == Some(&connection_id) {
            owners.remove(&id);
        }
    }
}

async fn static_asset(uri: Uri) -> Response {
    let path = uri.path();
    if path == "/api" || path.starts_with("/api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let requested = path.trim_start_matches('/');
    let requested = if requested.is_empty() {
        "index.html"
    } else {
        requested
    };
    let (name, file) = match Assets::get(requested) {
        Some(file) => (requested, file),
        None if std::path::Path::new(requested)
            .file_name()
            .is_some_and(|name| !name.to_string_lossy().contains('.')) =>
        {
            let Some(file) = Assets::get("index.html") else {
                return StatusCode::NOT_FOUND.into_response();
            };
            ("index.html", file)
        }
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    let cache = if name == "index.html" || name == "sw.js" {
        "no-cache"
    } else if name.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=300"
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CACHE_CONTROL, cache)
        .body(Body::from(file.data.into_owned()))
        .unwrap()
}
fn expand_path(value: &str) -> PathBuf {
    if value == "~" {
        dirs_home()
    } else if let Some(rest) = value.strip_prefix("~/") {
        dirs_home().join(rest)
    } else {
        PathBuf::from(value)
    }
}
fn normalize_profiles(values: &[String]) -> Vec<String> {
    let mut out = vec![];
    for value in values.iter().map(|v| v.trim()).filter(|v| !v.is_empty()) {
        if !out.iter().any(|v| v == value) {
            out.push(value.to_string())
        }
    }
    out
}
fn clean_args(values: &[String]) -> Vec<String> {
    values.to_vec()
}
fn valid_args(values: &[String]) -> bool {
    values.len() <= 128 && values.iter().all(|value| !value.contains('\0'))
}

#[cfg(test)]
mod argument_tests {
    use super::{clean_args, valid_args};

    #[test]
    fn command_arguments_preserve_whitespace_and_empty_values() {
        let values = vec![" --flag ".into(), String::new(), "two words".into()];
        assert_eq!(clean_args(&values), values);
    }

    #[test]
    fn command_arguments_reject_nul_and_excessive_count() {
        assert!(!valid_args(&["bad\0arg".into()]));
        assert!(!valid_args(&vec![String::new(); 129]));
        assert!(valid_args(&vec![String::new(); 128]));
    }
}

fn parse_config_arg(args: &[String]) -> Result<Option<PathBuf>> {
    if args.is_empty() {
        return Ok(None);
    }
    if args.len() == 2 && (args[0] == "--config" || args[0] == "-c") {
        return Ok(Some(PathBuf::from(&args[1])));
    }
    Err(anyhow!("usage: jian run [--config PATH]"))
}
#[derive(Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
struct ConfigFile {
    bind_ip: IpAddr,
    listen_port: u16,
    #[serde(skip_serializing)]
    #[allow(dead_code)]
    terminal: TerminalConfig,
}
impl Default for ConfigFile {
    fn default() -> Self {
        Self {
            bind_ip: Ipv4Addr::UNSPECIFIED.into(),
            listen_port: 8080,
            terminal: TerminalConfig::default(),
        }
    }
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct TerminalConfig {
    #[allow(dead_code)]
    idle_timeout: String,
    #[allow(dead_code)]
    inactive_sweep_interval: String,
}
fn load_config(path: Option<PathBuf>) -> Result<(ConfigFile, PathBuf)> {
    let path = path.unwrap_or_else(|| dirs_home().join(".local/jian/config.json"));
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()?.join(path)
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?
    }
    if !path.exists() {
        fs::write(&path, serde_json::to_vec_pretty(&ConfigFile::default())?)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?
    }
    let data = fs::read(&path)?;
    let config: ConfigFile =
        serde_json::from_slice(&data).with_context(|| format!("parse config {:?}", path))?;
    Ok((config, path))
}
async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}

const HELP: &str = "Jian — web workspace for local and registered host sessions

Usage:
  jian serve [-c, --config PATH]   Run the Jian server
  jian client connect ...          Connect a registered client host
  jian <command>                   Manage the systemd user service

Commands:
  deploy, dep       Write service configuration and restart Jian
  start             Start jian.service
  stop              Stop jian.service
  restart, rs       Restart jian.service
  status, st        Print service status without opening a pager
  log [-f, --follow]
                    Print service logs; optionally keep following
  version, -V, --version
                    Print the Jian version
  help, -h, --help  Show this help

Configuration:
  Service data:  ~/.local/jian
  Service unit:  ~/.config/systemd/user/jian.service
  Listen address defaults to 0.0.0.0:8080; configure bind_ip and listen_port in config.json.";

const STATUS_ARGS: &[&str] = &["--user", "status", "jian.service", "--no-pager"];

fn cli(args: &[String]) -> Result<()> {
    match args.first().map(|arg| canonical_command(arg)) {
        Some("help" | "--help" | "-h") => {
            println!("{HELP}");
            Ok(())
        }
        Some("version" | "--version" | "-V") if args.len() == 1 => {
            println!("jian {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("status") if args.len() == 1 => run("systemctl", STATUS_ARGS),
        Some(command @ ("start" | "stop" | "restart")) if args.len() == 1 => {
            run("systemctl", &["--user", command, "jian.service"])
        }
        Some("log")
            if args.len() == 1
                || args.len() == 2 && ["-f", "--follow"].contains(&args[1].as_str()) =>
        {
            let mut a = vec!["--user", "-u", "jian.service", "--no-pager"];
            if args.len() == 2 {
                a.push("-f")
            }
            run("journalctl", &a)
        }
        Some("deploy") if args.len() == 1 => deploy(),
        Some("client") if args.len() > 1 => run(
            "jian-client",
            &args[1..].iter().map(String::as_str).collect::<Vec<_>>(),
        ),
        Some(command) => {
            println!("{HELP}");
            Err(anyhow!("unknown command or invalid arguments: {command}"))
        }
        None => {
            println!("{HELP}");
            Ok(())
        }
    }
}

fn canonical_command(command: &str) -> &str {
    match command {
        "dep" => "deploy",
        "rs" => "restart",
        "st" => "status",
        command => command,
    }
}
fn run(program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program)
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow!("{program} exited with {status}"))
    }
}
fn deploy() -> Result<()> {
    let repo = std::env::var_os("JIAN_SOURCE_DIR")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    let data = dirs_home().join(".local/jian");
    let (config, _) = load_config(None)?;
    let units = dirs_home().join(".config/systemd/user");
    fs::create_dir_all(&data)?;
    fs::create_dir_all(&units)?;
    fs::set_permissions(&data, fs::Permissions::from_mode(0o700))?;
    fs::set_permissions(&units, fs::Permissions::from_mode(0o700))?;
    let env_file = data.join("env");
    if !env_file.exists() {
        fs::write(&env_file,b"# Jian defaults. Edit this file to configure the user service.\nJIAN_ADMIN_USER=admin\nJIAN_ADMIN_PASSWORD=change-me\nJIAN_SECURE_COOKIE=0\nJIAN_BASH_BIN=/bin/bash\n")?;
        fs::set_permissions(&env_file, fs::Permissions::from_mode(0o600))?
    }
    let binary = std::env::current_exe()?;
    let mut inherited = String::new();
    for (name, fallback) in [("PATH", ""), ("JIAN_CODEX_BIN", "codex")] {
        let value = std::env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                (!fallback.is_empty())
                    .then(|| find_executable(fallback))
                    .flatten()
            });
        if let Some(value) = value {
            inherited.push_str(&format!("Environment={name}={}\n", systemd_quote(&value)));
        }
    }
    let unit = format!(
        "[Unit]\nDescription=Jian Agent Workbench\nAfter=default.target\n\n[Service]\nType=simple\nWorkingDirectory={}\nExecStart={}\nEnvironmentFile=-%h/.local/jian/env\nEnvironment=JIAN_DB=%h/.local/jian/jian.db\n{}Restart=on-failure\nRestartSec=2s\n\n[Install]\nWantedBy=default.target\n",
        systemd_path(&repo),
        systemd_path(&binary),
        inherited,
    );
    let unit_file = units.join("jian.service");
    write_atomic(&unit_file, unit.as_bytes())?;
    run("systemctl", &["--user", "daemon-reload"])?;
    run("systemctl", &["--user", "enable", "jian.service"])?;
    if run("systemctl", &["--user", "restart", "jian.service"]).is_err() {
        run("systemctl", &["--user", "start", "jian.service"])?
    }
    println!(
        "Jian deployed successfully.\nService: {}\nData:    {}\nListen:  {}:{}",
        unit_file.display(),
        data.display(),
        config.bind_ip,
        config.listen_port,
    );
    Ok(())
}
fn systemd_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('%', "%%")
        .replace('\\', "\\\\")
        .replace(' ', "\\x20")
}
fn systemd_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('%', "%%")
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    )
}
fn find_executable(name: &str) -> Option<String> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(name))
            .find(|candidate| candidate.is_file())
            .map(|candidate| candidate.to_string_lossy().into_owned())
    })
}
fn write_atomic(path: &Path, data: &[u8]) -> Result<()> {
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temporary, data)?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    fs::rename(temporary, path)?;
    Ok(())
}

#[cfg(test)]
mod cli_tests {
    use super::*;
    use yrs::Text;

    #[test]
    fn duplicate_remote_running_status_remains_available_for_event_forwarding() {
        let mut session = Session::new(AgentKind::Codex, "/Users/test".into(), "Codex".into());
        session.host_id = "host-1".into();
        session.run_id = "run-1".into();
        session.status = "running".into();
        let mut sessions = vec![session];
        let session_id = sessions[0].id.clone();

        let event =
            update_remote_session_status(&mut sessions, "host-1", &session_id, "run-1", "running");

        assert_eq!(event.map(|(_, changed)| changed), Some(false));
    }

    #[test]
    fn help_documents_commands_and_aliases() {
        for text in [
            "jian serve",
            "jian client connect",
            "deploy, dep",
            "restart, rs",
            "status, st",
            "without opening a pager",
            "version, -V, --version",
        ] {
            assert!(HELP.contains(text));
        }
    }

    #[test]
    fn config_defaults_to_public_8080() {
        let config: ConfigFile = serde_json::from_str("{}").unwrap();
        assert_eq!(config.bind_ip, IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        assert_eq!(config.listen_port, 8080);
    }

    #[test]
    fn aliases_resolve_to_service_commands() {
        assert_eq!(canonical_command("dep"), "deploy");
        assert_eq!(canonical_command("rs"), "restart");
        assert_eq!(canonical_command("st"), "status");
        assert!(STATUS_ARGS.contains(&"--no-pager"));
    }

    #[test]
    fn resize_owner_allows_only_one_connection_and_releases() {
        let mut owners = HashMap::new();
        assert!(claim_resize_owner(&mut owners, "session", "pc"));
        assert!(!claim_resize_owner(&mut owners, "session", "mobile"));
        owners.remove("session");
        assert!(claim_resize_owner(&mut owners, "session", "mobile"));
    }

    #[test]
    fn terminal_socket_replay_events_precede_session_start() {
        let source = include_str!("main.rs");
        let output = source.find(r#"\"type\":\"pty.output"#).unwrap();
        let complete = source
            .find(r#"\"type\":\"session.replay.complete"#)
            .unwrap();
        let started = source.find(r#"\"type\":\"session.started"#).unwrap();
        assert!(output < complete && complete < started);
    }

    #[tokio::test]
    async fn static_assets_do_not_mask_missing_files_or_api_routes() {
        let missing_asset = static_asset(Uri::from_static("/assets/missing.js")).await;
        let missing_api = static_asset(Uri::from_static("/api/missing")).await;
        let app_route = static_asset(Uri::from_static("/settings")).await;

        assert_eq!(missing_asset.status(), StatusCode::NOT_FOUND);
        assert_eq!(missing_api.status(), StatusCode::NOT_FOUND);
        assert_eq!(app_route.status(), StatusCode::OK);
        assert_eq!(
            app_route.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-cache"
        );
    }

    #[test]
    fn websocket_rpc_accepts_only_relative_api_requests() {
        assert_eq!(rpc_target("POST", "/settings").unwrap().1, "/api/settings");
        assert!(rpc_target("CONNECT", "/settings").is_err());
        assert!(rpc_target("GET", "//example.com").is_err());
        assert!(rpc_target("GET", "/ws").is_err());
    }

    #[test]
    fn websocket_origin_must_match_host() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("localhost:8000"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:8000"),
        );
        assert!(same_origin(&headers).is_ok());
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://example.com"),
        );
        assert!(same_origin(&headers).is_err());
    }

    #[test]
    fn active_auth_session_slides_forward() {
        let root = std::env::temp_dir().join(format!("jian-auth-{}", uuid::Uuid::new_v4()));
        let store = Store::open(root.join("jian.db")).unwrap();
        let token = "test-token";
        let before = chrono::Utc::now() + chrono::Duration::hours(1);
        store
            .put(
                "auth_sessions",
                &token_hash(token),
                &AuthSession {
                    username: "admin".into(),
                    expires: before,
                },
            )
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("jian_session=test-token"),
        );
        let state = AppState {
            store: Arc::new(store),
            runtime: Runtime::new(AgentSettings::default()),
            hosts: RwLock::new(vec![]),
            remote_sessions: RwLock::new(vec![]),
            settings_write: Mutex::new(()),
            locals: RwLock::new(HashMap::new()),
            attempts: Mutex::new(HashMap::new()),
            quick_notes: QuickNoteWorker::start(Arc::new(
                Store::open(root.join("notes.db")).unwrap(),
            ))
            .unwrap(),
            quick_note_updates: broadcast::channel(1).0,
            resize_owners: Mutex::new(HashMap::new()),
            secure_cookie: false,
        };

        assert_eq!(current(&state, &headers).as_deref(), Some("admin"));
        let refreshed: AuthSession = state
            .store
            .get("auth_sessions", &token_hash(token))
            .unwrap();
        assert!(refreshed.expires > before);
        let remaining = refreshed.expires - chrono::Utc::now();
        assert!(remaining > chrono::Duration::days(30) - chrono::Duration::seconds(5));
        assert!(remaining <= chrono::Duration::days(30));
        assert!(
            set_cookie(token, false, SESSION_TTL_SECS as i32)
                .to_str()
                .unwrap()
                .contains("Max-Age=2592000")
        );
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn terminal_routes_share_session_lookup() {
        let root = std::env::temp_dir().join(format!("jian-routes-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Store::open(root.join("jian.db")).unwrap());
        let local = Session::new(AgentKind::Local, "/tmp".into(), "Bash".into());
        let state = AppState {
            store: store.clone(),
            runtime: Runtime::new(AgentSettings::default()),
            hosts: RwLock::new(vec![]),
            remote_sessions: RwLock::new(vec![]),
            settings_write: Mutex::new(()),
            locals: RwLock::new(HashMap::from([(local.id.clone(), local.clone())])),
            attempts: Mutex::new(HashMap::new()),
            quick_notes: QuickNoteWorker::start(store).unwrap(),
            quick_note_updates: broadcast::channel(1).0,
            resize_owners: Mutex::new(HashMap::new()),
            secure_cookie: false,
        };
        assert_eq!(
            find_terminal_session(&state, AgentKind::Local, &local.id)
                .unwrap()
                .id,
            local.id
        );
        assert!(find_terminal_session(&state, AgentKind::Codex, "missing").is_none());
        assert!(find_terminal_session(&state, AgentKind::Command, "missing").is_none());
        let unauthorized = api_routes(Arc::new(state))
            .oneshot(
                Request::builder()
                    .uri("/api/agents/codex/rate-limits")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn releasing_native_terminal_keeps_ended_catalog_row() {
        let root = std::env::temp_dir().join(format!("jian-release-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Store::open(root.join("jian.db")).unwrap());
        store
            .put(
                "auth_sessions",
                &token_hash("test-token"),
                &AuthSession {
                    username: "admin".into(),
                    expires: chrono::Utc::now() + chrono::Duration::days(1),
                },
            )
            .unwrap();
        let runtime = Runtime::new(AgentSettings::default());
        let session = Session::new(AgentKind::Command, "/tmp".into(), "Native".into());
        runtime.update_catalog_session(session.clone());
        runtime
            .terminals
            .start(terminal::TerminalSpec {
                session: session.clone(),
                label: AgentKind::Command,
                cwd: "/tmp".into(),
                argv: vec!["/bin/bash".into(), "-c".into(), "sleep 20".into()],
                env: std::env::vars().map(|(k, v)| format!("{k}={v}")).collect(),
            })
            .unwrap();
        let state = Arc::new(AppState {
            store: store.clone(),
            runtime: runtime.clone(),
            hosts: RwLock::new(vec![]),
            remote_sessions: RwLock::new(vec![]),
            settings_write: Mutex::new(()),
            locals: RwLock::new(HashMap::new()),
            attempts: Mutex::new(HashMap::new()),
            quick_notes: QuickNoteWorker::start(store).unwrap(),
            quick_note_updates: broadcast::channel(1).0,
            resize_owners: Mutex::new(HashMap::new()),
            secure_cookie: false,
        });
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("jian_session=test-token"),
        );
        assert!(
            release_terminal(State(state.clone()), headers, AxumPath(session.id.clone()))
                .await
                .is_ok()
        );
        assert!(!runtime.terminals.running(&session.id));
        let rows = runtime.catalog_state(AgentKind::Command).rows;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, session.id);
        assert_eq!(rows[0].status, "ended");
        drop(state);
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn quick_note_worker_returns_empty_state_without_blocking_runtime() {
        let root = std::env::temp_dir().join(format!("jian-note-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Store::open(root.join("jian.db")).unwrap());
        let worker = QuickNoteWorker::start(store).unwrap();
        let state = tokio::time::timeout(Duration::from_secs(1), worker.get("test".into()))
            .await
            .expect("quick note worker blocked the runtime")
            .unwrap();

        let doc = quick_note_doc(Some(&state)).unwrap();
        let text = doc.get_or_insert_text("body");
        assert_eq!(text.get_string(&doc.transact()), "");
        drop(worker);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn quick_note_updates_merge_and_repeat_idempotently() {
        let left = Doc::with_client_id(1);
        let right = Doc::with_client_id(2);
        left.get_or_insert_text("body")
            .insert(&mut left.transact_mut(), 0, "left");
        right
            .get_or_insert_text("body")
            .insert(&mut right.transact_mut(), 0, "right");
        let left_update = left
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let right_update = right
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let merged = Doc::new();
        merged
            .transact_mut()
            .apply_update(Update::decode_v1(&left_update).unwrap())
            .unwrap();
        merged
            .transact_mut()
            .apply_update(Update::decode_v1(&right_update).unwrap())
            .unwrap();
        merged
            .transact_mut()
            .apply_update(Update::decode_v1(&left_update).unwrap())
            .unwrap();
        assert_eq!(
            merged
                .get_or_insert_text("body")
                .get_string(&merged.transact())
                .chars()
                .count(),
            9
        );
    }

    #[test]
    fn quick_note_update_accepts_standard_and_urlsafe_base64() {
        let bytes = [1, 2, 3, 4];
        assert_eq!(
            decode_quick_note_update(&STANDARD.encode(bytes)).unwrap(),
            bytes
        );
        assert_eq!(
            decode_quick_note_update(&URL_SAFE_NO_PAD.encode(bytes)).unwrap(),
            bytes
        );
    }
}
