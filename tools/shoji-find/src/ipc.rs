//! The service: one socket connection to the ShojiWM config.
//!
//! ShojiWM's IPC server sends every broadcast to every connected client, so
//! "subscribing" is just connecting. A call to the config is one line
//! `{"method": ..., "params": ...}` on the same connection; without an `id`
//! the config sends no reply.
//!
//! ```text
//!   reader thread ── launcher.query ──▶ latest-query slot ──▶ query worker
//!        │                                (older ones dropped)     │
//!        ├─ launcher.home / pin / used: answered here               │
//!        ▼                                                          ▼
//!   writer (shared) ◀──────── launcher.homeData / launcher.results ─┘
//! ```
//!
//! When ShojiWM reloads its config, the socket closes; the helper connects
//! again every second until the new socket is up.

use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use inotify::{Inotify, WatchMask};

use crate::catalog::Ranker;
use crate::engine::Engine;
use crate::protocol::{call_line, parse_line, Incoming, Results, Section};

/// The socket path the config uses: `$XDG_RUNTIME_DIR/shojiwm-$WAYLAND_DISPLAY.sock`.
pub fn default_socket_path() -> PathBuf {
    let runtime = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    let display = std::env::var("WAYLAND_DISPLAY").unwrap_or_else(|_| "wayland-0".into());
    PathBuf::from(format!("{runtime}/shojiwm-{display}.sock"))
}

/// The write half of the current connection, if any.
#[derive(Clone, Default)]
pub struct Writer(Arc<Mutex<Option<UnixStream>>>);

impl Writer {
    pub fn call<T: serde::Serialize>(&self, method: &str, params: &T) {
        let line = call_line(method, params);
        let mut guard = self.0.lock().unwrap();
        if let Some(stream) = guard.as_mut() {
            if stream.write_all(line.as_bytes()).is_err() {
                *guard = None;
            }
        }
    }

    fn set(&self, stream: Option<UnixStream>) {
        *self.0.lock().unwrap() = stream;
    }
}

/// A one-item mailbox: a new query replaces the one not yet started.
#[derive(Default)]
struct Slot {
    query: Mutex<Option<(i64, String)>>,
    ready: Condvar,
}

impl Slot {
    fn put(&self, id: i64, q: String) {
        *self.query.lock().unwrap() = Some((id, q));
        self.ready.notify_one();
    }

    fn take(&self) -> (i64, String) {
        let mut guard = self.query.lock().unwrap();
        loop {
            if let Some(query) = guard.take() {
                return query;
            }
            guard = self.ready.wait(guard).unwrap();
        }
    }
}

