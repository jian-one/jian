use std::{collections::HashMap, sync::RwLock, time::Duration};

use anyhow::{Result, anyhow};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc, oneshot};

struct Connection {
    id: String,
    sender: mpsc::UnboundedSender<String>,
}

#[derive(Default)]
pub struct RemoteHub {
    connections: RwLock<HashMap<String, Connection>>,
    sessions: RwLock<HashMap<String, broadcast::Sender<String>>>,
    requests: RwLock<HashMap<String, (String, oneshot::Sender<Value>)>>,
}

impl RemoteHub {
    pub fn connect(&self, host_id: String) -> (String, mpsc::UnboundedReceiver<String>) {
        let connection_id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::unbounded_channel();
        let previous = self.connections.write().unwrap().insert(
            host_id,
            Connection {
                id: connection_id.clone(),
                sender,
            },
        );
        if let Some(previous) = previous {
            let _ = previous
                .sender
                .send(serde_json::json!({"type":"client.revoke"}).to_string());
        }
        (connection_id, receiver)
    }

    pub fn disconnect(&self, host_id: &str, connection_id: &str) -> bool {
        let mut connections = self.connections.write().unwrap();
        if connections
            .get(host_id)
            .is_some_and(|connection| connection.id == connection_id)
        {
            connections.remove(host_id);
            true
        } else {
            false
        }
    }

    pub fn is_connected(&self, host_id: &str) -> bool {
        self.connections.read().unwrap().contains_key(host_id)
    }

    pub fn owns_connection(&self, host_id: &str, connection_id: &str) -> bool {
        self.connections
            .read()
            .unwrap()
            .get(host_id)
            .is_some_and(|connection| connection.id == connection_id)
    }

    pub fn send(&self, host_id: &str, command: Value) -> Result<()> {
        let connections = self.connections.read().unwrap();
        let connection = connections
            .get(host_id)
            .ok_or_else(|| anyhow!("主机当前未连接"))?;
        connection.sender.send(command.to_string())?;
        Ok(())
    }

    pub async fn request(&self, host_id: &str, command: Value) -> Result<Value> {
        let request_id = command
            .get("request_id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("remote request ID is missing"))?
            .to_owned();
        let (reply, response) = oneshot::channel();
        self.requests
            .write()
            .unwrap()
            .insert(request_id.clone(), (host_id.to_owned(), reply));
        if let Err(error) = self.send(host_id, command) {
            self.requests.write().unwrap().remove(&request_id);
            return Err(error);
        }
        match tokio::time::timeout(Duration::from_secs(10), response).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err(anyhow!("remote host closed the request")),
            Err(_) => {
                self.requests.write().unwrap().remove(&request_id);
                Err(anyhow!("remote host request timed out"))
            }
        }
    }

    pub fn respond(&self, host_id: &str, request_id: &str, response: Value) -> bool {
        let mut requests = self.requests.write().unwrap();
        if !requests
            .get(request_id)
            .is_some_and(|(expected_host, _)| expected_host == host_id)
        {
            return false;
        }
        requests
            .remove(request_id)
            .is_some_and(|(_, reply)| reply.send(response).is_ok())
    }

    pub fn subscribe(&self, session_id: &str) -> broadcast::Receiver<String> {
        let mut sessions = self.sessions.write().unwrap();
        sessions
            .entry(session_id.to_string())
            .or_insert_with(|| broadcast::channel(128).0)
            .subscribe()
    }

    pub fn publish(&self, session_id: &str, event: String) {
        if let Some(sender) = self.sessions.read().unwrap().get(session_id) {
            let _ = sender.send(event);
        }
    }

    pub fn forget_session(&self, session_id: &str) {
        self.sessions.write().unwrap().remove(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_revokes_the_previous_client_and_ignores_stale_disconnects() {
        let hub = RemoteHub::default();
        let (previous_id, mut previous_commands) = hub.connect("host-1".into());
        let (current_id, _current_commands) = hub.connect("host-1".into());

        assert_eq!(
            previous_commands.try_recv().unwrap(),
            r#"{"type":"client.revoke"}"#
        );
        assert!(!hub.owns_connection("host-1", &previous_id));
        assert!(hub.owns_connection("host-1", &current_id));

        hub.disconnect("host-1", &previous_id);
        assert!(hub.is_connected("host-1"));
    }

    #[test]
    fn routes_commands_to_the_registered_host_connection() {
        let hub = RemoteHub::default();
        let (_, mut commands) = hub.connect("host-1".into());

        hub.send(
            "host-1",
            serde_json::json!({"type":"pty.input","session_id":"s1","data":"pwd\r"}),
        )
        .unwrap();

        let command: Value = serde_json::from_str(&commands.try_recv().unwrap()).unwrap();
        assert_eq!(command["type"], "pty.input");
        assert_eq!(command["session_id"], "s1");
    }

    #[tokio::test]
    async fn remote_requests_only_accept_responses_from_the_target_host() {
        let hub = std::sync::Arc::new(RemoteHub::default());
        let (_, mut commands) = hub.connect("host-1".into());
        let requester = hub.clone();
        let pending = tokio::spawn(async move {
            requester
                .request(
                    "host-1",
                    serde_json::json!({"type":"workspace.browse","request_id":"request-1"}),
                )
                .await
                .unwrap()
        });

        let command: Value = serde_json::from_str(&commands.recv().await.unwrap()).unwrap();
        assert_eq!(command["type"], "workspace.browse");
        assert!(!hub.respond("host-2", "request-1", serde_json::json!({"wrong":true})));
        assert!(hub.respond("host-1", "request-1", serde_json::json!({"ok":true})));
        assert_eq!(pending.await.unwrap()["ok"], true);
    }
}
