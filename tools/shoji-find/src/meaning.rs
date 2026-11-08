//! Search by meaning: the plug point for EmbeddingGemma 2.
//!
//! The fast sections go out first. A meaning engine then runs on its own
//! thread and, when it has hits, sends a second `launcher.results` with the
//! same id and one "meaning" section:
//!
//! ```text
//!   query 7 ──▶ apps, files, settings, maths ──▶ launcher.results {id 7}     (~1 ms)
//!          └──▶ MeaningEngine::search (GPU)  ──▶ launcher.results {id 7,
//!                                                  sections: [meaning]}       (later)
//! ```
//!
//! To add the real engine:
//! 1. index the chosen folders in the background (only while the PC idles);
//! 2. implement `MeaningEngine` (embed the query, compare with the index);
//! 3. return it from `engine()` instead of `NoMeaning`.

use crate::protocol::Item;

pub trait MeaningEngine: Send + Sync {
    /// True when the engine can answer. When false, nothing is sent.
    fn ready(&self) -> bool;

    /// The best `limit` items for `query`. Called off the fast path; it may
    /// take tens of milliseconds. `is_stale` turns true when a newer query
    /// arrived, so a long search can stop early.
    fn search(&self, query: &str, limit: usize, is_stale: &dyn Fn() -> bool) -> Vec<Item>;
}

/// The stub: never ready, never answers.
pub struct NoMeaning;

impl MeaningEngine for NoMeaning {
    fn ready(&self) -> bool {
        false
    }

    fn search(&self, _query: &str, _limit: usize, _is_stale: &dyn Fn() -> bool) -> Vec<Item> {
        Vec::new()
    }
}

/// The engine in use.
pub fn engine() -> Box<dyn MeaningEngine> {
    Box::new(NoMeaning)
}