pub fn run(engine: Arc<Engine>, socket: PathBuf, verbose: bool) -> ! {
    let writer = Writer::default();
    let latest = Arc::new(AtomicI64::new(i64::MIN));
    let queries = Arc::new(Slot::default());
    let meaning = Arc::new(Slot::default());

    spawn_query_worker(
        engine.clone(),
        writer.clone(),
        latest.clone(),
        queries.clone(),
        meaning.clone(),
        verbose,
    );
    spawn_meaning_worker(engine.clone(), writer.clone(), latest.clone(), meaning);
    spawn_app_watcher(engine.clone(), writer.clone());

    let mut announced_wait = false;
    loop {
        let stream = match UnixStream::connect(&socket) {
            Ok(stream) => stream,
            Err(error) => {
                if !announced_wait {
                    eprintln!("shoji-find: waiting for {} ({error})", socket.display());
                    announced_wait = true;
                }
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
        };
        announced_wait = false;
        eprintln!("shoji-find: connected to {}", socket.display());
        let Ok(write_half) = stream.try_clone() else {
            continue;
        };
        // Never hang on a config that stopped reading.
        let _ = write_half.set_write_timeout(Some(Duration::from_secs(1)));
        writer.set(Some(write_half));
        // The config may have just reloaded: give it the home grids now.
        writer.call("launcher.homeData", &engine.home());

        let reader = BufReader::new(stream);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            let Some(message) = parse_line(&line) else {
                continue;
            };
            if verbose {
                eprintln!("shoji-find: <- {message:?}");
            }
            match message {
                Incoming::Home => writer.call("launcher.homeData", &engine.home()),
                Incoming::Query { id, q } => {
                    latest.store(id, Ordering::SeqCst);
                    queries.put(id, q);
                }
                Incoming::Pin { app_id, pinned } => {
                    engine.set_pin(&app_id, pinned);
                    writer.call("launcher.homeData", &engine.home());
                }
                Incoming::Used { app_id } => {
                    engine.record_use(&app_id);
                }
            }
        }
        writer.set(None);
        eprintln!("shoji-find: the socket closed; reconnecting");
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn spawn_query_worker(
    engine: Arc<Engine>,
    writer: Writer,
    latest: Arc<AtomicI64>,
    queries: Arc<Slot>,
    meaning: Arc<Slot>,
    verbose: bool,
) {
    std::thread::Builder::new()
        .name("query".into())
        .spawn(move || {
            let mut ranker = Ranker::new();
            loop {
                let (id, q) = queries.take();
                if latest.load(Ordering::SeqCst) != id {
                    continue;
                }
                let started = Instant::now();
                let results = engine.search(&mut ranker, id, &q);
                // A newer query came in while this one ran: drop it.
                if latest.load(Ordering::SeqCst) != id {
                    continue;
                }
                writer.call("launcher.results", &results);
                if verbose {
                    eprintln!(
                        "shoji-find: -> results {id} {q:?} in {:?}",
                        started.elapsed()
                    );
                }
                if engine.meaning.ready() && !q.trim().is_empty() {
                    meaning.put(id, q);
                }
            }
        })
        .expect("spawn the query thread");
}

fn spawn_meaning_worker(
    engine: Arc<Engine>,
    writer: Writer,
    latest: Arc<AtomicI64>,
    meaning: Arc<Slot>,
) {
    std::thread::Builder::new()
        .name("meaning".into())
        .spawn(move || loop {
            let (id, q) = meaning.take();
            let is_stale = || latest.load(Ordering::SeqCst) != id;
            if is_stale() {
                continue;
            }
            let items = engine.meaning.search(&q, 5, &is_stale);
            if items.is_empty() || is_stale() {
                continue;
            }
            let results = Results {
                id,
                q,
                sections: vec![Section {
                    kind: "meaning",
                    items,
                }],
            };
            writer.call("launcher.results", &results);
        })
        .expect("spawn the meaning thread");
}

/// Watches the `applications` dirs. After a change (and 500 ms of quiet),
/// reloads the apps and sends the home grids again.
fn spawn_app_watcher(engine: Arc<Engine>, writer: Writer) {
    std::thread::Builder::new()
        .name("apps".into())
        .spawn(move || {
            let Ok(mut inotify) = Inotify::init() else {
                return;
            };
            let mask = WatchMask::CREATE
                | WatchMask::DELETE
                | WatchMask::MODIFY
                | WatchMask::MOVED_FROM
                | WatchMask::MOVED_TO
                | WatchMask::CLOSE_WRITE;
            for dir in &engine.app_dirs {
                let _ = inotify.watches().add(dir, mask);
            }
            let mut buffer = vec![0u8; 16 * 1024];
            let mut changed = false;
            loop {
                let timeout = if changed { 500 } else { -1 };
                let mut poll = libc::pollfd {
                    fd: inotify.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                // SAFETY: one valid pollfd on this stack frame.
                let ready = unsafe { libc::poll(&mut poll, 1, timeout) };
                if ready > 0 {
                    if let Ok(events) = inotify.read_events(&mut buffer) {
                        changed |= events.count() > 0;
                    }
                    continue;
                }
                if ready == 0 && changed {
                    changed = false;
                    engine.reload_apps();
                    engine.warm_icons();
                    eprintln!(
                        "shoji-find: apps reloaded ({})",
                        engine.catalog().apps.len()
                    );
                    writer.call("launcher.homeData", &engine.home());
                }
            }
        })
        .expect("spawn the app watcher");
}
