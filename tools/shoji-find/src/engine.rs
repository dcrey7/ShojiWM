//! Puts the sources together: one query in, one `Results` out.
//!
//! Section order, as the mockup shows it:
//!
//! ```text
//!   math      "19*4+2" -> 78                 (only when the query is maths)
//!   top       the best app (else the best setting, else the best file)
//!   apps      the next 8 apps
//!   files     the best 8 names under ~        (2+ characters)
//!   settings  the best 5 KDE settings pages
//!   web       "Search the web for ..."       (always last)
//! ```

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use crate::catalog::{module_name, Catalog, Hit, Ranker, Record};
use crate::desktop::{application_dirs, current_desktops, home_dir, load_all};
use crate::files::{FileHit, FileIndex, SharedIndex};
use crate::icons::IconResolver;
use crate::kcm_meta::{self, Meta};
use crate::math;
use crate::meaning::{self, MeaningEngine};
use crate::protocol::{Action, App, HomeData, Item, Results, Section};
use crate::usage::{default_ids, recommended_ids, Usage};

pub const APP_LIMIT: usize = 8;
pub const FILE_LIMIT: usize = 8;
pub const SETTINGS_LIMIT: usize = 5;

pub struct Engine {
    catalog: RwLock<Arc<Catalog>>,
    pub files: SharedIndex,
    pub icons: IconResolver,
    pub usage: Mutex<Usage>,
    pub meaning: Box<dyn MeaningEngine>,
    /// Settings plugin metadata, read once per module.
    kcm_cache: Mutex<HashMap<String, Meta>>,
    pub app_dirs: Vec<PathBuf>,
    desktops: Vec<String>,
    browser: String,
}

impl Engine {
    /// Loads the apps and the use history. The file index starts empty;
    /// `files::start` fills it in the background.
    pub fn new() -> Self {
        let app_dirs = application_dirs();
        let desktops = current_desktops();
        let catalog = Catalog::build(&load_all(&app_dirs), &desktops);
        Engine {
            catalog: RwLock::new(Arc::new(catalog)),
            files: Arc::new(RwLock::new(Arc::new(FileIndex::default()))),
            icons: IconResolver::new(),
            usage: Mutex::new(Usage::load()),
            meaning: meaning::engine(),
            kcm_cache: Mutex::new(HashMap::new()),
            app_dirs,
            desktops,
            browser: default_browser(),
        }
    }

    pub fn catalog(&self) -> Arc<Catalog> {
        self.catalog.read().unwrap().clone()
    }

    pub fn file_index(&self) -> Arc<FileIndex> {
        self.files.read().unwrap().clone()
    }

    /// Reads the `.desktop` files again (after an install or a removal).
    pub fn reload_apps(&self) {
        let mut catalog = Catalog::build(&load_all(&self.app_dirs), &self.desktops);
        self.add_settings_keywords(&mut catalog);
        *self.catalog.write().unwrap() = Arc::new(catalog);
    }

    /// Reads the keywords of the settings plugins ("wifi" for the network
    /// page). Slow the first time (~100 plugin files), so it runs off the
    /// fast path; later reloads use the cache.
    pub fn enrich_settings(&self) {
        let mut catalog = (*self.catalog()).clone();
        self.add_settings_keywords(&mut catalog);
        *self.catalog.write().unwrap() = Arc::new(catalog);
    }

    fn add_settings_keywords(&self, catalog: &mut Catalog) {
        let mut cache = self.kcm_cache.lock().unwrap();
        let missing = catalog
            .settings
            .iter()
            .any(|r| !cache.contains_key(&module_name(&r.command)));
        let plugins = if missing {
            kcm_meta::find_plugins()
        } else {
            HashMap::new()
        };
        for record in &mut catalog.settings {
            let module = module_name(&record.command);
            let meta = cache.entry(module.clone()).or_insert_with(|| {
                plugins
                    .get(&module)
                    .map(|p| kcm_meta::read(p))
                    .unwrap_or_default()
            });
            record.add_words(&meta.keywords);
            record.set_sub(&meta.description);
        }
        // Drop the Plasma Mobile pages (phone Wi-Fi, hotspot, ...).
        catalog.settings.retain(|r| {
            cache
                .get(&module_name(&r.command))
                .is_none_or(Meta::for_desktop)
        });
    }

    /// Resolves every app and settings icon once, so queries hit the cache.
    pub fn warm_icons(&self) {
        let catalog = self.catalog();
        for record in catalog.apps.iter().chain(catalog.settings.iter()) {
            self.icons.resolve(&record.icon_name);
        }
        for name in FILE_ICONS.iter().map(|(_, icon)| *icon) {
            self.icons.resolve(name);
        }
    }

