//! Turns an icon name ("org.kde.dolphin") into an absolute file path.
//!
//! The order of the search:
//!
//! ```text
//!   the user's theme (kdeglobals [Icons] Theme)
//!     -> its Inherits chain, one theme after the other
//!     -> hicolor
//!     -> /usr/share/pixmaps
//! ```
//!
//! In each theme an SVG wins over a PNG, and a big PNG wins over a small one.
//! Each answer is cached, so a name costs the file checks only once.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::desktop::{data_dirs, home_dir};

struct Theme {
    /// The dirs of this theme that exist, biggest icons first.
    dirs: Vec<PathBuf>,
}

pub struct IconResolver {
    themes: Vec<Theme>,
    pixmaps: Vec<PathBuf>,
    cache: Mutex<HashMap<String, String>>,
}

impl IconResolver {
    /// Reads the theme chain of the user. This only parses a few
    /// `index.theme` files; the icons themselves are looked up later.
    pub fn new() -> Self {
        let bases = icon_bases();
        let mut themes = Vec::new();
        for name in theme_chain(&user_theme(), &bases) {
            let dirs = theme_dirs(&name, &bases);
            if !dirs.is_empty() {
                themes.push(Theme { dirs });
            }
        }
        let pixmaps = vec![PathBuf::from("/usr/share/pixmaps")];
        IconResolver {
            themes,
            pixmaps,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// Returns the absolute path of the icon, or "" when there is none.
    pub fn resolve(&self, name: &str) -> String {
        if name.is_empty() {
            return String::new();
        }
        if let Some(found) = self.cache.lock().unwrap().get(name) {
            return found.clone();
        }
        let found = self.lookup(name);
        self.cache
            .lock()
            .unwrap()
            .insert(name.to_string(), found.clone());
        found
    }

    fn lookup(&self, name: &str) -> String {
        if name.starts_with('/') {
            return if Path::new(name).is_file() {
                name.to_string()
            } else {
                String::new()
            };
        }
        let name = name
            .trim_end_matches(".png")
            .trim_end_matches(".svg")
            .trim_end_matches(".xpm");
        // "a-b-c" falls back to "a-b", then "a" (the icon spec rule).
        let mut candidate = name;
        loop {
            if let Some(path) = self.lookup_exact(candidate) {
                return path;
            }
            match candidate.rfind('-') {
                Some(cut) => candidate = &candidate[..cut],
                None => break,
            }
        }
        String::new()
    }

    fn lookup_exact(&self, name: &str) -> Option<String> {
        for theme in &self.themes {
            for extension in ["svg", "png"] {
                for dir in &theme.dirs {
                    let path = dir.join(format!("{name}.{extension}"));
                    if path.is_file() {
                        return Some(path.to_string_lossy().into_owned());
                    }
                }
            }
        }
        for dir in &self.pixmaps {
            for extension in ["svg", "png", "xpm"] {
                let path = dir.join(format!("{name}.{extension}"));
                if path.is_file() {
                    return Some(path.to_string_lossy().into_owned());
                }
            }
        }
        None
    }
}

impl Default for IconResolver {
    fn default() -> Self {
        Self::new()
    }
}

/// The dirs that may hold icon themes, in lookup order.
fn icon_bases() -> Vec<PathBuf> {
    let mut bases = vec![home_dir().join(".icons")];
    bases.extend(data_dirs().into_iter().map(|d| d.join("icons")));
    bases.retain(|b| b.is_dir());
    bases
}

/// The icon theme from KDE's settings, or "breeze".
fn user_theme() -> String {
    let config = home_dir().join(".config");
    for file in [
        config.join("kdeglobals"),
        config.join("kdedefaults/kdeglobals"),
    ] {
        if let Some(theme) = read_ini_value(&file, "Icons", "Theme") {
            return theme;
        }
    }
    "breeze".into()
}

/// Reads `key` in `[group]` of a small INI file.
fn read_ini_value(file: &Path, group: &str, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(file).ok()?;
    let header = format!("[{group}]");
    let mut in_group = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_group = line == header;
            continue;
        }
        if in_group {
            if let Some((k, v)) = line.split_once('=') {
                if k.trim() == key && !v.trim().is_empty() {
                    return Some(v.trim().to_string());
                }
            }
        }
    }
    None
}

/// The theme, then its Inherits chain (breadth first), then hicolor.
fn theme_chain(first: &str, bases: &[PathBuf]) -> Vec<String> {
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut queue = VecDeque::from([first.to_string()]);
    while let Some(name) = queue.pop_front() {
        if !seen.insert(name.clone()) {
            continue;
        }
        if let Some(index) = find_index(&name, bases) {
            if let Some(inherits) = read_ini_value(&index, "Icon Theme", "Inherits") {
                queue.extend(inherits.split(',').map(|s| s.trim().to_string()));
            }
        }
        chain.push(name);
    }
    // hicolor always comes last.
    chain.retain(|n| n != "hicolor");
    chain.push("hicolor".into());
    chain
}

fn find_index(theme: &str, bases: &[PathBuf]) -> Option<PathBuf> {
    bases
        .iter()
        .map(|b| b.join(theme).join("index.theme"))
        .find(|p| p.is_file())
}

/// The existing dirs of a theme, across all bases, ordered: scalable first,
/// then by pixel size, biggest first.
fn theme_dirs(theme: &str, bases: &[PathBuf]) -> Vec<PathBuf> {
    let Some(index) = find_index(theme, bases) else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(index) else {
        return Vec::new();
    };
    // Parse every [section] with its Size, Scale and Type.
    let mut sections: HashMap<String, (u32, u32, bool)> = HashMap::new();
    let mut listed: Vec<String> = Vec::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            current = Some(name.to_string());
            sections.entry(name.to_string()).or_insert((0, 1, false));
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        match (current.as_deref(), key) {
            (Some("Icon Theme"), "Directories" | "ScaledDirectories") => {
                listed.extend(
                    value
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty()),
                );
            }
            (Some(section), _) => {
                let info = sections.entry(section.to_string()).or_insert((0, 1, false));
                match key {
                    "Size" => info.0 = value.parse().unwrap_or(0),
                    "Scale" => info.1 = value.parse().unwrap_or(1),
                    "Type" => info.2 = value == "Scalable",
                    _ => {}
                }
            }
            _ => {}
        }
    }
    let mut seen = HashSet::new();
    listed.retain(|d| seen.insert(d.clone()));
    let mut ranked: Vec<(bool, u32, &String)> = listed
        .iter()
        .map(|dir| {
            let (size, scale, scalable) = sections.get(dir).copied().unwrap_or((0, 1, false));
            (
                scalable || dir.starts_with("scalable"),
                size * scale.max(1),
                dir,
            )
        })
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    let mut dirs = Vec::new();
    for (_, _, dir) in ranked {
        for base in bases {
            let path = base.join(theme).join(dir);
            if path.is_dir() {
                dirs.push(path);
            }
        }
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_common_icon_and_caches_it() {
        let icons = IconResolver::new();
        let path = icons.resolve("folder");
        // Every desktop has a folder icon; skip on a bare build box.
        if path.is_empty() {
            return;
        }
        assert!(path.starts_with('/'));
        assert_eq!(icons.resolve("folder"), path);
        assert_eq!(icons.resolve("no-such-icon-xyz-123"), "");
    }
}
