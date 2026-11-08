//! What the user opens: KDE's usage history, our own counts, and the pins.
//!
//! ```text
//!   KDE history (kactivitymanagerd, SQLite, read only)  ─┐
//!   launcher.used counts (~/.local/state/shoji-find)    ─┼─▶ use score per app
//!                                                        │
//!   pins (~/.config/shojiwm/launcher-pins.json) ─────────┴─▶ homeData
//! ```

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::desktop::home_dir;

/// How many tiles each home grid has.
pub const RECOMMENDED_COUNT: usize = 16;
pub const PINNED_COUNT: usize = 24;

/// Well-known apps that fill the pinned grid when the user has few habits.
const DEFAULT_PINS: &[&str] = &[
    "org.kde.dolphin.desktop",
    "google-chrome.desktop",
    "firefox.desktop",
    "org.kde.konsole.desktop",
    "systemsettings.desktop",
    "code.desktop",
    "org.kde.kate.desktop",
    "org.kde.kwrite.desktop",
    "org.kde.spectacle.desktop",
    "org.kde.kcalc.desktop",
    "org.kde.okular.desktop",
    "org.kde.gwenview.desktop",
    "org.kde.discover.desktop",
    "org.kde.ark.desktop",
    "org.kde.plasma-systemmonitor.desktop",
    "vlc.desktop",
    "org.kde.elisa.desktop",
    "libreoffice-writer.desktop",
    "libreoffice-calc.desktop",
    "steam.desktop",
    "com.obsproject.Studio.desktop",
    "blender.desktop",
    "gimp.desktop",
    "org.kde.kdenlive.desktop",
];

/// The well-known apps, in order.
pub fn default_ids() -> Vec<String> {
    DEFAULT_PINS.iter().map(|s| s.to_string()).collect()
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// One app's history.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Use {
    pub count: f64,
    /// Unix seconds of the last use.
    pub last: u64,
}

/// Our own `launcher.used` counts.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageFile {
    #[serde(default)]
    pub apps: HashMap<String, Use>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PinsFile {
    #[serde(default)]
    pinned: Vec<String>,
}

pub fn usage_path() -> PathBuf {
    let state = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".local/state"));
    state.join("shoji-find/usage.json")
}

pub fn pins_path() -> PathBuf {
    home_dir().join(".config/shojiwm/launcher-pins.json")
}

pub fn kde_database_path() -> PathBuf {
    home_dir().join(".local/share/kactivitymanagerd/resources/database")
}

fn read_json<T: for<'a> Deserialize<'a> + Default>(path: &Path) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Writes through a temp file and a rename, so a crash never leaves half a file.
fn write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(temp, path)
}

/// Reads the app history from KDE's database. Scores of the same app from
/// different sources (task manager, KRunner, Kickoff) add up.
pub fn read_kde_history(path: &Path) -> HashMap<String, Use> {
    let mut history: HashMap<String, Use> = HashMap::new();
    let flags =
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let Ok(db) = rusqlite::Connection::open_with_flags(path, flags) else {
        return history;
    };
    let _ = db.busy_timeout(std::time::Duration::from_millis(50));
    let sql =
        "SELECT targettedResource, SUM(cachedScore), MAX(lastUpdate) FROM ResourceScoreCache \
               WHERE targettedResource LIKE 'applications:%' GROUP BY targettedResource";
    if let Ok(mut statement) = db.prepare(sql) {
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        });
        if let Ok(rows) = rows {
            for (resource, score, last) in rows.flatten() {
                let id = desktop_id(&resource);
                let entry = history.entry(id).or_default();
                entry.count += score;
                entry.last = entry.last.max(last.max(0) as u64);
            }
        }
    }
    let sql = "SELECT targettedResource, MAX(start) FROM ResourceEvent \
               WHERE targettedResource LIKE 'applications:%' GROUP BY targettedResource";
    if let Ok(mut statement) = db.prepare(sql) {
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        });
        if let Ok(rows) = rows {
            for (resource, start) in rows.flatten() {
                let entry = history.entry(desktop_id(&resource)).or_default();
                entry.last = entry.last.max(start.max(0) as u64);
            }
        }
    }
    history
}

/// "applications:org.kde.dolphin.desktop" -> "org.kde.dolphin.desktop";
/// "applications:Hermes" -> "Hermes.desktop".
fn desktop_id(resource: &str) -> String {
    let id = resource.trim_start_matches("applications:");
    if id.ends_with(".desktop") {
        id.to_string()
    } else {
        format!("{id}.desktop")
    }
}

/// The use state: KDE's history (cached), our counts, and the pins.
pub struct Usage {
    kde: HashMap<String, Use>,
    kde_read_at: u64,
    pub own: UsageFile,
    /// `None` until the user pins or unpins for the first time.
    pub pins: Option<Vec<String>>,
}

