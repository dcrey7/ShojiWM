//! The apps and the KDE settings pages, kept in RAM, and their ranking.
//!
//! How a query scores against one app:
//!
//! ```text
//!   fuzzy(name)            "dol"  -> "Dolphin"          (nucleo, ~16 per letter)
//!   fuzzy(program) * 0.8   "code" -> exec "code"
//!   words(generic, keys)   "file" -> "File Manager"     (each query word starts a word)
//!   + start bonus          the name starts with the query
//!   + use bonus            how often the user opens it
//! ```

use std::collections::HashMap;

use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32String};

use crate::desktop::Entry;

/// One searchable app or settings page.
#[derive(Debug, Clone)]
pub struct Record {
    pub id: String,
    pub name: String,
    pub sub: String,
    pub icon_name: String,
    pub command: String,
    /// The lower-case words of the generic name, keywords and comment.
    words: Vec<String>,
    name_lower: String,
    name32: Utf32String,
    program32: Utf32String,
    /// The install time, for "recently installed" padding.
    pub mtime: u64,
}

impl Record {
    pub fn from_entry(entry: &Entry, extra_words: &[String]) -> Self {
        let command = entry.command();
        let program = command
            .split_whitespace()
            .find(|w| !w.contains('=') && *w != "env" && *w != "konsole" && *w != "-e")
            .unwrap_or("")
            .rsplit('/')
            .next()
            .unwrap_or("")
            .to_string();
        let mut words = Vec::new();
        let sources = [entry.generic_name.as_str(), entry.comment.as_str()];
        for text in sources
            .iter()
            .copied()
            .chain(entry.keywords.iter().map(String::as_str))
        {
            words.extend(split_words(text));
        }
        for text in extra_words {
            words.extend(split_words(text));
        }
        words.sort();
        words.dedup();
        let sub = if entry.generic_name.is_empty() {
            &entry.comment
        } else {
            &entry.generic_name
        };
        Record {
            id: entry.id.clone(),
            name: entry.name.clone(),
            sub: sub.clone(),
            icon_name: entry.icon.clone(),
            command,
            words,
            name_lower: entry.name.to_lowercase(),
            name32: Utf32String::from(entry.name.as_str()),
            program32: Utf32String::from(program.as_str()),
            mtime: entry.mtime,
        }
    }

    /// Adds search words (the keywords read from a settings plugin).
    pub fn add_words(&mut self, text: &str) {
        self.words.extend(split_words(text));
        self.words.sort();
        self.words.dedup();
    }

    pub fn set_sub(&mut self, text: &str) {
        if self.sub.is_empty() {
            self.sub = text.to_string();
        }
    }
}

fn split_words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// A scored record: its index and its score.
#[derive(Debug, Clone)]
pub struct Hit {
    pub index: usize,
    pub score: f32,
}

/// One matcher per thread: nucleo's matcher holds scratch memory.
pub struct Ranker {
    matcher: Matcher,
    indices: Vec<u32>,
}

impl Default for Ranker {
    fn default() -> Self {
        Self::new()
    }
}

impl Ranker {
    pub fn new() -> Self {
        Ranker {
            matcher: Matcher::new(Config::DEFAULT),
            indices: Vec::new(),
        }
    }

