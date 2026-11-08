//! The file-name index: every file and folder name under $HOME, in RAM.
//!
//! Two parts:
//!
//! ```text
//!   Tree (the updater thread owns it)       FileIndex (what a query reads)
//!   ~/Downloads      -> [work/, a.pdf]  ──▶  lower: "work\na.pdf\n..."   one buffer
//!   ~/Downloads/work -> [...]   rebuilt     entries: start, folder, date
//!        ▲                      after each
//!        └── inotify: a folder changed,     A query scans `lower` once with
//!            read that folder again         SIMD (memchr), then ranks hits.
//! ```
//!
//! Skipped: hidden names, node_modules, target, __pycache__, venv, and
//! site-packages. If inotify runs out of watches, the index falls back to a
//! full rebuild every 10 minutes.

use std::collections::{HashMap, HashSet};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use inotify::{EventMask, Inotify, WatchDescriptor, WatchMask};

const SKIP_NAMES: &[&str] = &[
    "node_modules",
    "target",
    "__pycache__",
    "venv",
    "site-packages",
];
/// The folders users care about most get a bonus.
const PREFERRED: &[&str] = &[
    "Documents",
    "Downloads",
    "Desktop",
    "Pictures",
    "Music",
    "Videos",
];
/// Folders whose contents are mostly copies or generated files rank lower.
const NOISY: &[&str] = &[
    "backup",
    "backups",
    "third_party",
    "vendor",
    "dist",
    "build",
    "out",
    "tmp",
];
/// The same name shows at most this many times (8 copies of "code" help no one).
const SAME_NAME_MAX: usize = 2;
/// A safety cap on the whole index.
const MAX_ENTRIES: usize = 3_000_000;
/// A safety cap on one folder (a dataset of a million images, for example).
const MAX_CHILDREN: usize = 50_000;

#[derive(Debug, Clone)]
struct Child {
    name: String,
    is_dir: bool,
    mtime: u32,
}

#[derive(Debug, Clone)]
struct DirInfo {
    abs: String,
    display: String,
    depth: u16,
    preferred: bool,
    noisy: bool,
}

#[derive(Debug, Clone, Copy)]
struct FileEntry {
    lower_start: u32,
    lower_end: u32,
    orig_start: u32,
    orig_end: u32,
    dir: u32,
    mtime: u32,
    is_dir: bool,
}

/// A read-only snapshot that queries use.
#[derive(Debug, Default)]
pub struct FileIndex {
    lower: Vec<u8>,
    orig: String,
    entries: Vec<FileEntry>,
    dirs: Vec<DirInfo>,
}

/// One found file.
#[derive(Debug, Clone, PartialEq)]
pub struct FileHit {
    pub name: String,
    pub path: String,
    /// The parent folder, with $HOME as "~".
    pub parent: String,
    pub is_dir: bool,
    pub highlight: Vec<[usize; 2]>,
    pub score: i32,
}

impl FileIndex {
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The bytes this snapshot holds (for the memory report).
    pub fn bytes(&self) -> usize {
        self.lower.len()
            + self.orig.len()
            + self.entries.len() * std::mem::size_of::<FileEntry>()
            + self
                .dirs
                .iter()
                .map(|d| d.abs.len() + d.display.len() + 32)
                .sum::<usize>()
    }

    /// The best `limit` names that hold every word of `query`.
    /// Queries shorter than 2 characters return nothing.
    pub fn search(&self, query: &str, limit: usize, now: u32) -> Vec<FileHit> {
        let query = query.trim().to_lowercase();
        if query.chars().count() < 2 || self.is_empty() {
            return Vec::new();
        }
        let words: Vec<&str> = query.split_whitespace().collect();
        let Some(anchor) = words.iter().copied().max_by_key(|w| w.len()) else {
            return Vec::new();
        };
        let finder = memchr::memmem::Finder::new(anchor.as_bytes());
        let others: Vec<memchr::memmem::Finder> = words
            .iter()
            .filter(|w| **w != anchor)
            .map(|w| memchr::memmem::Finder::new(w.as_bytes()))
            .collect();

        // Keep extra candidates, so the same-name filter still fills `limit`.
        let keep = limit * 4;
        let mut best: Vec<(i32, usize)> = Vec::with_capacity(keep + 1);
        let mut last = usize::MAX;
        for pos in finder.find_iter(&self.lower) {
            let index = self
                .entries
                .partition_point(|e| e.lower_start as usize <= pos)
                - 1;
            if index == last {
                continue;
            }
            last = index;
            let entry = &self.entries[index];
            let name = &self.lower[entry.lower_start as usize..entry.lower_end as usize];
            if !others.iter().all(|f| f.find(name).is_some()) {
                continue;
            }
            let at = pos - entry.lower_start as usize;
            let score = self.score(entry, name, query.as_bytes(), at, now);
            if best.len() == keep && best.last().is_some_and(|b| b.0 >= score) {
                continue;
            }
            let slot = best.partition_point(|b| b.0 >= score);
            best.insert(slot, (score, index));
            best.truncate(keep);
        }
        let mut seen: HashMap<&[u8], usize> = HashMap::new();
        let mut hits = Vec::with_capacity(limit);
        for (score, index) in best {
            let entry = &self.entries[index];
            let name = &self.lower[entry.lower_start as usize..entry.lower_end as usize];
            let count = seen.entry(name).or_default();
            *count += 1;
            if *count > SAME_NAME_MAX {
                continue;
            }
            hits.push(self.hit(index, &words, score));
            if hits.len() == limit {
                break;
            }
        }
        hits
    }

