//! Reads the search keywords of the KDE settings pages.
//!
//! The settings `.desktop` files hold only a name. The keywords ("wifi",
//! "ethernet", ...) live in the plugin itself, in its Qt metadata, which Qt 6
//! stores as CBOR (a binary JSON). This module finds the untranslated
//! `X-KDE-Keywords` and `Description` values in the plugin file.
//!
//! ```text
//!   kcm_networkmanagement.so
//!     ... 6E "X-KDE-Keywords" 79 01 84 "networks,wifi,wi-fi,ethernet,..."
//!          │                  │  └─┴── the length, 388 bytes
//!          │                  └─────── "a text of 2-byte length follows"
//!          └────────────────────────── "a text of 14 bytes" (the key)
//! ```

use std::collections::HashMap;
use std::path::{Path, PathBuf};

const PLUGIN_ROOT: &str = "/usr/lib/qt6/plugins";

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Meta {
    pub keywords: String,
    pub description: String,
    /// "desktop", "handset", "tablet"... Empty means every form factor.
    pub form_factors: Vec<String>,
}

impl Meta {
    /// False for pages made only for phones and tablets (Plasma Mobile).
    pub fn for_desktop(&self) -> bool {
        self.form_factors.is_empty() || self.form_factors.iter().any(|f| f == "desktop")
    }
}

/// Maps each module name ("kcm_bluetooth") to its plugin file.
pub fn find_plugins() -> HashMap<String, PathBuf> {
    let mut found = HashMap::new();
    walk(Path::new(PLUGIN_ROOT), &mut found, 0);
    found
}

fn walk(dir: &Path, found: &mut HashMap<String, PathBuf>, depth: usize) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for item in read.flatten() {
        let path = item.path();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if depth < 4 {
                walk(&path, found, depth + 1);
            }
            continue;
        }
        let name = item.file_name().to_string_lossy().into_owned();
        if let Some(module) = name.strip_suffix(".so") {
            if module.starts_with("kcm_") {
                found.entry(module.to_string()).or_insert(path);
            }
        }
    }
}

/// Reads the metadata of one plugin file.
pub fn read(path: &Path) -> Meta {
    let Ok(bytes) = std::fs::read(path) else {
        return Meta::default();
    };
    Meta {
        keywords: cbor_text_after(&bytes, b"X-KDE-Keywords").unwrap_or_default(),
        description: cbor_text_after(&bytes, b"Description").unwrap_or_default(),
        form_factors: cbor_texts_after(&bytes, b"FormFactors"),
    }
}

/// Finds the CBOR text key `key` (exactly, so not "Description[de]") and
/// returns the CBOR text value that follows it.
pub fn cbor_text_after(bytes: &[u8], key: &[u8]) -> Option<String> {
    if key.len() > 23 {
        return None;
    }
    let mut needle = vec![0x60 + key.len() as u8];
    needle.extend_from_slice(key);
    for start in memchr::memmem::find_iter(bytes, &needle) {
        let at = start + needle.len();
        if let Some(text) = cbor_text(bytes, at) {
            return Some(text);
        }
    }
    None
}

/// Finds the CBOR text key `key` and returns the short array of texts that
/// follows it (`["handset", "tablet"]`).
pub fn cbor_texts_after(bytes: &[u8], key: &[u8]) -> Vec<String> {
    let mut needle = vec![0x60 + key.len() as u8];
    needle.extend_from_slice(key);
    let Some(start) = memchr::memmem::find(bytes, &needle) else {
        return Vec::new();
    };
    let mut at = start + needle.len();
    let Some(&head) = bytes.get(at) else {
        return Vec::new();
    };
    if !(0x80..=0x97).contains(&head) {
        return Vec::new();
    }
    at += 1;
    let mut texts = Vec::new();
    for _ in 0..(head - 0x80) {
        let Some(text) = cbor_text(bytes, at) else {
            break;
        };
        at += cbor_head_size(bytes[at]) + text.len();
        texts.push(text);
    }
    texts
}

fn cbor_head_size(head: u8) -> usize {
    match head {
        0x78 => 2,
        0x79 => 3,
        _ => 1,
    }
}

/// Decodes a CBOR text string (major type 3) at `at`.
fn cbor_text(bytes: &[u8], at: usize) -> Option<String> {
    let head = *bytes.get(at)?;
    let (length, skip) = match head {
        0x60..=0x77 => ((head - 0x60) as usize, 1),
        0x78 => (*bytes.get(at + 1)? as usize, 2),
        0x79 => (
            u16::from_be_bytes([*bytes.get(at + 1)?, *bytes.get(at + 2)?]) as usize,
            3,
        ),
        _ => return None,
    };
    let text = bytes.get(at + skip..at + skip + length)?;
    String::from_utf8(text.to_vec()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_short_and_long_texts() {
        let mut bytes = vec![0x00, 0x6e];
        bytes.extend_from_slice(b"X-KDE-Keywords");
        bytes.extend_from_slice(&[0x79, 0x00, 0x0a]);
        bytes.extend_from_slice(b"wifi,lan,x");
        bytes.push(0x6b);
        bytes.extend_from_slice(b"Description");
        bytes.push(0x65);
        bytes.extend_from_slice(b"Hello");
        assert_eq!(
            cbor_text_after(&bytes, b"X-KDE-Keywords").as_deref(),
            Some("wifi,lan,x")
        );
        assert_eq!(
            cbor_text_after(&bytes, b"Description").as_deref(),
            Some("Hello")
        );
        assert_eq!(cbor_text_after(&bytes, b"Name"), None);
    }

    #[test]
    fn reads_form_factors() {
        let mut bytes = vec![0x6b];
        bytes.extend_from_slice(b"FormFactors");
        bytes.push(0x82);
        bytes.push(0x67);
        bytes.extend_from_slice(b"handset");
        bytes.push(0x66);
        bytes.extend_from_slice(b"tablet");
        let texts = cbor_texts_after(&bytes, b"FormFactors");
        assert_eq!(texts, vec!["handset", "tablet"]);
        let meta = Meta {
            form_factors: texts,
            ..Meta::default()
        };
        assert!(!meta.for_desktop());
        assert!(Meta::default().for_desktop());
    }

    #[test]
    fn skips_the_translated_keys() {
        // "Description[de]" has another length byte, so it never matches.
        let mut bytes = vec![0x6f];
        bytes.extend_from_slice(b"Description[de]");
        bytes.push(0x63);
        bytes.extend_from_slice(b"Hallo");
        assert_eq!(cbor_text_after(&bytes, b"Description"), None);
    }
}
