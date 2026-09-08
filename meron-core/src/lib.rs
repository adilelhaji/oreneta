//! Shared Meron core library surface.
//!
//! The desktop app still runs `src/main.rs` as a JSON-lines stdio sidecar. This
//! library is the first extraction point for mobile hosts: protocol constants
//! and wire types live here so desktop, Android, and future FFI bindings share
//! one source of truth.

pub mod backend;
pub mod backup;
pub mod calendar;
pub mod carddav;
pub mod changelog;
pub mod contacts;
pub mod conversation_page;
pub mod crypto;
pub mod engine;
pub mod exchange;
pub mod ffi;
pub mod imap;
pub mod log;
pub mod mail_model;
pub mod oof;
pub mod parse;
pub mod priority;
pub mod protocol;
pub mod proxy;
pub mod rss;
pub mod rules;
pub mod search;
pub mod secrets;
#[cfg(target_os = "linux")]
mod secrets_portal;
pub mod smtp;
pub mod spam;
pub mod store;
pub mod templates;
pub mod thread_list;
pub mod thread_read;
pub mod tls;
pub mod unified;
pub mod utf7;