    fn score(&self, entry: &FileEntry, name: &[u8], query: &[u8], at: usize, now: u32) -> i32 {
        let dir = &self.dirs[entry.dir as usize];
        let stem = match name.iter().rposition(|&b| b == b'.') {
            Some(dot) if dot > 0 => &name[..dot],
            _ => name,
        };
        let mut score = if stem == query || name == query {
            1000
        } else if name.starts_with(query) {
            800
        } else if at == 0 || b" _-.()[]".contains(&name[at - 1]) {
            600
        } else {
            400
        };
        if entry.is_dir {
            score += 30;
        }
        if dir.preferred {
            score += 60;
        }
        if dir.noisy {
            score -= 150;
        }
        score -= 15 * dir.depth as i32;
        score -= 2 * name.len().min(80) as i32;
        let age_days = now.saturating_sub(entry.mtime) / 86_400;
        score += match age_days {
            0..=7 => 80,
            8..=30 => 40,
            31..=365 => 10,
            _ => 0,
        };
        score
    }

    fn hit(&self, index: usize, words: &[&str], score: i32) -> FileHit {
        let entry = &self.entries[index];
        let dir = &self.dirs[entry.dir as usize];
        let name = &self.orig[entry.orig_start as usize..entry.orig_end as usize];
        FileHit {
            name: name.to_string(),
            path: format!("{}/{}", dir.abs, name),
            parent: dir.display.clone(),
            is_dir: entry.is_dir,
            highlight: highlight(name, words),
            score,
        }
    }
}

/// The character ranges of each word inside `name` (case ignored).
pub fn highlight(name: &str, words: &[&str]) -> Vec<[usize; 2]> {
    let lower: Vec<char> = name.chars().flat_map(char::to_lowercase).collect();
    let mut ranges: Vec<[usize; 2]> = Vec::new();
    for word in words {
        let word: Vec<char> = word.chars().collect();
        if word.is_empty() || word.len() > lower.len() {
            continue;
        }
        if let Some(start) = lower.windows(word.len()).position(|w| w == word.as_slice()) {
            ranges.push([start, start + word.len()]);
        }
    }
    ranges.sort();
    // Merge ranges that touch.
    let mut merged: Vec<[usize; 2]> = Vec::new();
    for range in ranges {
        match merged.last_mut() {
            Some(last) if range[0] <= last[1] => last[1] = last[1].max(range[1]),
            _ => merged.push(range),
        }
    }
    merged
}

/// The folder tree the updater keeps, one list of children per folder.
#[derive(Debug, Default)]
struct Tree {
    dirs: HashMap<PathBuf, Vec<Child>>,
    count: usize,
}

fn skip(name: &str) -> bool {
    name.starts_with('.') || SKIP_NAMES.contains(&name)
}

#[cfg(test)]
fn now_secs() -> u32 {
    use std::time::SystemTime;
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as u32)
}

/// Reads one folder (not its subfolders).
fn read_children(dir: &Path) -> Option<Vec<Child>> {
    let read = std::fs::read_dir(dir).ok()?;
    let mut children = Vec::new();
    for item in read.flatten() {
        if children.len() >= MAX_CHILDREN {
            break;
        }
        let name = item.file_name().to_string_lossy().into_owned();
        if skip(&name) {
            continue;
        }
        let Ok(meta) = item.metadata() else {
            continue;
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs() as u32);
        // Symlinks stay plain entries: the walk never follows them.
        children.push(Child {
            name,
            is_dir: meta.is_dir(),
            mtime,
        });
    }
    Some(children)
}

