use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;

/// One pushed message: `downloads.changed`, `search.results`, … (see RpcEvents in the protocol).
#[derive(Debug)]
pub struct Event {
    pub name: &'static str,
    pub data: Value,
}

/// In-process bus for everything the dashboard is told about without asking. Services publish,
/// every connected local or relayed dashboard receives.
#[derive(Clone)]
pub struct EventBus {
    sender: broadcast::Sender<Arc<Event>>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self { sender: broadcast::channel(512).0 }
    }
}

impl EventBus {
    pub fn emit(&self, name: &'static str, data: impl Serialize) {
        let data = serde_json::to_value(data).unwrap_or(Value::Null);
        // No subscribers is fine: nobody has a dashboard open.
        let _ = self.sender.send(Arc::new(Event { name, data }));
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Event>> {
        self.sender.subscribe()
    }
}