    /// Ranks `records` for `query`, best first. `boost` adds the use bonus.
    pub fn rank(
        &mut self,
        records: &[Record],
        query: &str,
        boost: &dyn Fn(&Record) -> f32,
    ) -> Vec<Hit> {
        let query = query.trim();
        if query.is_empty() {
            return Vec::new();
        }
        let query_lower = query.to_lowercase();
        let query_words = split_words(&query_lower);
        let pattern = Pattern::new(
            query,
            CaseMatching::Ignore,
            Normalization::Smart,
            AtomKind::Fuzzy,
        );
        let length = query.chars().count() as f32;
        let mut hits = Vec::new();
        for (index, record) in records.iter().enumerate() {
            let name_score = self.clean_score(&pattern, &record.name32);
            let program_score = self.clean_score(&pattern, &record.program32);
            let mut score = name_score.map_or(0.0, |s| s as f32);
            score = score.max(program_score.map_or(0.0, |s| s as f32 * 0.8));
            let words_match = !query_words.is_empty()
                && query_words
                    .iter()
                    .all(|q| record.words.iter().any(|w| w.starts_with(q.as_str())));
            if words_match {
                score = score.max(30.0 + 8.0 * length);
            }
            if score <= 0.0 {
                continue;
            }
            if record.name_lower.starts_with(&query_lower) {
                score += 60.0;
            } else if record
                .name_lower
                .split(' ')
                .any(|w| w.starts_with(&query_lower))
            {
                score += 30.0;
            }
            score += boost(record);
            hits.push(Hit { index, score });
        }
        hits.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.index.cmp(&b.index)));
        // Drop the weak tail: scattered letters that happen to match.
        if let Some(best) = hits.first().map(|h| h.score) {
            hits.retain(|h| h.score >= best * 0.35);
        }
        hits
    }

    /// The fuzzy score, but only for a clean match: one run of letters
    /// ("phin" in "Dolphin"), or runs that each start a word ("vsc" in
    /// "Visual Studio Code"). Scattered letters ("dol" in "Thunderbolt")
    /// score nothing.
    fn clean_score(&mut self, pattern: &Pattern, haystack: &Utf32String) -> Option<u32> {
        let score = pattern.score(haystack.slice(..), &mut self.matcher)?;
        self.indices.clear();
        pattern.indices(haystack.slice(..), &mut self.matcher, &mut self.indices)?;
        self.indices.sort_unstable();
        self.indices.dedup();
        let runs = ranges(&self.indices);
        if runs.len() <= pattern.atoms.len() {
            return Some(score);
        }
        let chars: Vec<char> = haystack.slice(..).chars().collect();
        let starts_word = |i: usize| {
            i == 0
                || !chars[i - 1].is_alphanumeric()
                || (chars[i].is_uppercase() && chars[i - 1].is_lowercase())
        };
        runs.iter().all(|run| starts_word(run[0])).then_some(score)
    }

    /// The highlighted letters of `record.name` for `query`, as ranges.
    pub fn highlight(&mut self, record: &Record, query: &str) -> Vec<[usize; 2]> {
        let pattern = Pattern::new(
            query.trim(),
            CaseMatching::Ignore,
            Normalization::Smart,
            AtomKind::Fuzzy,
        );
        self.indices.clear();
        if pattern
            .indices(
                record.name32.slice(..),
                &mut self.matcher,
                &mut self.indices,
            )
            .is_none()
        {
            return Vec::new();
        }
        self.indices.sort_unstable();
        self.indices.dedup();
        ranges(&self.indices)
    }
}

/// [1, 2, 3, 7] -> [[1, 4], [7, 8]]
pub fn ranges(indices: &[u32]) -> Vec<[usize; 2]> {
    let mut out: Vec<[usize; 2]> = Vec::new();
    for &i in indices {
        let i = i as usize;
        match out.last_mut() {
            Some(last) if last[1] == i => last[1] = i + 1,
            _ => out.push([i, i + 1]),
        }
    }
    out
}

/// Score a name directly (used by the tests).
#[cfg(test)]
pub fn fuzzy_score(name: &str, query: &str) -> Option<u32> {
    let mut matcher = Matcher::new(Config::DEFAULT);
    let pattern = Pattern::new(
        query,
        CaseMatching::Ignore,
        Normalization::Smart,
        AtomKind::Fuzzy,
    );
    let mut buffer = Vec::new();
    pattern.score(
        nucleo_matcher::Utf32Str::new(name, &mut buffer),
        &mut matcher,
    )
}

/// The apps and settings pages, built from the desktop entries.
#[derive(Debug, Clone, Default)]
pub struct Catalog {
    pub apps: Vec<Record>,
    pub settings: Vec<Record>,
    pub app_by_id: HashMap<String, usize>,
}

