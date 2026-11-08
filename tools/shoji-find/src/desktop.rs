//! Reads the `.desktop` files of the apps and of the KDE settings pages.
//!
//! The XDG rules this follows:
//! - the dirs are `$XDG_DATA_HOME/applications`, then each
//!   `$XDG_DATA_DIRS/applications`; the first dir wins for a given id;
//! - the id is the path under `applications/`, with "/" turned into "-";
//! - `Hidden=true` deletes the entry, also the ones in later dirs;
//! - `NoDisplay`, `OnlyShowIn` and `NotShowIn` hide it from the app list.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// One parsed `[Desktop Entry]`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Entry {
    pub id: String,
    pub path: PathBuf,
    pub name: String,
    pub generic_name: String,
    pub comment: String,
    pub keywords: Vec<String>,
    pub exec: String,
    pub icon: String,
    pub no_display: bool,
    pub hidden: bool,
    pub terminal: bool,
    pub only_show_in: Vec<String>,
    pub not_show_in: Vec<String>,
    pub is_application: bool,
    /// The modification time of the file, in seconds.
    pub mtime: u64,
}

impl Entry {
    /// True when the desktop `desktop` (for example "KDE") shows this entry.
    pub fn shown_in(&self, desktop: &[String]) -> bool {
        if !self.only_show_in.is_empty() && !self.only_show_in.iter().any(|d| desktop.contains(d)) {
            return false;
        }
        !self.not_show_in.iter().any(|d| desktop.contains(d))
    }

    /// True for an entry that belongs in the app grid and the app search.
    pub fn is_listed_app(&self, desktop: &[String]) -> bool {
        self.is_application
            && !self.no_display
            && !self.hidden
            && !self.exec.is_empty()
            && !self.name.is_empty()
            && self.shown_in(desktop)
    }

    /// True for a KDE settings page (System Settings module).
    pub fn is_settings_module(&self) -> bool {
        let program = self.exec.split_whitespace().next().unwrap_or("");
        let has_module = self.exec.split_whitespace().any(|w| w.starts_with("kcm_"));
        (program == "systemsettings" || program == "kcmshell6") && has_module
    }

    /// The command line to run: field codes removed, wrapped for a terminal.
    pub fn command(&self) -> String {
        let command = strip_field_codes(&self.exec);
        if self.terminal {
            return format!("konsole -e {command}");
        }
        command
    }
}

/// Parses the text of one `.desktop` file. Only the `[Desktop Entry]` group
/// counts, and only the untranslated keys.
pub fn parse(text: &str) -> Entry {
    let mut entry = Entry::default();
    let mut in_main_group = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            in_main_group = line == "[Desktop Entry]";
            continue;
        }
        if !in_main_group {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = unescape(value.trim());
        match key {
            "Type" => entry.is_application = value == "Application",
            "Name" => entry.name = value,
            "GenericName" => entry.generic_name = value,
            "Comment" => entry.comment = value,
            "Keywords" | "X-KDE-Keywords" => entry.keywords.extend(split_list(&value)),
            "Exec" => entry.exec = value,
            "Icon" => entry.icon = value,
            "NoDisplay" => entry.no_display = value == "true",
            "Hidden" => entry.hidden = value == "true",
            "Terminal" => entry.terminal = value == "true",
            "OnlyShowIn" => entry.only_show_in = split_list(&value),
            "NotShowIn" => entry.not_show_in = split_list(&value),
            _ => {}
        }
    }
    entry
}

/// Splits a `;` or `,` separated list and drops the empty parts.
fn split_list(value: &str) -> Vec<String> {
    value
        .split([';', ','])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(String::from)
        .collect()
}