impl Tree {
    /// Reads `root` and every folder below it. Calls `on_dir` for each
    /// folder read (the watcher adds an inotify watch there).
    fn walk(&mut self, root: &Path, on_dir: &mut dyn FnMut(&Path)) {
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            if self.count >= MAX_ENTRIES {
                break;
            }
            let Some(children) = read_children(&dir) else {
                continue;
            };
            on_dir(&dir);
            for child in &children {
                if child.is_dir {
                    stack.push(dir.join(&child.name));
                }
            }
            self.count += children.len();
            if let Some(old) = self.dirs.insert(dir, children) {
                self.count -= old.len();
            }
        }
    }

    /// Removes `dir` and every folder below it. Returns the removed paths.
    fn drop_subtree(&mut self, dir: &Path) -> Vec<PathBuf> {
        let gone: Vec<PathBuf> = self
            .dirs
            .keys()
            .filter(|p| p.starts_with(dir))
            .cloned()
            .collect();
        for path in &gone {
            if let Some(old) = self.dirs.remove(path) {
                self.count -= old.len();
            }
        }
        gone
    }

    fn snapshot(&self, home: &Path) -> FileIndex {
        let mut paths: Vec<&PathBuf> = self.dirs.keys().collect();
        paths.sort();
        let mut index = FileIndex {
            lower: Vec::with_capacity(self.count * 16),
            orig: String::with_capacity(self.count * 16),
            entries: Vec::with_capacity(self.count),
            dirs: Vec::with_capacity(paths.len()),
        };
        for path in paths {
            let relative = path.strip_prefix(home).unwrap_or(path);
            let first = relative
                .components()
                .next()
                .map(|c| c.as_os_str().to_string_lossy());
            let display = if relative.as_os_str().is_empty() {
                "~".to_string()
            } else if path.starts_with(home) {
                format!("~/{}", relative.to_string_lossy())
            } else {
                path.to_string_lossy().into_owned()
            };
            let dir_index = index.dirs.len() as u32;
            index.dirs.push(DirInfo {
                abs: path.to_string_lossy().into_owned(),
                display,
                depth: relative.components().count() as u16,
                preferred: first.is_some_and(|f| PREFERRED.contains(&f.as_ref())),
                noisy: relative.components().any(|c| {
                    NOISY.contains(&c.as_os_str().to_string_lossy().to_lowercase().as_str())
                }),
            });
            for child in &self.dirs[path] {
                let lower_start = index.lower.len() as u32;
                index.lower.extend(child.name.to_lowercase().bytes());
                let lower_end = index.lower.len() as u32;
                index.lower.push(b'\n');
                let orig_start = index.orig.len() as u32;
                index.orig.push_str(&child.name);
                index.entries.push(FileEntry {
                    lower_start,
                    lower_end,
                    orig_start,
                    orig_end: index.orig.len() as u32,
                    dir: dir_index,
                    mtime: child.mtime,
                    is_dir: child.is_dir,
                });
            }
        }
        index
    }
}

/// The shared, swappable snapshot.
pub type SharedIndex = Arc<RwLock<Arc<FileIndex>>>;

/// Builds the index once, for tests and for `--query` without a watcher.
pub fn build_once(root: &Path) -> FileIndex {
    let mut tree = Tree::default();
    tree.walk(root, &mut |_| {});
    tree.snapshot(root)
}

/// Builds the index in the background and keeps it fresh. Returns at once.
/// `on_ready` runs after the first build with the time it took.
pub fn start(
    root: PathBuf,
    shared: SharedIndex,
    on_ready: Box<dyn FnOnce(Duration, usize) + Send>,
) {
    std::thread::Builder::new()
        .name("files".into())
        .spawn(move || Updater::run(root, shared, on_ready))
        .expect("spawn the file index thread");
}

struct Updater {
    root: PathBuf,
    tree: Tree,
    inotify: Option<Inotify>,
    by_wd: HashMap<WatchDescriptor, PathBuf>,
    by_path: HashMap<PathBuf, WatchDescriptor>,
    watches_full: bool,
}

impl Updater {
    fn run(root: PathBuf, shared: SharedIndex, on_ready: Box<dyn FnOnce(Duration, usize) + Send>) {
        let started = Instant::now();
        let mut updater = Updater {
            root: root.clone(),
            tree: Tree::default(),
            inotify: Inotify::init().ok(),
            by_wd: HashMap::new(),
            by_path: HashMap::new(),
            watches_full: false,
        };
        updater.full_walk();
        updater.publish(&shared);
        on_ready(started.elapsed(), updater.tree.count);
        updater.watch_loop(&shared);
    }

    fn publish(&self, shared: &SharedIndex) {
        let snapshot = Arc::new(self.tree.snapshot(&self.root));
        *shared.write().unwrap() = snapshot;
    }