impl Catalog {
    pub fn build(entries: &[Entry], desktops: &[String]) -> Self {
        let mut catalog = Catalog::default();
        for entry in entries {
            if entry.is_settings_module() && !entry.hidden {
                let module = module_name(&entry.exec);
                let aliases: Vec<String> = settings_aliases(&module)
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                catalog.settings.push(Record::from_entry(entry, &aliases));
            } else if entry.is_listed_app(desktops) {
                catalog
                    .app_by_id
                    .insert(entry.id.clone(), catalog.apps.len());
                catalog.apps.push(Record::from_entry(entry, &[]));
            }
        }
        catalog
    }

    pub fn app(&self, id: &str) -> Option<&Record> {
        self.app_by_id.get(id).map(|&i| &self.apps[i])
    }
}

/// "systemsettings kcm_networkmanagement" -> "kcm_networkmanagement"
pub fn module_name(exec: &str) -> String {
    exec.split_whitespace()
        .find(|w| w.starts_with("kcm_"))
        .unwrap_or("")
        .to_string()
}

/// Everyday words for settings pages whose own keywords miss them.
fn settings_aliases(module: &str) -> &'static [&'static str] {
    match module {
        "kcm_networkmanagement" => &["wifi", "wlan", "internet", "ethernet", "vpn"],
        "kcm_pulseaudio" => &["sound", "audio", "volume", "speaker", "microphone", "mic"],
        "kcm_kscreen" => &[
            "display",
            "monitor",
            "screen",
            "resolution",
            "refresh",
            "scale",
        ],
        "kcm_bluetooth" => &["bluetooth", "headphones", "pair"],
        "kcm_powerdevilprofilesconfig" => &["power", "battery", "sleep", "suspend"],
        "kcm_mouse" | "kcm_touchpad" => &["mouse", "pointer", "cursor", "touchpad"],
        "kcm_keyboard" => &["keyboard", "layout", "language"],
        "kcm_keys" => &["shortcuts", "hotkeys", "keys"],
        "kcm_wallpaper" => &["wallpaper", "background"],
        "kcm_lookandfeel" => &["theme", "global", "appearance"],
        "kcm_colors" => &["colors", "colours", "dark", "light", "accent"],
        "kcm_fonts" => &["fonts", "text", "size"],
        "kcm_icons" => &["icons"],
        "kcm_users" => &["users", "account", "password", "avatar"],
        "kcm_clock" => &["date", "time", "timezone", "clock"],
        "kcm_regionandlang" => &["language", "region", "locale", "format"],
        "kcm_printer_manager" => &["printer", "print"],
        "kcm_notifications" => &["notifications", "alerts"],
        "kcm_nightlight" => &["night", "blue", "warm"],
        "kcm_about-distro" => &["about", "system", "info", "version", "hardware"],
        _ => &[],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::parse;

    fn entry(id: &str, text: &str) -> Entry {
        let mut entry = parse(text);
        entry.id = id.to_string();
        entry
    }

    fn sample() -> Catalog {
        let entries = vec![
            entry(
                "org.kde.dolphin.desktop",
                "[Desktop Entry]\nType=Application\nName=Dolphin\nGenericName=File Manager\nKeywords=files;explorer;\nExec=dolphin %u\n",
            ),
            entry(
                "google-chrome.desktop",
                "[Desktop Entry]\nType=Application\nName=Google Chrome\nGenericName=Web Browser\nExec=/usr/bin/google-chrome-stable %U\n",
            ),
            entry(
                "code.desktop",
                "[Desktop Entry]\nType=Application\nName=Visual Studio Code\nGenericName=Text Editor\nExec=/usr/bin/code %F\n",
            ),
            entry(
                "org.kde.okular.desktop",
                "[Desktop Entry]\nType=Application\nName=Okular\nGenericName=Document Viewer\nExec=okular %U\n",
            ),
            entry(
                "kcm_networkmanagement.desktop",
                "[Desktop Entry]\nType=Application\nNoDisplay=true\nName=Wi-Fi & Networking\nExec=systemsettings kcm_networkmanagement\n",
            ),
        ];
        Catalog::build(&entries, &["KDE".into()])
    }

    fn top(catalog: &Catalog, records: &[Record], query: &str) -> String {
        let mut ranker = Ranker::new();
        let hits = ranker.rank(records, query, &|_| 0.0);
        let _ = catalog;
        hits.first()
            .map(|h| records[h.index].id.clone())
            .unwrap_or_default()
    }

    #[test]
    fn splits_apps_and_settings() {
        let catalog = sample();
        assert_eq!(catalog.apps.len(), 4);
        assert_eq!(catalog.settings.len(), 1);
    }

    #[test]
    fn ranks_by_name_first() {
        let catalog = sample();
        assert_eq!(
            top(&catalog, &catalog.apps, "dol"),
            "org.kde.dolphin.desktop"
        );
        assert_eq!(
            top(&catalog, &catalog.apps, "chrome"),
            "google-chrome.desktop"
        );
        assert_eq!(top(&catalog, &catalog.apps, "vsc"), "code.desktop");
        assert_eq!(top(&catalog, &catalog.apps, "code"), "code.desktop");
    }

    #[test]
    fn finds_by_generic_name_and_keywords() {
        let catalog = sample();
        assert_eq!(
            top(&catalog, &catalog.apps, "file manager"),
            "org.kde.dolphin.desktop"
        );
        assert_eq!(
            top(&catalog, &catalog.apps, "explorer"),
            "org.kde.dolphin.desktop"
        );
        assert_eq!(
            top(&catalog, &catalog.apps, "browser"),
            "google-chrome.desktop"
        );
    }

    #[test]
    fn settings_aliases_find_wifi() {
        let catalog = sample();
        assert_eq!(
            top(&catalog, &catalog.settings, "wifi"),
            "kcm_networkmanagement.desktop"
        );
        assert_eq!(
            top(&catalog, &catalog.settings, "internet"),
            "kcm_networkmanagement.desktop"
        );
    }

    #[test]
    fn use_bonus_breaks_ties() {
        let catalog = sample();
        let mut ranker = Ranker::new();
        let boost = |r: &Record| {
            if r.id == "org.kde.okular.desktop" {
                500.0
            } else {
                0.0
            }
        };
        let hits = ranker.rank(&catalog.apps, "o", &boost);
        assert_eq!(catalog.apps[hits[0].index].id, "org.kde.okular.desktop");
    }

    #[test]
    fn highlight_ranges() {
        let catalog = sample();
        let mut ranker = Ranker::new();
        let dolphin = catalog.app("org.kde.dolphin.desktop").unwrap();
        assert_eq!(ranker.highlight(dolphin, "dol"), vec![[0, 3]]);
        assert_eq!(ranges(&[1, 2, 3, 7]), vec![[1, 4], [7, 8]]);
    }

    #[test]
    fn scattered_letters_do_not_match() {
        let entries = vec![entry(
            "kcm_bolt.desktop",
            "[Desktop Entry]\nType=Application\nName=Thunderbolt\nExec=systemsettings kcm_bolt\n",
        )];
        let catalog = Catalog::build(&entries, &["KDE".into()]);
        let mut ranker = Ranker::new();
        assert!(ranker.rank(&catalog.settings, "dol", &|_| 0.0).is_empty());
        assert_eq!(ranker.rank(&catalog.settings, "bolt", &|_| 0.0).len(), 1);
        assert_eq!(ranker.rank(&catalog.settings, "thb", &|_| 0.0).len(), 0);
    }

    #[test]
    fn no_match_no_hit() {
        let catalog = sample();
        let mut ranker = Ranker::new();
        assert!(ranker.rank(&catalog.apps, "zzzq", &|_| 0.0).is_empty());
        assert!(fuzzy_score("Dolphin", "dlp").is_some());
    }
}