impl Usage {
    pub fn load() -> Self {
        let pins_file = pins_path();
        let pins = pins_file
            .exists()
            .then(|| read_json::<PinsFile>(&pins_file).pinned);
        Usage {
            kde: read_kde_history(&kde_database_path()),
            kde_read_at: now(),
            own: read_json(&usage_path()),
            pins,
        }
    }

    /// Reads KDE's database again when the copy is older than a minute.
    pub fn refresh(&mut self) {
        if now().saturating_sub(self.kde_read_at) > 60 {
            self.kde = read_kde_history(&kde_database_path());
            self.kde_read_at = now();
        }
    }

    /// One number per app: how much and how lately the user opens it.
    pub fn score(&self, id: &str) -> f64 {
        let mut total = 0.0;
        let mut last = 0;
        if let Some(used) = self.kde.get(id) {
            total += used.count;
            last = used.last;
        }
        if let Some(used) = self.own.apps.get(id) {
            // A launch from our launcher counts like 3 KDE points.
            total += 3.0 * used.count;
            last = last.max(used.last);
        }
        if last == 0 {
            return total;
        }
        let age_days = now().saturating_sub(last) as f64 / 86_400.0;
        total + 20.0 * (-age_days / 3.0).exp()
    }

    /// The search bonus: small, so a good name match still wins.
    pub fn search_boost(&self, id: &str) -> f32 {
        let score = self.score(id);
        (8.0 * (1.0 + score).ln()).min(30.0) as f32
    }

    pub fn record_use(&mut self, id: &str) {
        let entry = self.own.apps.entry(id.to_string()).or_default();
        entry.count += 1.0;
        entry.last = now();
        if let Err(error) = write_json(&usage_path(), &self.own) {
            eprintln!("shoji-find: cannot save the usage counts: {error}");
        }
    }

    /// Pins or unpins. The first change starts from the grid the user sees.
    pub fn set_pin(&mut self, id: &str, pinned: bool, shown: &[String]) {
        self.set_pin_at(&pins_path(), id, pinned, shown);
    }

    fn set_pin_at(&mut self, file: &Path, id: &str, pinned: bool, shown: &[String]) {
        let first_change = self.pins.is_none();
        let mut pins = self.pins.clone().unwrap_or_else(|| shown.to_vec());
        pins.retain(|p| p != id);
        if pinned {
            // The grid the user saw was full of filler: make room, so the
            // new pin shows in the last tile instead of tile 25.
            if first_change {
                pins.truncate(PINNED_COUNT - 1);
            }
            pins.push(id.to_string());
        }
        if let Err(error) = write_json(
            file,
            &PinsFile {
                pinned: pins.clone(),
            },
        ) {
            eprintln!("shoji-find: cannot save the pins: {error}");
        }
        self.pins = Some(pins);
    }

    /// The pinned ids: the user's pins; or, before the first pin, the most
    /// used apps, then the defaults, then `padding`, minus the ids in `skip`
    /// (the Recommended grid). `exists` says whether an id is a listed app.
    pub fn pinned_ids(
        &self,
        exists: &dyn Fn(&str) -> bool,
        most_used: &[String],
        skip: &[String],
        padding: &[String],
    ) -> Vec<String> {
        if let Some(pins) = &self.pins {
            return pins
                .iter()
                .filter(|p| exists(p))
                .take(PINNED_COUNT)
                .cloned()
                .collect();
        }
        let mut ids: Vec<String> = Vec::new();
        let candidates = most_used
            .iter()
            .map(String::as_str)
            .chain(DEFAULT_PINS.iter().copied())
            .chain(padding.iter().map(String::as_str));
        for id in candidates {
            if ids.len() >= PINNED_COUNT {
                break;
            }
            if exists(id) && !skip.iter().any(|s| s == id) && !ids.iter().any(|i| i == id) {
                ids.push(id.to_string());
            }
        }
        ids
    }

    /// Every known app id with a use score, best first.
    pub fn ranked_ids(&self) -> Vec<String> {
        let mut ids: Vec<&String> = self.kde.keys().chain(self.own.apps.keys()).collect();
        ids.sort();
        ids.dedup();
        let mut scored: Vec<(f64, &String)> =
            ids.into_iter().map(|id| (self.score(id), id)).collect();
        scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(b.1)));
        scored
            .into_iter()
            .filter(|(s, _)| *s > 0.0)
            .map(|(_, id)| id.clone())
            .collect()
    }

    /// The ids in order of their last use, newest first.
    pub fn recent_ids(&self) -> Vec<String> {
        let mut last: HashMap<&String, u64> = HashMap::new();
        for (id, used) in self.kde.iter().chain(self.own.apps.iter()) {
            let slot = last.entry(id).or_default();
            *slot = (*slot).max(used.last);
        }
        let mut ids: Vec<(&String, u64)> = last.into_iter().collect();
        ids.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        ids.into_iter().map(|(id, _)| id.clone()).collect()
    }
}

