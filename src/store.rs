use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, anyhow};
use bolt_lite::Bolt;
use jammdb::DB;
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

use crate::model::AgentSettings;

const BUCKETS: &[&str] = &[
    "users",
    "auth_sessions",
    "recent_workspaces",
    "audit_events",
    "runtime_state",
    "monitor_definitions",
    "agent_settings",
    "instance_config",
    "registered_hosts",
    "remote_sessions",
    "quick_notes",
];

#[derive(Clone, Serialize, serde::Deserialize)]
pub struct QuickNote {
    pub state: String,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub version: u8,
}

pub struct Store {
    db: DB,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        }
        migrate_bbolt(path)?;
        let db = DB::open(path).with_context(|| format!("open database {}", path.display()))?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        let tx = db.tx(true)?;
        for name in BUCKETS {
            tx.get_or_create_bucket(*name)?;
        }
        if tx.get_bucket("agent_sessions").is_ok() {
            tx.delete_bucket("agent_sessions")?;
        }
        tx.commit()?;
        Ok(Self { db })
    }

    pub fn put<T: Serialize + ?Sized>(&self, bucket: &str, key: &str, value: &T) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        let tx = self.db.tx(true)?;
        tx.get_bucket(bucket)?.put(key.as_bytes(), bytes)?;
        tx.commit()?;
        Ok(())
    }

    pub fn put_many(&self, entries: &[(&str, &str, serde_json::Value)]) -> Result<()> {
        let tx = self.db.tx(true)?;
        for (bucket, key, value) in entries {
            tx.get_bucket(*bucket)?
                .put(key.as_bytes(), serde_json::to_vec(value)?)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get<T: DeserializeOwned>(&self, bucket: &str, key: &str) -> Result<T> {
        self.get_optional(bucket, key)?
            .ok_or_else(|| anyhow!("not found"))
    }

    pub fn get_optional<T: DeserializeOwned>(&self, bucket: &str, key: &str) -> Result<Option<T>> {
        let tx = self.db.tx(false)?;
        let data = tx.get_bucket(bucket)?.get(key.as_bytes());
        data.map(|data| serde_json::from_slice(data.kv().value()).map_err(Into::into))
            .transpose()
    }

    pub fn update_existing<T, F>(&self, bucket: &str, key: &str, update: F) -> Result<Option<T>>
    where
        T: Serialize + DeserializeOwned,
        F: FnOnce(T) -> Option<T>,
    {
        let tx = self.db.tx(true)?;
        let bucket = tx.get_bucket(bucket)?;
        let Some(bytes) = bucket
            .get(key.as_bytes())
            .map(|data| data.kv().value().to_vec())
        else {
            tx.commit()?;
            return Ok(None);
        };
        let current = serde_json::from_slice(&bytes)?;
        let next = update(current);
        if let Some(value) = &next {
            bucket.put(key.as_bytes(), serde_json::to_vec(value)?)?;
        } else {
            bucket.delete(key.as_bytes())?;
        }
        tx.commit()?;
        Ok(next)
    }

    pub fn delete(&self, bucket: &str, key: &str) -> Result<()> {
        let tx = self.db.tx(true)?;
        tx.get_bucket(bucket)?.delete(key.as_bytes())?;
        tx.commit()?;
        Ok(())
    }

    pub fn save_instance_settings(&self, value: &AgentSettings) -> Result<()> {
        self.put("instance_config", "agents", value)
    }
    pub fn quick_note(&self, username: &str) -> Option<QuickNote> {
        self.get("quick_notes", username).ok()
    }
    pub fn save_quick_note(&self, username: &str, value: &QuickNote) -> Result<()> {
        self.put("quick_notes", username, value)
    }
    pub fn admin_hash(&self, username: &str) -> Option<String> {
        self.get::<serde_json::Value>("users", username)
            .ok()?
            .get("password_hash")?
            .as_str()
            .map(str::to_owned)
    }
    pub fn ensure_admin(&self, username: &str, password_hash: &str) -> Result<()> {
        match self.get_optional::<serde_json::Value>("users", username)? {
            Some(user)
                if user
                    .get("password_hash")
                    .and_then(serde_json::Value::as_str)
                    .is_some() => {}
            Some(_) => return Err(anyhow!("stored administrator record is invalid")),
            None => self.put(
                "users",
                username,
                &serde_json::json!({"username": username, "password_hash": password_hash}),
            )?,
        }
        Ok(())
    }
}

fn migrate_bbolt(path: &Path) -> Result<()> {
    if !is_bbolt(path)? {
        return Ok(());
    }
    let legacy =
        Bolt::open_ro(path).with_context(|| format!("read legacy bbolt {}", path.display()))?;
    let temporary = path.with_extension("rust-tmp");
    if temporary.exists() {
        fs::remove_file(&temporary)?;
    }
    {
        let target = DB::open(&temporary)?;
        let write = target.tx(true)?;
        let read = legacy.begin()?;
        for name in BUCKETS {
            let target_bucket = write.get_or_create_bucket(*name)?;
            if let Some(source_bucket) = read.bucket(name.as_bytes()) {
                for entry in source_bucket.cursor()? {
                    target_bucket.put(entry.key, entry.value)?;
                }
            }
        }
        write.commit()?;
    }
    DB::open(&temporary).context("validate migrated database")?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    fs::rename(&temporary, path)?;
    Ok(())
}

fn is_bbolt(path: &Path) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    use std::io::Read;
    let mut header = [0_u8; 10];
    let mut file = fs::File::open(path)?;
    if file.read(&mut header)? < header.len() {
        return Ok(false);
    }
    Ok(u16::from_le_bytes([header[8], header[9]]) == 4)
}

pub fn token_hash(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}
pub fn default_path() -> PathBuf {
    std::env::var_os("JIAN_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs_home().join(".local/jian/jian.db"))
}
pub fn dirs_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_many_rolls_back_all_values_on_error() {
        let root = std::env::temp_dir().join(format!("jian-store-{}", uuid::Uuid::new_v4()));
        let store = Store::open(root.join("jian.db")).unwrap();
        store
            .put("registered_hosts", "all", &serde_json::json!(["before"]))
            .unwrap();
        store
            .put("remote_sessions", "all", &serde_json::json!(["before"]))
            .unwrap();

        let result = store.put_many(&[
            ("registered_hosts", "all", serde_json::json!(["after"])),
            ("missing_bucket", "all", serde_json::json!([])),
        ]);

        assert!(result.is_err());
        assert_eq!(
            store
                .get::<serde_json::Value>("registered_hosts", "all")
                .unwrap(),
            serde_json::json!(["before"])
        );
        assert_eq!(
            store
                .get::<serde_json::Value>("remote_sessions", "all")
                .unwrap(),
            serde_json::json!(["before"])
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