/// Turns `\s`, `\n`, `\t` and `\\` into their characters.
fn unescape(value: &str) -> String {
    if !value.contains('\\') {
        return value.to_string();
    }
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('s') => out.push(' '),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// Removes the field codes (`%f %F %u %U %i %c %k` and the old ones) and
/// turns `%%` into `%`.
pub fn strip_field_codes(exec: &str) -> String {
    let mut out = String::with_capacity(exec.len());
    let mut chars = exec.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        // "%%" is a real "%"; any other "%x" is a field code and goes away.
        if chars.next() == Some('%') {
            out.push('%');
        }
    }
    // Field codes leave double spaces and a trailing space behind.
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The data dirs in XDG order: the user's own dir first.
pub fn data_dirs() -> Vec<PathBuf> {
    let home = home_dir();
    let mut dirs = Vec::new();
    match std::env::var("XDG_DATA_HOME") {
        Ok(value) if !value.is_empty() => dirs.push(PathBuf::from(value)),
        _ => dirs.push(home.join(".local/share")),
    }
    if let Ok(value) = std::env::var("XDG_DATA_DIRS") {
        dirs.extend(
            value
                .split(':')
                .filter(|d| !d.is_empty())
                .map(PathBuf::from),
        );
    }
    // The session may start helpers without the flatpak dirs in the
    // environment, so add the usual ones as well.
    dirs.push(home.join(".local/share/flatpak/exports/share"));
    dirs.push(PathBuf::from("/var/lib/flatpak/exports/share"));
    dirs.push(PathBuf::from("/usr/local/share"));
    dirs.push(PathBuf::from("/usr/share"));
    let mut seen = HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

/// The `applications` dirs that exist, in XDG order.
pub fn application_dirs() -> Vec<PathBuf> {
    data_dirs()
        .into_iter()
        .map(|d| d.join("applications"))
        .filter(|d| d.is_dir())
        .collect()
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// The current desktop names, for `OnlyShowIn` and `NotShowIn`.
pub fn current_desktops() -> Vec<String> {
    let value = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    let mut names: Vec<String> = split_list(&value.replace(':', ";"));
    if !names.iter().any(|n| n == "KDE") {
        names.push("KDE".into());
    }
    names
}

/// Reads every `.desktop` file of `dirs`. The first dir wins for each id,
/// so a user copy hides the system one (also with `Hidden=true`).
pub fn load_all(dirs: &[PathBuf]) -> Vec<Entry> {
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for dir in dirs {
        let mut files = Vec::new();
        collect_files(dir, dir, &mut files, 0);
        for (id, path) in files {
            if !seen.insert(id.clone()) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let mut entry = parse(&text);
            entry.id = id;
            entry.mtime = std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            entry.path = path;
            entries.push(entry);
        }
    }
    entries
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>, depth: usize) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for item in read.flatten() {
        let path = item.path();
        let Ok(kind) = item.file_type() else {
            continue;
        };
        // Follow symlinks for files (flatpak exports are symlinks).
        if kind.is_dir() || (kind.is_symlink() && path.is_dir()) {
            if depth < 4 {
                collect_files(root, &path, out, depth + 1);
            }
            continue;
        }
        if path.extension().is_some_and(|e| e == "desktop") {
            if let Ok(relative) = path.strip_prefix(root) {
                let id = relative.to_string_lossy().replace('/', "-");
                out.push((id, path));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOLPHIN: &str = "\
[Desktop Entry]
Type=Application
Name=Dolphin
Name[fr]=Dauphin
GenericName=File Manager
Keywords=files;folders;explorer;
Exec=dolphin %u
Icon=org.kde.dolphin

[Desktop Action new]
Name=Should not count
Exec=dolphin --new-window
";

    #[test]
    fn reads_the_main_group_only() {
        let entry = parse(DOLPHIN);
        assert_eq!(entry.name, "Dolphin");
        assert_eq!(entry.generic_name, "File Manager");
        assert_eq!(entry.keywords, vec!["files", "folders", "explorer"]);
        assert_eq!(entry.exec, "dolphin %u");
        assert_eq!(entry.command(), "dolphin");
        assert_eq!(entry.icon, "org.kde.dolphin");
        assert!(entry.is_application);
        assert!(entry.is_listed_app(&["KDE".into()]));
    }

    #[test]
    fn field_codes_and_escapes() {
        assert_eq!(strip_field_codes("app --x %F"), "app --x");
        assert_eq!(strip_field_codes("app %U --y"), "app --y");
        assert_eq!(strip_field_codes("printf 100%%"), "printf 100%");
        let entry = parse("[Desktop Entry]\nType=Application\nName=A\\sB\nExec=a\n");
        assert_eq!(entry.name, "A B");
    }

    #[test]
    fn honours_visibility_rules() {
        let kde = vec!["KDE".to_string()];
        let base = "[Desktop Entry]\nType=Application\nName=X\nExec=x\n";
        assert!(parse(base).is_listed_app(&kde));
        assert!(!parse(&format!("{base}NoDisplay=true\n")).is_listed_app(&kde));
        assert!(!parse(&format!("{base}Hidden=true\n")).is_listed_app(&kde));
        assert!(!parse(&format!("{base}OnlyShowIn=GNOME;XFCE;\n")).is_listed_app(&kde));
        assert!(parse(&format!("{base}OnlyShowIn=KDE;\n")).is_listed_app(&kde));
        assert!(!parse(&format!("{base}NotShowIn=KDE;\n")).is_listed_app(&kde));
        assert!(!parse("[Desktop Entry]\nType=Link\nName=X\nExec=x\n").is_listed_app(&kde));
    }

    #[test]
    fn terminal_apps_open_in_konsole() {
        let entry = parse("[Desktop Entry]\nType=Application\nName=H\nExec=htop\nTerminal=true\n");
        assert_eq!(entry.command(), "konsole -e htop");
    }

    #[test]
    fn spots_settings_modules() {
        let net = parse(
            "[Desktop Entry]\nType=Application\nNoDisplay=true\nExec=systemsettings kcm_networkmanagement\nName=Wi-Fi & Networking\n",
        );
        assert!(net.is_settings_module());
        assert!(!net.is_listed_app(&["KDE".into()]));
        assert!(!parse(DOLPHIN).is_settings_module());
    }
}
