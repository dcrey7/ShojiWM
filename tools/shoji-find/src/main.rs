//! shoji-find: the search helper of the ShojiWM launcher.
//!
//! Usage:
//!   shoji-find [SOCKET]       run as a service on the ShojiWM IPC socket
//!   shoji-find --query TEXT   print the results for TEXT as JSON
//!   shoji-find --home         print the home grids as JSON
//!   shoji-find --bench        time 1000 queries and print p50 / p99
//!   shoji-find --verbose      (with the service) log each message

mod catalog;
mod desktop;
mod engine;
mod files;
mod icons;
mod ipc;
mod kcm_meta;
mod math;
mod meaning;
mod protocol;
mod usage;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use catalog::Ranker;
use engine::Engine;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let verbose = args.iter().any(|a| a == "--verbose" || a == "-v");
    match args.first().map(String::as_str) {
        Some("--query") => {
            let query = args.get(1).cloned().unwrap_or_default();
            let engine = ready_engine();
            let results = engine.search(&mut Ranker::new(), 1, &query);
            println!("{}", serde_json::to_string_pretty(&results).unwrap());
        }
        Some("--home") => {
            let engine = ready_engine();
            println!("{}", serde_json::to_string_pretty(&engine.home()).unwrap());
        }
        Some("--bench") => bench(),
        Some("--help" | "-h") => {
            println!("usage: shoji-find [SOCKET] | --query TEXT | --home | --bench [--verbose]");
        }
        _ => {
            let socket = args
                .iter()
                .find(|a| !a.starts_with('-'))
                .map(PathBuf::from)
                .unwrap_or_else(ipc::default_socket_path);
            serve(socket, verbose);
        }
    }
}

fn serve(socket: PathBuf, verbose: bool) {
    let started = Instant::now();
    let engine = Arc::new(Engine::new());
    eprintln!(
        "shoji-find: {} apps, {} settings ready in {:?}",
        engine.catalog().apps.len(),
        engine.catalog().settings.len(),
        started.elapsed()
    );
    // The slow parts run in the background; queries work meanwhile.
    let background = engine.clone();
    std::thread::spawn(move || {
        background.enrich_settings();
        background.warm_icons();
    });
    files::start(
        desktop::home_dir(),
        engine.files.clone(),
        Box::new(|took, count| {
            eprintln!(
                "shoji-find: {count} file names indexed in {took:?}, RSS {} MB",
                rss_mb()
            );
        }),
    );
    ipc::run(engine, socket, verbose);
}

/// An engine with everything loaded, for the one-shot commands.
fn ready_engine() -> Engine {
    let engine = Engine::new();
    engine.enrich_settings();
    let index = files::build_once(&desktop::home_dir());
    *engine.files.write().unwrap() = Arc::new(index);
    engine
}

fn rss_mb() -> u64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    status
        .lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))
        .and_then(|v| v.split_whitespace().next())
        .and_then(|kb| kb.parse::<u64>().ok())
        .map_or(0, |kb| kb / 1024)
}

/// Words typed one letter at a time, like a user does.
const BENCH_WORDS: &[&str] = &[
    "dolphin",
    "chrome",
    "wifi",
    "19*4+2",
    "pricing",
    "konsole",
    "settings",
    "bluetooth",
    "code",
    "firefox",
    "steam",
    "screenshot",
    "network",
    "sound",
    "display",
    "readme",
    "cargo",
    "resume",
    "photo",
    "invoice",
    "kate",
    "blender",
    "obs",
    "music",
    "downloads",
];

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    let at = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[at]
}

fn report(name: &str, mut times: Vec<Duration>) {
    times.sort();
    println!(
        "  {name:<28} p50 {:>8.3} ms   p99 {:>8.3} ms   max {:>8.3} ms",
        percentile(&times, 0.50).as_secs_f64() * 1000.0,
        percentile(&times, 0.99).as_secs_f64() * 1000.0,
        times.last().unwrap().as_secs_f64() * 1000.0
    );
}

fn bench() {
    let started = Instant::now();
    let engine = Engine::new();
    let apps_ready = started.elapsed();
    let enrich_start = Instant::now();
    engine.enrich_settings();
    let enrich = enrich_start.elapsed();
    let icons_start = Instant::now();
    engine.warm_icons();
    let icons = icons_start.elapsed();
    let files_start = Instant::now();
    let index = files::build_once(&desktop::home_dir());
    let files_took = files_start.elapsed();
    let file_count = index.len();
    let file_bytes = index.bytes();
    *engine.files.write().unwrap() = Arc::new(index);

    println!("startup");
    println!(
        "  apps ready (parse .desktop)   {:>8.1} ms",
        apps_ready.as_secs_f64() * 1000.0
    );
    println!(
        "  settings keywords (background){:>8.1} ms",
        enrich.as_secs_f64() * 1000.0
    );
    println!(
        "  icons warmed (background)     {:>8.1} ms",
        icons.as_secs_f64() * 1000.0
    );
    println!(
        "  file index (background)       {:>8.1} ms  {file_count} names, {:.1} MB",
        files_took.as_secs_f64() * 1000.0,
        file_bytes as f64 / 1e6
    );
    println!(
        "  catalog                       {} apps, {} settings",
        engine.catalog().apps.len(),
        engine.catalog().settings.len()
    );

    let mut queries = Vec::new();
    'fill: loop {
        for word in BENCH_WORDS {
            for end in 1..=word.chars().count() {
                queries.push(word.chars().take(end).collect::<String>());
                if queries.len() == 1000 {
                    break 'fill;
                }
            }
        }
    }

    let mut ranker = Ranker::new();
    let catalog = engine.catalog();
    let mut fast = Vec::new();
    let mut files_only = Vec::new();
    let mut full = Vec::new();
    for (i, q) in queries.iter().enumerate() {
        let t = Instant::now();
        let hits = engine.rank_catalog(&mut ranker, &catalog, q);
        std::hint::black_box((hits, math::evaluate(q)));
        fast.push(t.elapsed());

        let t = Instant::now();
        std::hint::black_box(engine.search_files(q));
        files_only.push(t.elapsed());

        let t = Instant::now();
        let results = engine.search(&mut ranker, i as i64, q);
        std::hint::black_box(protocol::call_line("launcher.results", &results));
        full.push(t.elapsed());
    }
    println!("{} queries (typed letter by letter)", queries.len());
    report("apps + settings + maths", fast);
    report("files by name", files_only);
    report("full answer + JSON", full);
    println!("memory");
    println!("  RSS                           {} MB", rss_mb());
}