    fn full_walk(&mut self) {
        if let Some(inotify) = &mut self.inotify {
            for wd in self.by_wd.keys() {
                let _ = inotify.watches().remove(wd.clone());
            }
        }
        self.by_wd.clear();
        self.by_path.clear();
        self.watches_full = false;
        self.tree = Tree::default();
        let root = self.root.clone();
        let mut new_dirs = Vec::new();
        self.tree
            .walk(&root, &mut |dir| new_dirs.push(dir.to_path_buf()));
        for dir in new_dirs {
            self.add_watch(&dir);
        }
    }

    fn add_watch(&mut self, dir: &Path) {
        let Some(inotify) = &mut self.inotify else {
            return;
        };
        if self.watches_full {
            return;
        }
        let mask = WatchMask::CREATE
            | WatchMask::DELETE
            | WatchMask::MOVED_FROM
            | WatchMask::MOVED_TO
            | WatchMask::ONLYDIR
            | WatchMask::DONT_FOLLOW;
        match inotify.watches().add(dir, mask) {
            Ok(wd) => {
                self.by_wd.insert(wd.clone(), dir.to_path_buf());
                self.by_path.insert(dir.to_path_buf(), wd);
            }
            Err(error) if error.raw_os_error() == Some(libc::ENOSPC) => {
                eprintln!("shoji-find: out of inotify watches; rebuilding every 10 minutes");
                self.watches_full = true;
            }
            Err(_) => {}
        }
    }

    /// Reads one changed folder again and walks its new subfolders.
    fn rescan(&mut self, dir: &Path) {
        let Some(old) = self.tree.dirs.get(dir) else {
            return;
        };
        let Some(children) = read_children(dir) else {
            // The folder is gone: its parent's rescan removes it.
            return;
        };
        let old_dirs: HashSet<&str> = old
            .iter()
            .filter(|c| c.is_dir)
            .map(|c| c.name.as_str())
            .collect();
        let new_dirs: HashSet<&str> = children
            .iter()
            .filter(|c| c.is_dir)
            .map(|c| c.name.as_str())
            .collect();
        let removed: Vec<PathBuf> = old_dirs
            .difference(&new_dirs)
            .map(|n| dir.join(n))
            .collect();
        let added: Vec<PathBuf> = new_dirs
            .difference(&old_dirs)
            .map(|n| dir.join(n))
            .collect();
        // Removals first: a moved folder keeps its inotify watch id, so a
        // removal after the add would delete the new watch.
        for path in removed {
            for gone in self.tree.drop_subtree(&path) {
                if let Some(wd) = self.by_path.remove(&gone) {
                    self.by_wd.remove(&wd);
                    if let Some(inotify) = &mut self.inotify {
                        let _ = inotify.watches().remove(wd);
                    }
                }
            }
        }
        let count = children.len();
        if let Some(previous) = self.tree.dirs.insert(dir.to_path_buf(), children) {
            self.tree.count = self.tree.count + count - previous.len();
        }
        for path in added {
            let mut new_dirs = Vec::new();
            self.tree
                .walk(&path, &mut |d| new_dirs.push(d.to_path_buf()));
            for d in new_dirs {
                self.add_watch(&d);
            }
        }
    }