    pub fn app(&self, record: &Record) -> App {
        App {
            id: record.id.clone(),
            name: record.name.clone(),
            icon: self.icons.resolve(&record.icon_name),
            exec: record.command.clone(),
        }
    }

    fn record_item(&self, record: &Record, highlight: Vec<[usize; 2]>) -> Item {
        Item {
            id: record.id.clone(),
            title: record.name.clone(),
            sub: record.sub.clone(),
            icon: self.icons.resolve(&record.icon_name),
            chip: None,
            highlight,
            action: Action {
                kind: "exec",
                value: record.command.clone(),
            },
        }
    }

    fn file_item(&self, hit: FileHit) -> Item {
        Item {
            icon: self.icons.resolve(file_icon(&hit.name, hit.is_dir)),
            id: hit.path.clone(),
            title: hit.name,
            sub: hit.parent,
            chip: None,
            highlight: hit.highlight,
            action: Action {
                kind: "open",
                value: hit.path,
            },
        }
    }

    /// Ranks the apps (with the use bonus) and the settings pages.
    pub fn rank_catalog(
        &self,
        ranker: &mut Ranker,
        catalog: &Catalog,
        q: &str,
    ) -> (Vec<Hit>, Vec<Hit>) {
        let usage = self.usage.lock().unwrap();
        let boost = |record: &Record| usage.search_boost(&record.id);
        let mut apps = ranker.rank(&catalog.apps, q, &boost);
        apps.truncate(APP_LIMIT + 1);
        drop(usage);
        let mut settings = ranker.rank(&catalog.settings, q, &|_| 0.0);
        settings.truncate(SETTINGS_LIMIT + 1);
        (apps, settings)
    }

    pub fn search_files(&self, q: &str) -> Vec<FileHit> {
        self.file_index()
            .search(q, FILE_LIMIT, crate::usage::now() as u32)
    }

    /// The fast answer for one query.
    pub fn search(&self, ranker: &mut Ranker, id: i64, q: &str) -> Results {
        let q = q.trim();
        let mut results = Results {
            id,
            q: q.to_string(),
            sections: Vec::new(),
        };
        if q.is_empty() {
            return results;
        }
        let catalog = self.catalog();
        let (app_hits, setting_hits) = self.rank_catalog(ranker, &catalog, q);
        let to_item = |ranker: &mut Ranker, records: &[Record], hit: &Hit| {
            let record = &records[hit.index];
            self.record_item(record, ranker.highlight(record, q))
        };
        let mut apps: Vec<Item> = app_hits
            .iter()
            .map(|h| to_item(ranker, &catalog.apps, h))
            .collect();
        let mut settings: Vec<Item> = setting_hits
            .iter()
            .map(|h| to_item(ranker, &catalog.settings, h))
            .collect();
        let mut files: Vec<Item> = self
            .search_files(q)
            .into_iter()
            .map(|h| self.file_item(h))
            .collect();

        if let Some(value) = math::evaluate(q) {
            let item = Item {
                id: "math".into(),
                title: value.clone(),
                sub: format!("{q} ="),
                icon: self.icons.resolve("accessories-calculator"),
                chip: None,
                highlight: Vec::new(),
                action: Action {
                    kind: "copy",
                    value,
                },
            };
            results.sections.push(Section {
                kind: "math",
                items: vec![item],
            });
        }
        let top = if !apps.is_empty() {
            Some(apps.remove(0))
        } else if !settings.is_empty() {
            Some(settings.remove(0))
        } else if !files.is_empty() {
            Some(files.remove(0))
        } else {
            None
        };
        apps.truncate(APP_LIMIT);
        settings.truncate(SETTINGS_LIMIT);
        if let Some(item) = top {
            results.sections.push(Section {
                kind: "top",
                items: vec![item],
            });
        }
        for (kind, items) in [("apps", apps), ("files", files), ("settings", settings)] {
            if !items.is_empty() {
                results.sections.push(Section { kind, items });
            }
        }
        results.sections.push(Section {
            kind: "web",
            items: vec![self.web_item(q)],
        });
        results
    }

