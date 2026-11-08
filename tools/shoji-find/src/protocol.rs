//! The JSON shapes that go over the ShojiWM IPC socket.
//!
//! The socket speaks newline-delimited JSON (see shoji_wm/src/ipc.ts):
//!
//! ```text
//!   config -> helper   { "event": "launcher.query", "payload": { "id": 7, "q": "dol" } }
//!   helper -> config   { "method": "launcher.results", "params": { "id": 7, ... } }
//! ```
//!
//! The helper sends no `id` on its calls, so the config sends no reply back.

use serde::{Deserialize, Serialize};

/// One app tile on the home screen.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct App {
    /// The desktop file id, for example `org.kde.dolphin.desktop`.
    pub id: String,
    pub name: String,
    /// An absolute icon path, or "" when no icon is found.
    pub icon: String,
    /// The command line, with field codes like %U removed.
    pub exec: String,
}

/// What Enter does on an item.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Action {
    /// "exec", "open", "copy" or "url".
    pub kind: &'static str,
    pub value: String,
}

/// One result row.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Item {
    pub id: String,
    pub title: String,
    pub sub: String,
    pub icon: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chip: Option<String>,
    /// Character ranges of `title` to draw bold, `[start, end)`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub highlight: Vec<[usize; 2]>,
    pub action: Action,
}

/// A group of results. `kind` is "top", "apps", "files", "settings",
/// "math", "meaning" or "web".
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Section {
    pub kind: &'static str,
    pub items: Vec<Item>,
}

/// The params of `launcher.results`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Results {
    pub id: i64,
    pub q: String,
    pub sections: Vec<Section>,
}

/// The params of `launcher.homeData`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HomeData {
    pub recommended: Vec<App>,
    pub pinned: Vec<App>,
}

/// A broadcast that the helper acts on.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Home,
    Query { id: i64, q: String },
    Pin { app_id: String, pinned: bool },
    Used { app_id: String },
}

#[derive(Deserialize)]
struct Broadcast {
    event: Option<String>,
    #[serde(default)]
    payload: serde_json::Value,
}

#[derive(Deserialize)]
struct QueryPayload {
    id: i64,
    #[serde(default)]
    q: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PinPayload {
    app_id: String,
    pinned: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsedPayload {
    app_id: String,
}

/// Reads one line from the socket. Returns `None` for every message that is
/// not a launcher broadcast (other events, replies, bad JSON).
pub fn parse_line(line: &str) -> Option<Incoming> {
    let message: Broadcast = serde_json::from_str(line).ok()?;
    let payload = message.payload;
    match message.event?.as_str() {
        "launcher.home" => Some(Incoming::Home),
        "launcher.query" => {
            let p: QueryPayload = serde_json::from_value(payload).ok()?;
            Some(Incoming::Query { id: p.id, q: p.q })
        }
        "launcher.pin" => {
            let p: PinPayload = serde_json::from_value(payload).ok()?;
            Some(Incoming::Pin {
                app_id: p.app_id,
                pinned: p.pinned,
            })
        }
        "launcher.used" => {
            let p: UsedPayload = serde_json::from_value(payload).ok()?;
            Some(Incoming::Used { app_id: p.app_id })
        }
        _ => None,
    }
}

/// Builds one call line (with its newline) for the config.
pub fn call_line<T: Serialize>(method: &str, params: &T) -> String {
    let mut line = serde_json::json!({ "method": method, "params": params }).to_string();
    line.push('\n');
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_four_broadcasts() {
        assert_eq!(
            parse_line(r#"{"event":"launcher.home","payload":{}}"#),
            Some(Incoming::Home)
        );
        assert_eq!(
            parse_line(r#"{"event":"launcher.query","payload":{"id":3,"q":"dol"}}"#),
            Some(Incoming::Query {
                id: 3,
                q: "dol".into()
            })
        );
        assert_eq!(
            parse_line(r#"{"event":"launcher.pin","payload":{"appId":"a.desktop","pinned":true}}"#),
            Some(Incoming::Pin {
                app_id: "a.desktop".into(),
                pinned: true
            })
        );
        assert_eq!(
            parse_line(r#"{"event":"launcher.used","payload":{"appId":"b.desktop"}}"#),
            Some(Incoming::Used {
                app_id: "b.desktop".into()
            })
        );
    }

    #[test]
    fn ignores_other_lines() {
        assert_eq!(parse_line(r#"{"event":"keys.sheet","payload":{}}"#), None);
        assert_eq!(parse_line(r#"{"id":1,"result":null}"#), None);
        assert_eq!(parse_line("not json"), None);
        assert_eq!(
            parse_line(r#"{"event":"launcher.query","payload":{}}"#),
            None
        );
    }

    #[test]
    fn call_line_matches_the_wire_format() {
        let results = Results {
            id: 9,
            q: "x".into(),
            sections: vec![Section {
                kind: "web",
                items: vec![Item {
                    id: "web".into(),
                    title: "t".into(),
                    sub: String::new(),
                    icon: String::new(),
                    chip: None,
                    highlight: vec![],
                    action: Action {
                        kind: "url",
                        value: "u".into(),
                    },
                }],
            }],
        };
        let line = call_line("launcher.results", &results);
        assert!(line.ends_with('\n'));
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["method"], "launcher.results");
        assert_eq!(value["params"]["id"], 9);
        let item = &value["params"]["sections"][0]["items"][0];
        assert_eq!(item["action"]["kind"], "url");
        // Optional fields stay out of the JSON when empty.
        assert!(item.get("chip").is_none());
        assert!(item.get("highlight").is_none());
        assert!(value.get("id").is_none());
    }
}
