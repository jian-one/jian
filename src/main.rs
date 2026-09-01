#![allow(clippy::result_large_err)]

mod model;
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
    model::{AgentKind, AgentSettings, Session},
    runtime::Runtime,
    store::{Store, default_path, dirs_home, token_hash},
};

const COOKIE: &str = "jian_session";
const SESSION_TTL_SECS: i64 = 24 * 60 * 60;
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
    attempts: Mutex<HashMap<String, Vec<SystemTime>>>,
    quick_notes: QuickNoteWorker,
    quick_note_updates: broadcast::Sender<QuickNoteEvent>,
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
        .is_some_and(|arg| !matches!(arg.as_str(), "run" | "--config" | "-c"))
    {
        return cli(&args);
    }
    let args = if args.first().is_some_and(|v| v == "run") {
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
    let settings = store.settings(&username).unwrap_or_default();
    let runtime = Runtime::new(settings);
    runtime.start_cache();
    let quick_notes = QuickNoteWorker::start(store.clone())?;
    let (quick_note_updates, _) = broadcast::channel(64);
    let state = Arc::new(AppState {
        store,
        runtime,
        locals: RwLock::new(HashMap::new()),
        attempts: Mutex::new(HashMap::new()),
        quick_notes,
        quick_note_updates,
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
        .route("/api/local/sessions", post(create_local).get(list_local))
        .route("/api/local/sessions/{id}", delete(remove_local))
        .route("/api/local/sessions/{id}/terminal", get(local_terminal))
        .route("/api/hermes/profiles", get(profiles))
        .route("/api/pi/agents", get(pi_agents))
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
            "/api/agents/hermes/sessions",
            get(list_hermes).post(create_hermes),
        )
        .route("/api/agents/hermes/sessions/cache", get(list_hermes))
        .route("/api/agents/hermes/sessions/refresh", post(refresh_hermes))
        .route(
            "/api/agents/hermes/sessions/{id}",
            get(get_hermes).patch(rename_hermes).delete(remove_hermes),
        )
        .route(
            "/api/agents/hermes/sessions/{id}/history",
            get(history_hermes),
        )
        .route("/api/agents/hermes/sessions/{id}/stop", post(stop_hermes))
        .route(
            "/api/agents/hermes/sessions/{id}/terminal",
            get(hermes_terminal),
        )
        .route("/api/agents/pi/sessions", get(list_pi).post(create_pi))
        .route("/api/agents/pi/sessions/cache", get(list_pi))
        .route("/api/agents/pi/sessions/refresh", post(refresh_pi))
        .route(
            "/api/agents/pi/sessions/{id}",
            get(get_pi).patch(rename_pi).delete(remove_pi),
        )
        .route("/api/agents/pi/sessions/{id}/history", get(history_pi))
        .route("/api/agents/pi/sessions/{id}/stop", post(stop_pi))
        .route("/api/agents/pi/sessions/{id}/terminal", get(pi_terminal))
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
    let mut session: AuthSession = state.store.get("auth_sessions", &key).ok()?;
    if session.expires <= chrono::Utc::now() {
        return None;
    }
    session.expires = chrono::Utc::now() + chrono::Duration::seconds(SESSION_TTL_SECS);
    state.store.put("auth_sessions", &key, &session).ok()?;
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
    let mut attempts = state.attempts.lock().unwrap();
    let recent = attempts.entry(ip).or_default();
    recent.retain(|t| now.duration_since(*t).unwrap_or_default() < Duration::from_secs(60));
    if recent.len() >= 10
        || state
            .store
            .admin_hash(&input.username)
            .is_none_or(|h| !verify(&input.password, &h).unwrap_or(false))
    {
        recent.push(now);
        return fail(StatusCode::UNAUTHORIZED, "invalid credentials");
    }
    recent.clear();
    drop(attempts);
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
    let (settings, available) = settings_view(&state, &username);
    ok(
        json!({"username":username,"settings":settings,"available_profiles":available,"available_pi_agents":state.runtime.pi_agents()}),
    )
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

fn merged_settings(state: &AppState, username: &str) -> AgentSettings {
    let mut defaults = AgentSettings::default();
    if let Some(saved) = state.store.settings(username) {
        if !saved.codex_bin.is_empty() {
            defaults.codex_bin = saved.codex_bin
        }
        if !saved.hermes_bin.is_empty() {
            defaults.hermes_bin = saved.hermes_bin
        }
        if !saved.hermes_home.is_empty() {
            defaults.hermes_home = saved.hermes_home
        }
        if !saved.hermes_profiles.is_empty() {
            defaults.hermes_profiles = saved.hermes_profiles
        }
        if !saved.local_profiles.is_empty() {
            defaults.local_profiles = saved.local_profiles
        }
        defaults.codex_args = saved.codex_args;
        defaults.hermes_args = saved.hermes_args;
        defaults.codex_env = saved.codex_env;
        defaults.hermes_env = saved.hermes_env;
        if !saved.pi_default.is_empty() {
            defaults.pi_default = saved.pi_default;
        }
        defaults.pi_roles = saved.pi_roles;
        defaults.pi_args = saved.pi_args;
        defaults.pi_env = saved.pi_env;
        if saved.agent_toggles_set {
            defaults.codex_enabled = saved.codex_enabled;
            defaults.hermes_enabled = saved.hermes_enabled;
            defaults.pi_enabled = saved.pi_enabled;
            defaults.agent_toggles_set = true;
        }
    }
    defaults.path = std::env::var("PATH").unwrap_or_default();
    defaults
}
fn settings_view(state: &AppState, username: &str) -> (AgentSettings, Vec<String>) {
    let available = state.runtime.available_profiles();
    let mut settings = merged_settings(state, username);
    if settings.hermes_profiles.is_empty() {
        settings.hermes_profiles = available.clone();
    }
    (settings, available)
}
async fn settings(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Api {
    let username = require(&state, &headers)?;
    let (settings, available) = settings_view(&state, &username);
    ok(
        json!({"settings":settings,"available_profiles":available,"available_pi_agents":state.runtime.pi_agents()}),
    )
}
async fn save_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(mut input): Json<AgentSettings>,
) -> Api {
    let username = require(&state, &headers)?;
    let current = merged_settings(&state, &username);
    input.codex_bin = input.codex_bin.trim().to_string();
    input.hermes_bin = input.hermes_bin.trim().to_string();
    input.hermes_home = input.hermes_home.trim().to_string();
    input.pi_default = input.pi_default.trim().to_string();
    if input.codex_bin.is_empty() {
        input.codex_bin = current.codex_bin
    }
    if input.hermes_bin.is_empty() {
        input.hermes_bin = current.hermes_bin
    }
    if input.hermes_home.is_empty() {
        input.hermes_home = current.hermes_home
    }
    if input.pi_default.is_empty() {
        input.pi_default = current.pi_default
    }
    input.path = std::env::var("PATH").unwrap_or_default();
    input.local_enabled = true;
    input.agent_toggles_set = true;
    input.local_profiles = normalize_profiles(&input.local_profiles);
    input.hermes_profiles = normalize_profiles(&input.hermes_profiles);
    let mut role_names = std::collections::HashSet::new();
    if input.pi_roles.iter().any(|role| {
        role.name.trim().is_empty()
            || role.entry.trim().is_empty()
            || role.home.trim().is_empty()
            || role.name.trim() == "default"
    }) {
        return fail(
            StatusCode::BAD_REQUEST,
            "Pi 角色的名称、入口路径和主目录均为必填",
        );
    }
    for role in &mut input.pi_roles {
        role.name = role.name.trim().to_string();
        role.entry = role.entry.trim().to_string();
        role.home = role.home.trim().to_string();
        role_names.insert(role.name.clone());
    }
    if role_names.len() != input.pi_roles.len() {
        return fail(StatusCode::BAD_REQUEST, "Pi 角色名称不能重复");
    }
    input.codex_args = clean_args(&input.codex_args);
    input.hermes_args = clean_args(&input.hermes_args);
    input.pi_args = clean_args(&input.pi_args);
    if let Err(e) = state.store.save_settings(&username, &input) {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    state.runtime.set_settings(input.clone());
    ok(input)
}

#[derive(Deserialize)]
struct BrowseQuery {
    path: Option<String>,
}
async fn browse(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<BrowseQuery>,
) -> Api {
    require(&state, &headers)?;
    let path = expand_path(query.path.as_deref().unwrap_or("~"));
    let path = match fs::canonicalize(&path) {
        Ok(v) => v,
        Err(e) => return fail(StatusCode::BAD_REQUEST, e),
    };
    let entries = match fs::read_dir(&path) {
        Ok(v) => v,
        Err(e) => return fail(StatusCode::BAD_REQUEST, e),
    };
    let values:Vec<_>=entries.flatten().map(|e|json!({"name":e.file_name().to_string_lossy(),"directory":e.file_type().is_ok_and(|t|t.is_dir())})).collect();
    ok(
        json!({"path":path,"parent":path.parent().unwrap_or(Path::new("/")).to_string_lossy(),"entries":values}),
    )
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
    no_content()
}
async fn profiles(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Api {
    require(&state, &headers)?;
    if state.runtime.available(AgentKind::Hermes) {
        ok(state.runtime.profiles())
    } else {
        ok(Vec::<String>::new())
    }
}
async fn pi_agents(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Api {
    require(&state, &headers)?;
    ok(state.runtime.pi_agents())
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
    state.locals.write().unwrap().remove(&id);
    if let Err(e) = state.runtime.terminals.stop(&id) {
        return fail(StatusCode::NOT_FOUND, e);
    }
    ok(json!({"released":true,"id":id}))
}
async fn restart_terminal(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Api {
    require(&state, &headers)?;
    if let Err(e) = state.runtime.restart_terminal(&id) {
        return fail(StatusCode::BAD_REQUEST, e);
    }
    ok(json!({"restarted":true,"id":id}))
}
async fn release_all(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Api {
    require(&state, &headers)?;
    state.locals.write().unwrap().clear();
    if let Err(e) = state.runtime.terminals.stop_all() {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    ok(json!({"released":true}))
}

#[derive(Deserialize)]
struct CreateAgent {
    workspace: String,
    #[serde(default)]
    profile: String,
    #[serde(default)]
    yolo: bool,
    launch_args: Option<Vec<String>>,
    #[serde(default)]
    title: String,
}
async fn agent_list(state: &Arc<AppState>, headers: &HeaderMap, kind: AgentKind) -> Api {
    require(state, headers)?;
    match state.runtime.cached(kind) {
        Ok(v) => ok(v),
        Err(e) => fail(StatusCode::SERVICE_UNAVAILABLE, e),
    }
}
async fn agent_refresh(state: &Arc<AppState>, headers: &HeaderMap, kind: AgentKind) -> Api {
    require(state, headers)?;
    match state.runtime.refresh_async(kind).await {
        Ok(v) => ok(v),
        Err(e) => fail(StatusCode::SERVICE_UNAVAILABLE, e),
    }
}
async fn agent_create(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    kind: AgentKind,
    input: CreateAgent,
) -> Api {
    let username = require(state, headers)?;
    if input.workspace.is_empty() {
        return fail(StatusCode::BAD_REQUEST, "workspace is required");
    }
    if kind == AgentKind::Pi {
        let profile = if input.profile.trim().is_empty() {
            "default"
        } else {
            input.profile.trim()
        };
        if !state.runtime.pi_agents().iter().any(|name| name == profile) {
            return fail(StatusCode::BAD_REQUEST, "Pi 角色不存在");
        }
        if let Some(fixed) = state.runtime.pi_workspace(profile) {
            if expand_path(&input.workspace) != fixed {
                return fail(StatusCode::BAD_REQUEST, "Pi 角色只能使用其角色目录");
            }
        }
    }
    if !state.runtime.available(kind) {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            if kind == AgentKind::Codex {
                "Codex CLI unavailable"
            } else if kind == AgentKind::Hermes {
                "Hermes integration unavailable"
            } else {
                "Pi CLI unavailable"
            },
        );
    }
    let workspace = match std::path::absolute(expand_path(&input.workspace)) {
        Ok(v) => v,
        Err(_) => return fail(StatusCode::BAD_REQUEST, "invalid workspace"),
    };
    let mut session = Session::new(
        kind,
        workspace.to_string_lossy().into_owned(),
        if input.title.is_empty() {
            "无标题".into()
        } else {
            input.title
        },
    );
    session.profile = input.profile;
    session.yolo = input.yolo;
    let settings = merged_settings(state, &username);
    session.launch_args = input.launch_args.unwrap_or_else(|| {
        if kind == AgentKind::Codex {
            settings.codex_args.clone()
        } else {
            settings.hermes_args.clone()
        }
    });
    if let Err(e) = state.runtime.start_agent(session.clone()) {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    Ok((StatusCode::CREATED, Json(session)).into_response())
}
async fn agent_get(state: &Arc<AppState>, headers: &HeaderMap, kind: AgentKind, id: &str) -> Api {
    require(state, headers)?;
    match state.runtime.session(kind, id) {
        Ok(v) => ok(v),
        Err(_) => fail(StatusCode::NOT_FOUND, "session not found"),
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
    let mut session = match state.runtime.session(kind, id) {
        Ok(v) => v,
        Err(_) => return fail(StatusCode::NOT_FOUND, "session not found"),
    };
    let result = if kind == AgentKind::Pi {
        state.runtime.rename_pi(&session, input.title.trim())
    } else {
        state.runtime.rename_hermes(&session, input.title.trim())
    };
    if let Err(e) = result {
        return fail(StatusCode::BAD_GATEWAY, e);
    }
    session.title = input.title.trim().into();
    session.updated_at = chrono::Utc::now();
    ok(session)
}
async fn agent_history(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    kind: AgentKind,
    id: &str,
) -> Api {
    require(state, headers)?;
    let session = match state.runtime.session(kind, id) {
        Ok(v) => v,
        Err(_) => return fail(StatusCode::NOT_FOUND, "session not found"),
    };
    match state.runtime.history(&session) {
        Ok(v) => ok(v),
        Err(e) => fail(
            if kind == AgentKind::Hermes {
                StatusCode::BAD_GATEWAY
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            },
            e,
        ),
    }
}
async fn agent_stop(state: &Arc<AppState>, headers: &HeaderMap, kind: AgentKind, id: &str) -> Api {
    require(state, headers)?;
    if state.runtime.session(kind, id).is_err() {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "session not found");
    }
    if let Err(e) = state.runtime.terminals.stop(id) {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    no_content()
}
async fn agent_remove(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    kind: AgentKind,
    id: &str,
) -> Api {
    require(state, headers)?;
    let session = match state.runtime.session(kind, id) {
        Ok(v) => v,
        Err(_) => return fail(StatusCode::NOT_FOUND, "session not found"),
    };
    let _ = state.runtime.terminals.stop(id);
    if let Err(e) = state.runtime.delete_native(&session) {
        return fail(StatusCode::BAD_GATEWAY, e);
    }
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
    list_hermes,
    refresh_hermes,
    create_hermes,
    get_hermes,
    rename_hermes,
    history_hermes,
    stop_hermes,
    remove_hermes,
    AgentKind::Hermes
);
kind_handlers!(
    list_pi,
    refresh_pi,
    create_pi,
    get_pi,
    rename_pi,
    history_pi,
    stop_pi,
    remove_pi,
    AgentKind::Pi
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
async fn hermes_terminal(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    ws: WebSocketUpgrade,
) -> Api {
    session_terminal(state, headers, id, ws, AgentKind::Hermes).await
}
async fn pi_terminal(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    ws: WebSocketUpgrade,
) -> Api {
    session_terminal(state, headers, id, ws, AgentKind::Pi).await
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
    match kind {
        AgentKind::Local => state.locals.read().unwrap().get(id).cloned(),
        _ => state.runtime.session(kind, id).ok(),
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
    let outgoing_notifications = outgoing.clone();
    let notifications = tokio::spawn(async move {
        while let Ok(event) = updates.recv().await {
            if event.username == username
                && outgoing_notifications
                    .send(WsMessage::Text(
                        json!({"type":"quick-note.update","update":event.update})
                            .to_string()
                            .into(),
                    ))
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
            let _ = current(&state, &headers);
            let _ = outgoing
                .send(WsMessage::Text(json!({"type":"pong"}).to_string().into()))
                .await;
            continue;
        }
        let Ok(input) = serde_json::from_value::<RpcRequest>(value) else {
            continue;
        };
        let (state, headers, outgoing) = (state.clone(), headers.clone(), outgoing.clone());
        tokio::spawn(async move {
            let reply = rpc_response(state, headers, input).await;
            let _ = outgoing
                .send(WsMessage::Text(reply.to_string().into()))
                .await;
        });
    }
    writer.abort();
    notifications.abort();
}

async fn rpc_response(state: Arc<AppState>, headers: HeaderMap, input: RpcRequest) -> Value {
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
    let response = api_routes(state).oneshot(request).await.unwrap();
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, 16 * 1024 * 1024).await.unwrap_or_default();
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

async fn terminal_socket(socket: WebSocket, state: Arc<AppState>, headers: HeaderMap, id: String) {
    let Ok((buffer, mut events, _guard)) = state.runtime.terminals.subscribe(&id) else {
        return;
    };
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
                                let _ = state.runtime.terminals.resize(&id, cols, rows);
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
}

async fn static_asset(uri: Uri) -> Response {
    let mut name = uri.path().trim_start_matches('/').to_string();
    if name.is_empty() {
        name = "index.html".into()
    }
    let asset = Assets::get(&name).or_else(|| Assets::get("index.html"));
    match asset {
        Some(file) => {
            let mime = mime_guess::from_path(&name).first_or_octet_stream();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime.as_ref())
                .body(Body::from(file.data.into_owned()))
                .unwrap()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
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
    values
        .iter()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect()
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

const HELP: &str = "Jian — local workspace for persistent Bash, Codex, and Hermes sessions

Usage:
  jian [run] [-c, --config PATH]   Run the Jian server
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
    for (name, fallback) in [
        ("PATH", ""),
        ("JIAN_CODEX_BIN", "codex"),
        ("JIAN_HERMES_BIN", "hermes"),
    ] {
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
    if let Some(home) = ["JIAN_HERMES_HOME", "HERMES_HOME"].iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
    }) {
        inherited.push_str(&format!(
            "Environment=JIAN_HERMES_HOME={}\n",
            systemd_quote(&home)
        ));
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
    fn help_documents_commands_and_aliases() {
        for text in [
            "jian [run]",
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
    fn terminal_socket_replay_events_precede_session_start() {
        let source = include_str!("main.rs");
        let output = source.find(r#"\"type\":\"pty.output"#).unwrap();
        let complete = source
            .find(r#"\"type\":\"session.replay.complete"#)
            .unwrap();
        let started = source.find(r#"\"type\":\"session.started"#).unwrap();
        assert!(output < complete && complete < started);
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
            locals: RwLock::new(HashMap::new()),
            attempts: Mutex::new(HashMap::new()),
            quick_notes: QuickNoteWorker::start(Arc::new(
                Store::open(root.join("notes.db")).unwrap(),
            ))
            .unwrap(),
            quick_note_updates: broadcast::channel(1).0,
            secure_cookie: false,
        };

        assert_eq!(current(&state, &headers).as_deref(), Some("admin"));
        let refreshed: AuthSession = state
            .store
            .get("auth_sessions", &token_hash(token))
            .unwrap();
        assert!(refreshed.expires > before);
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn terminal_routes_share_session_lookup() {
        let root = std::env::temp_dir().join(format!("jian-routes-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Store::open(root.join("jian.db")).unwrap());
        let local = Session::new(AgentKind::Local, "/tmp".into(), "Bash".into());
        let state = AppState {
            store: store.clone(),
            runtime: Runtime::new(AgentSettings::default()),
            locals: RwLock::new(HashMap::from([(local.id.clone(), local.clone())])),
            attempts: Mutex::new(HashMap::new()),
            quick_notes: QuickNoteWorker::start(store).unwrap(),
            quick_note_updates: broadcast::channel(1).0,
            secure_cookie: false,
        };
        assert_eq!(
            find_terminal_session(&state, AgentKind::Local, &local.id)
                .unwrap()
                .id,
            local.id
        );
        assert!(find_terminal_session(&state, AgentKind::Codex, "missing").is_none());
        assert!(find_terminal_session(&state, AgentKind::Hermes, "missing").is_none());
        drop(state);
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
