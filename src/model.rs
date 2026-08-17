use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    #[default]
    Codex,
    Hermes,
    Local,
}

impl AgentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Hermes => "hermes",
            Self::Local => "local",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub kind: AgentKind,
    #[serde(default)]
    pub native_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub profile: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub src: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub channel: String,
    pub workspace: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub yolo: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub launch_args: Vec<String>,
    pub title: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Session {
    pub fn new(kind: AgentKind, workspace: String, title: String) -> Self {
        let now = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            native_id: String::new(),
            profile: String::new(),
            src: String::new(),
            channel: String::new(),
            workspace,
            yolo: false,
            launch_args: vec![],
            title,
            status: "running".into(),
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Event {
    pub session_id: String,
    pub seq: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct Message {
    pub role: String,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentSettings {
    #[serde(default)]
    pub codex_bin: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub hermes_home: String,
    #[serde(default)]
    pub hermes_bin: String,
    #[serde(default)]
    pub hermes_profiles: Vec<String>,
    #[serde(default)]
    pub local_profiles: Vec<String>,
    #[serde(default)]
    pub codex_args: Vec<String>,
    #[serde(default)]
    pub hermes_args: Vec<String>,
    #[serde(default)]
    pub codex_env: Vec<EnvVar>,
    #[serde(default)]
    pub hermes_env: Vec<EnvVar>,
    #[serde(default)]
    pub local_enabled: bool,
    #[serde(default)]
    pub codex_enabled: bool,
    #[serde(default)]
    pub hermes_enabled: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub agent_toggles_set: bool,
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            codex_bin: env_first(&["JIAN_CODEX_BIN", "CODEX_BIN"]),
            path: std::env::var("PATH").unwrap_or_default(),
            hermes_home: env_first(&["JIAN_HERMES_HOME", "HERMES_HOME"]),
            hermes_bin: env_first(&["JIAN_HERMES_BIN", "HERMES_BIN"]),
            hermes_profiles: split_profiles(
                &std::env::var("JIAN_HERMES_PROFILES").unwrap_or_default(),
            ),
            local_profiles: vec!["~/.bashrc".into()],
            codex_args: vec![],
            hermes_args: vec![],
            codex_env: vec![],
            hermes_env: vec![],
            local_enabled: true,
            codex_enabled: true,
            hermes_enabled: true,
            agent_toggles_set: false,
        }
    }
}

pub fn env_first(names: &[&str]) -> String {
    names
        .iter()
        .find_map(|n| std::env::var(n).ok().filter(|v| !v.trim().is_empty()))
        .unwrap_or_default()
}
pub fn split_profiles(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect()
}