    fn web_item(&self, q: &str) -> Item {
        let catalog = self.catalog();
        let icon = catalog
            .app(&self.browser)
            .map(|r| self.icons.resolve(&r.icon_name))
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| self.icons.resolve("internet-web-browser"));
        Item {
            id: "web".into(),
            title: format!("Search the web for \"{q}\""),
            sub: "Google".into(),
            icon,
            chip: None,
            highlight: Vec::new(),
            action: Action {
                kind: "url",
                value: format!("https://www.google.com/search?q={}", url_encode(q)),
            },
        }
    }

    /// The two home grids.
    ///
    /// Before the first pin, Recommended comes first (recent and most used
    /// apps), and Pinned fills with the rest: most used, then well-known apps,
    /// then the others by name. After the first pin, Pinned is the user's list
    /// and Recommended skips it.
    pub fn home(&self) -> HomeData {
        let catalog = self.catalog();
        let mut usage = self.usage.lock().unwrap();
        usage.refresh();
        let exists = |id: &str| catalog.app(id).is_some();
        let most_used = usage.ranked_ids();
        let recent = usage.recent_ids();
        let mut by_name: Vec<&Record> = catalog.apps.iter().collect();
        by_name.sort_by_key(|r| r.name.to_lowercase());
        let by_name: Vec<String> = by_name.into_iter().map(|r| r.id.clone()).collect();
        let mut newest: Vec<&Record> = catalog.apps.iter().collect();
        newest.sort_by(|a, b| b.mtime.cmp(&a.mtime).then(a.name.cmp(&b.name)));
        let mut padding = default_ids();
        padding.extend(newest.into_iter().map(|r| r.id.clone()));

        let (recommended, pinned) = if usage.pins.is_some() {
            let pinned = usage.pinned_ids(&exists, &most_used, &[], &[]);
            (
                recommended_ids(&recent, &most_used, &pinned, &exists, &padding),
                pinned,
            )
        } else {
            let recommended = recommended_ids(&recent, &most_used, &[], &exists, &padding);
            let pinned = usage.pinned_ids(&exists, &most_used, &recommended, &by_name);
            (recommended, pinned)
        };
        drop(usage);
        let to_apps = |ids: &[String]| {
            ids.iter()
                .filter_map(|id| catalog.app(id))
                .map(|r| self.app(r))
                .collect()
        };
        HomeData {
            recommended: to_apps(&recommended),
            pinned: to_apps(&pinned),
        }
    }

    /// Pins or unpins an app.
    pub fn set_pin(&self, app_id: &str, pinned: bool) {
        let shown: Vec<String> = self.home().pinned.into_iter().map(|a| a.id).collect();
        self.usage.lock().unwrap().set_pin(app_id, pinned, &shown);
    }

    pub fn record_use(&self, app_id: &str) {
        self.usage.lock().unwrap().record_use(app_id);
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

/// File kinds and their theme icon names.
const FILE_ICONS: &[(&[&str], &str)] = &[
    (&["pdf"], "application-pdf"),
    (
        &[
            "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "heic", "avif",
        ],
        "image-x-generic",
    ),
    (&["mp4", "mkv", "webm", "mov", "avi"], "video-x-generic"),
    (
        &["mp3", "flac", "wav", "ogg", "m4a", "opus"],
        "audio-x-generic",
    ),
    (
        &["zip", "tar", "gz", "xz", "zst", "7z", "rar", "bz2"],
        "package-x-generic",
    ),
    (&["odt", "doc", "docx", "rtf"], "x-office-document"),
    (&["ods", "xls", "xlsx", "csv"], "x-office-spreadsheet"),
    (&["odp", "ppt", "pptx"], "x-office-presentation"),
    (&["html", "htm"], "text-html"),
    (
        &[
            "rs", "py", "ts", "tsx", "js", "json", "toml", "yaml", "yml", "c", "cpp", "h", "sh",
            "go",
        ],
        "text-x-script",
    ),
    (&["md", "txt", "log"], "text-x-generic"),
];

fn file_icon(name: &str, is_dir: bool) -> &'static str {
    if is_dir {
        return "folder";
    }
    let extension = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_lowercase())
        .unwrap_or_default();
    FILE_ICONS
        .iter()
        .find(|(extensions, _)| extensions.contains(&extension.as_str()))
        .map_or("text-x-generic", |(_, icon)| icon)
}

/// Percent-encodes a search for a URL ("a b&c" -> "a+b%26c").
pub fn url_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The desktop id of the default web browser, from mimeapps.list.
fn default_browser() -> String {
    let file = home_dir().join(".config/mimeapps.list");
    let text = std::fs::read_to_string(file).unwrap_or_default();
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("x-scheme-handler/https=") {
            if let Some(first) = value.split(';').find(|v| !v.is_empty()) {
                return first.trim().to_string();
            }
        }
    }
    "google-chrome.desktop".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_encoding() {
        assert_eq!(url_encode("a b&c"), "a+b%26c");
        assert_eq!(url_encode("café"), "caf%C3%A9");
    }

    #[test]
    fn file_icons() {
        assert_eq!(file_icon("x.PDF", false), "application-pdf");
        assert_eq!(file_icon("work", true), "folder");
        assert_eq!(file_icon("noext", false), "text-x-generic");
    }
}
