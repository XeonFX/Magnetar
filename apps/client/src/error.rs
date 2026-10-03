use std::sync::Arc;

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BadRequest,
    NotFound,
    RateLimited,
    Forbidden,
    Internal,
}

/// A caller mistake with a message fit to show them, or an internal failure. Surfaces decide how
/// much of an internal message to reveal (the dashboard shows it, REST and MCP don't). An internal
/// failure keeps the error behind it, so `log_failure!` can tell a full disk from a fault.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
    cause: Option<Arc<dyn std::error::Error + Send + Sync>>,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), cause: None }
    }

    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::BadRequest, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    /// An internal failure saying `message`, caused by `cause`.
    pub fn internal_from(message: impl Into<String>, cause: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> Self {
        Self { cause: Some(Arc::from(cause.into())), ..Self::internal(message) }
    }

    pub fn http_status(&self) -> u16 {
        match self.code {
            ErrorCode::BadRequest => 400,
            ErrorCode::NotFound => 404,
            ErrorCode::RateLimited => 429,
            ErrorCode::Forbidden => 403,
            ErrorCode::Internal => 500,
        }
    }

    pub fn is_internal(&self) -> bool {
        self.code == ErrorCode::Internal
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ApiError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause.as_deref().map(|cause| cause as &(dyn std::error::Error + 'static))
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        match error.downcast::<ApiError>() {
            Ok(api) => api,
            Err(other) => Self::internal_from(format!("{other:#}"), other),
        }
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        Self::internal_from(error.to_string(), error)
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        Self::internal_from(error.to_string(), error)
    }
}

#[cfg(test)]
mod tests {
    use std::io::{self, ErrorKind};

    use anyhow::Context as _;

    use super::*;
    use crate::log::caused_by_surroundings;

    #[test]
    fn an_internal_failure_still_tells_a_full_disk_from_a_fault() {
        let full = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(13), Some("database or disk is full".into()));
        assert!(caused_by_surroundings(&ApiError::from(full)));
        assert!(caused_by_surroundings(&ApiError::from(io::Error::from(ErrorKind::StorageFull))));
        let staged = Err::<(), _>(io::Error::from(ErrorKind::StorageFull)).context("staging").unwrap_err();
        assert!(caused_by_surroundings(&ApiError::from(staged)));

        let locked = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(5), Some("database is locked".into()));
        assert!(!caused_by_surroundings(&ApiError::from(locked)));
        assert!(!caused_by_surroundings(&ApiError::from(io::Error::from(ErrorKind::NotFound))));
        assert!(!caused_by_surroundings(&ApiError::internal("no space left on device (os error 28)")));
        // Whatever was wrapped, the message stays the caller's.
        assert_eq!(ApiError::from(anyhow::anyhow!("boom")).message, "boom");
    }
}