    fn watch_loop(&mut self, shared: &SharedIndex) {
        let mut buffer = vec![0u8; 64 * 1024];
        let mut dirty: HashSet<PathBuf> = HashSet::new();
        let mut first_dirty: Option<Instant> = None;
        let mut last_full = Instant::now();
        loop {
            let full_every = if self.watches_full || self.inotify.is_none() {
                600
            } else {
                3600
            };
            if last_full.elapsed() > Duration::from_secs(full_every) {
                self.full_walk();
                self.publish(shared);
                last_full = Instant::now();
                dirty.clear();
                first_dirty = None;
            }
            let Some(inotify) = &mut self.inotify else {
                std::thread::sleep(Duration::from_secs(60));
                continue;
            };
            let timeout_ms = if dirty.is_empty() { 60_000 } else { 300 };
            let mut poll = libc::pollfd {
                fd: inotify.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: one valid pollfd, owned by this stack frame.
            let ready = unsafe { libc::poll(&mut poll, 1, timeout_ms) };
            let mut overflow = false;
            if ready > 0 {
                if let Ok(events) = inotify.read_events(&mut buffer) {
                    for event in events {
                        if event.mask.contains(EventMask::Q_OVERFLOW) {
                            overflow = true;
                        }
                        if event.mask.contains(EventMask::IGNORED) {
                            if let Some(path) = self.by_wd.remove(&event.wd) {
                                self.by_path.remove(&path);
                            }
                            continue;
                        }
                        if let Some(path) = self.by_wd.get(&event.wd) {
                            dirty.insert(path.clone());
                            first_dirty.get_or_insert_with(Instant::now);
                        }
                    }
                }
            }
            if overflow {
                self.full_walk();
                self.publish(shared);
                dirty.clear();
                first_dirty = None;
                continue;
            }
            // Wait for a quiet moment, but never more than 2 s.
            let quiet = ready == 0;
            let waited_long = first_dirty.is_some_and(|t| t.elapsed() > Duration::from_secs(2));
            if !dirty.is_empty() && (quiet || waited_long) {
                let mut paths: Vec<PathBuf> = dirty.drain().collect();
                paths.sort();
                for path in paths {
                    self.rescan(&path);
                }
                self.publish(shared);
                first_dirty = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_tree(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("shoji-find-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for dir in [
            "Documents/pricing",
            "node_modules/pricing",
            ".hidden",
            "deep/a/b/c",
        ] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        for file in [
            "Documents/Pricing Plan 2026.pdf",
            "Documents/pricing/notes.md",
            "deep/a/b/c/old_pricing.txt",
            ".hidden/pricing.txt",
            "node_modules/pricing/index.js",
        ] {
            std::fs::write(root.join(file), b"x").unwrap();
        }
        root
    }

    #[test]
    fn finds_names_and_skips_noise() {
        let root = temp_tree("names");
        let index = build_once(&root);
        let hits = index.search("pricing", 8, now_secs());
        let names: Vec<&str> = hits.iter().map(|h| h.name.as_str()).collect();
        assert!(names.contains(&"Pricing Plan 2026.pdf"));
        assert!(names.contains(&"pricing"));
        assert!(names.contains(&"old_pricing.txt"));
        assert!(!hits
            .iter()
            .any(|h| h.path.contains("node_modules") || h.path.contains(".hidden")));
        // An exact folder name beats a deep partial match.
        assert_eq!(hits[0].name, "pricing");
        assert_eq!(hits.last().unwrap().name, "old_pricing.txt");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn needs_two_letters_and_every_word() {
        let root = temp_tree("words");
        let index = build_once(&root);
        assert!(index.search("p", 8, now_secs()).is_empty());
        let hits = index.search("plan pricing", 8, now_secs());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "Pricing Plan 2026.pdf");
        assert_eq!(hits[0].highlight, vec![[0, 7], [8, 12]]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rescan_picks_up_changes() {
        let root = temp_tree("rescan");
        let mut tree = Tree::default();
        tree.walk(&root, &mut |_| {});
        let mut updater = Updater {
            root: root.clone(),
            tree,
            inotify: None,
            by_wd: HashMap::new(),
            by_path: HashMap::new(),
            watches_full: false,
        };
        std::fs::create_dir_all(root.join("Documents/new folder")).unwrap();
        std::fs::write(root.join("Documents/new folder/budget.ods"), b"x").unwrap();
        std::fs::remove_dir_all(root.join("Documents/pricing")).unwrap();
        updater.rescan(&root.join("Documents"));
        let index = updater.tree.snapshot(&root);
        assert_eq!(index.search("budget", 8, now_secs()).len(), 1);
        assert!(index.search("notes", 8, now_secs()).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn inotify_keeps_the_index_fresh() {
        let root = temp_tree("watch");
        let shared: SharedIndex = Arc::new(RwLock::new(Arc::new(FileIndex::default())));
        let (sender, receiver) = std::sync::mpsc::channel();
        start(
            root.clone(),
            shared.clone(),
            Box::new(move |_, _| sender.send(()).unwrap()),
        );
        receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        let search = |q: &str| shared.read().unwrap().search(q, 8, now_secs());
        assert!(search("holiday").is_empty());

        // A new folder with a file inside, then a rename of an old folder.
        std::fs::create_dir_all(root.join("Documents/trips")).unwrap();
        std::fs::write(root.join("Documents/trips/holiday-2026.jpg"), b"x").unwrap();
        std::fs::rename(root.join("deep/a"), root.join("deep/renamed")).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while search("holiday").is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let hits = search("holiday");
        assert_eq!(hits.len(), 1);
        assert!(hits[0].path.ends_with("Documents/trips/holiday-2026.jpg"));
        let old = search("old_pricing");
        assert_eq!(old.len(), 1);
        assert!(old[0].path.contains("deep/renamed/b/c"));

        // A file in the renamed folder: its watch must still work.
        std::fs::write(root.join("deep/renamed/b/later.txt"), b"x").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while search("later").is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(search("later").len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }
}
