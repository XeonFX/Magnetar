//! The device side of `packages/protocol`: the same DTOs, wire framing and end-to-end encryption
//! the dashboard and the Worker use, so the three agree byte for byte.

pub mod bytes;
pub mod e2e;
pub mod encoding;
pub mod model;
pub mod relay;
pub mod scrub;
pub mod webpush;

pub use model::*;
