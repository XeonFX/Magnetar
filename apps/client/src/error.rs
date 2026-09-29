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
/// much of an internal message to reveal (the dashboard shows it, REST and MCP don't).
#[derive(Debug, Clone)]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
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

impl std::error::Error for ApiError {}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        match error.downcast::<ApiError>() {
            Ok(api) => api,
            Err(other) => Self::internal(format!("{other:#}")),
        }
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        Self::internal(error.to_string())
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        Self::internal(error.to_string())
    }
}