/// Merges the recent and the most used apps for the "Recommended" grid.
/// Takes them in turns (recent, used, recent, ...) and skips the pinned ones.
pub fn recommended_ids(
    recent: &[String],
    most_used: &[String],
    pinned: &[String],
    exists: &dyn Fn(&str) -> bool,
    padding: &[String],
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let add = |id: &str, out: &mut Vec<String>| {
        if out.len() < RECOMMENDED_COUNT
            && exists(id)
            && !pinned.iter().any(|p| p == id)
            && !out.iter().any(|o| o == id)
        {
            out.push(id.to_string());
        }
    };
    let longest = recent.len().max(most_used.len());
    for i in 0..longest {
        if let Some(id) = recent.get(i) {
            add(id, &mut out);
        }
        if let Some(id) = most_used.get(i) {
            add(id, &mut out);
        }
    }
    for id in padding {
        add(id, &mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_ids() {
        assert_eq!(
            desktop_id("applications:org.kde.dolphin.desktop"),
            "org.kde.dolphin.desktop"
        );
        assert_eq!(desktop_id("applications:Hermes"), "Hermes.desktop");
    }

    #[test]
    fn recommended_skips_pins_and_pads() {
        let ids = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let recent = ids(&["a", "b", "gone"]);
        let used = ids(&["b", "c", "d"]);
        let pinned = ids(&["c"]);
        let padding = ids(&["e", "a", "f"]);
        let exists = |id: &str| id != "gone";
        let out = recommended_ids(&recent, &used, &pinned, &exists, &padding);
        assert_eq!(out, ids(&["a", "b", "d", "e", "f"]));
    }

    #[test]
    fn default_pins_fill_from_most_used() {
        let usage = Usage {
            kde: HashMap::new(),
            kde_read_at: 0,
            own: UsageFile::default(),
            pins: None,
        };
        let exists = |id: &str| id != "firefox.desktop";
        let most_used = vec![
            "x.desktop".to_string(),
            "org.kde.dolphin.desktop".to_string(),
        ];
        let skip = vec![
            "konsole-skip".to_string(),
            "google-chrome.desktop".to_string(),
        ];
        let padding = vec!["pad.desktop".to_string()];
        let pins = usage.pinned_ids(&exists, &most_used, &skip, &padding);
        assert_eq!(pins[0], "x.desktop");
        assert_eq!(pins[1], "org.kde.dolphin.desktop");
        // Chrome is in Recommended, Firefox is not installed.
        assert_eq!(pins[2], "org.kde.konsole.desktop");
        assert!(!pins.contains(&"firefox.desktop".to_string()));
        assert!(!pins.contains(&"google-chrome.desktop".to_string()));
        // x + 23 defaults left (no dolphin twice, no firefox, no chrome) + padding.
        assert_eq!(pins.len(), PINNED_COUNT);
        assert_eq!(pins.last().unwrap(), "pad.desktop");
    }

    #[test]
    fn first_pin_stays_visible() {
        let mut usage = Usage {
            kde: HashMap::new(),
            kde_read_at: 0,
            own: UsageFile::default(),
            pins: None,
        };
        let shown: Vec<String> = (0..PINNED_COUNT).map(|i| format!("{i}.desktop")).collect();
        let path =
            std::env::temp_dir().join(format!("shoji-find-pins-{}.json", std::process::id()));
        usage.set_pin_at(&path, "new.desktop", true, &shown);
        let pins = usage.pins.clone().unwrap();
        assert_eq!(pins.len(), PINNED_COUNT);
        assert_eq!(pins.last().unwrap(), "new.desktop");
        usage.set_pin_at(&path, "3.desktop", false, &shown);
        assert_eq!(usage.pins.as_ref().unwrap().len(), PINNED_COUNT - 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn own_counts_raise_the_score() {
        let mut usage = Usage {
            kde: HashMap::new(),
            kde_read_at: 0,
            own: UsageFile::default(),
            pins: None,
        };
        assert_eq!(usage.score("a"), 0.0);
        usage.own.apps.insert(
            "a".into(),
            Use {
                count: 2.0,
                last: now(),
            },
        );
        assert!(usage.score("a") > 20.0);
        assert_eq!(usage.ranked_ids(), vec!["a".to_string()]);
    }
}
