//! Preview tokens for the "stop will also kill these sub-agents" confirmation
//! (spec `midturn-steering` R4 / design §4).
//!
//! A stop click cascades into `cancel_by_parent_turn`, which terminates every
//! delegation in the parent-turn scope. The UI must tell the user how many
//! before doing it — and must then destroy **exactly what it showed**, not
//! whatever happens to exist when the user clicks OK.
//!
//! That is what a token is for: a preview pins the scope it displayed into a
//! token, and the commit is bounded by the token's id set. Concretely:
//!
//!   * **one-shot** — a successful commit consumes the token; re-submitting it
//!     is rejected and produces NO second cancel;
//!   * **atomic** — validate + consume + execute happen under ONE lock, so two
//!     concurrent commits can't both pass a validate-then-execute window;
//!   * **`conn_id`-bound** — a token issued for connection A is rejected
//!     against connection B (and stays valid for A: a mismatch is not a
//!     consumption);
//!   * **short-lived** — [`CANCEL_SCOPE_TOKEN_TTL`], the order of a dialog's
//!     lifetime. An expired token is REJECTED, never silently downgraded to
//!     "cancel whatever the current set is" — that is precisely the unbounded
//!     destruction the token exists to prevent.
//!
//! There is deliberately no cross-user authorization: this project has no user
//! identity layer (`web/auth.rs` is a single shared `CODEG_TOKEN`, and
//! `owner_window_label` is window lifecycle management, not a security
//! boundary), so `conn_id` binding plus one-shot consumption are the real,
//! implementable protections. See design §2.2.1.
//!
//! State is in-memory and NOT persisted: a token's lifetime is shorter than one
//! user interaction, and a restart should re-preview rather than resurrect a
//! stale authorization.

use std::collections::HashMap;
use std::future::Future;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use super::broker::ParentCancelScope;

/// How long a preview token stays valid. Same order as the confirmation
/// dialog's life — long enough for a human to read a sentence and click,
/// short enough that a forgotten dialog cannot authorize a cancel much later.
pub const CANCEL_SCOPE_TOKEN_TTL: Duration = Duration::from_secs(60);

/// Answer to "what would stop destroy right now?" — the payload the
/// confirmation dialog renders (spec R4.1 / R4.4).
///
/// `count` is authoritative and covers BOTH scope sources, so it can exceed
/// `task_ids.len()`: a delegation still starting up has no `task_id` yet, but it
/// WILL be terminated, so it must be counted. Never derive the displayed number
/// from `task_ids`.
///
/// `token` is `None` exactly when `count == 0` — nothing to authorize, so the
/// caller cancels directly with no confirmation step (R4.4).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelScopePreview {
    /// Authorization for the confirmed cancel. `None` ⇔ `count == 0`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// Delegations this cancel would terminate — running plus still-starting.
    pub count: usize,
    /// `task_id`s of the running subset, for display. A partial view of `count`
    /// by construction (see above).
    pub task_ids: Vec<String>,
    /// Remaining validity, so the UI can re-preview instead of submitting a
    /// token it knows is stale. `0` when no token was issued.
    pub expires_in_ms: u64,
}

/// Why a commit was refused. Every variant means "no cancel was executed".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelScopeTokenError {
    /// No such token — never issued, or already consumed by an earlier commit.
    /// The one-shot property surfaces here on a double submit.
    Unknown,
    /// Issued, but past [`CANCEL_SCOPE_TOKEN_TTL`]. The caller must re-preview;
    /// we do NOT fall back to the current scope.
    Expired,
    /// Issued for a different connection. Rejected WITHOUT consuming, so the
    /// rightful connection's commit still works.
    ConnectionMismatch,
}

impl CancelScopeTokenError {
    /// Stable, human-readable reason carried on the transport error.
    pub fn reason(self) -> &'static str {
        match self {
            Self::Unknown => "unknown or already used",
            Self::Expired => "expired; re-run the preview",
            Self::ConnectionMismatch => "issued for a different connection",
        }
    }
}

struct TokenEntry {
    conn_id: String,
    scope: ParentCancelScope,
    expires_at: Instant,
}

/// Live preview tokens, keyed by token string.
///
/// Cheap to clone (one `Arc` inside) so the broker can hand copies around. The
/// map is bounded in practice by "previews issued in the last minute" —
/// [`Self::issue`] prunes expired entries on every insert, and a commit removes
/// its own entry.
#[derive(Clone, Default)]
pub struct CancelScopeTokens {
    inner: std::sync::Arc<Mutex<HashMap<String, TokenEntry>>>,
}

impl CancelScopeTokens {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a token pinning `scope` for `conn_id`, returning it with its TTL.
    ///
    /// Read-only with respect to delegations: previewing never terminates
    /// anything, so concurrent previews are safe and each simply gets its own
    /// token (first commit wins; the rest are then `Unknown` or bounded to a
    /// set that no longer exists — both harmless).
    pub async fn issue(&self, conn_id: &str, scope: ParentCancelScope) -> (String, Duration) {
        let token = uuid::Uuid::new_v4().to_string();
        let now = Instant::now();
        let mut map = self.inner.lock().await;
        // Prune here rather than on a timer: previews are the only growth
        // source, so the map is self-limiting without a background task.
        map.retain(|_, e| e.expires_at > now);
        map.insert(
            token.clone(),
            TokenEntry {
                conn_id: conn_id.to_string(),
                scope,
                expires_at: now + CANCEL_SCOPE_TOKEN_TTL,
            },
        );
        (token, CANCEL_SCOPE_TOKEN_TTL)
    }

    /// Validate + consume `token`, then run `exec` with the scope it pinned —
    /// **all while holding the registry lock**.
    ///
    /// Holding the lock across `exec`'s await is the point, not an oversight:
    /// it is what makes "one token can never drive two cancels" true even under
    /// concurrent commits. The lock is uncontended in practice (a human clicking
    /// a dialog) and `exec` only touches the broker's own mutexes, which never
    /// re-enter this one — so there is no lock-order cycle.
    ///
    /// The entry is removed BEFORE `exec` runs, so a panic inside `exec` cannot
    /// leave a re-usable token behind.
    pub async fn commit<T, F, Fut>(
        &self,
        conn_id: &str,
        token: &str,
        exec: F,
    ) -> Result<T, CancelScopeTokenError>
    where
        F: FnOnce(ParentCancelScope) -> Fut,
        Fut: Future<Output = T>,
    {
        let mut map = self.inner.lock().await;
        let entry = map.get(token).ok_or(CancelScopeTokenError::Unknown)?;
        if entry.conn_id != conn_id {
            // NOT consumed: the token still belongs to its own connection.
            return Err(CancelScopeTokenError::ConnectionMismatch);
        }
        if entry.expires_at <= Instant::now() {
            map.remove(token);
            return Err(CancelScopeTokenError::Expired);
        }
        let entry = map.remove(token).expect("entry observed under this lock");
        Ok(exec(entry.scope).await)
    }

    /// Live (unexpired-at-insert) token count. Test-only introspection.
    ///
    /// Named `live_token_count` rather than `len`: this type is a token
    /// registry, not a collection, so `clippy::len_without_is_empty` would
    /// otherwise demand a meaningless `is_empty` companion (and that lint is
    /// `-D warnings` in this repo's gate).
    #[cfg(any(test, feature = "test-utils"))]
    pub async fn live_token_count(&self) -> usize {
        self.inner.lock().await.len()
    }

    /// Force `token` to be expired, so tests can exercise the expiry rejection
    /// without sleeping out [`CANCEL_SCOPE_TOKEN_TTL`].
    #[cfg(any(test, feature = "test-utils"))]
    pub async fn expire_now_for_test(&self, token: &str) {
        if let Some(e) = self.inner.lock().await.get_mut(token) {
            e.expires_at = Instant::now() - Duration::from_secs(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(running: &[&str]) -> ParentCancelScope {
        ParentCancelScope {
            running: running.iter().map(|s| s.to_string()).collect(),
            starting: Vec::new(),
        }
    }

    #[tokio::test]
    async fn commit_consumes_token_and_passes_pinned_scope() {
        let tokens = CancelScopeTokens::new();
        let (token, ttl) = tokens.issue("conn-a", scope(&["t1", "t2"])).await;
        assert_eq!(ttl, CANCEL_SCOPE_TOKEN_TTL);

        let seen = tokens
            .commit("conn-a", &token, |s| async move { s.running })
            .await
            .expect("first commit must pass");
        assert_eq!(seen, vec!["t1".to_string(), "t2".to_string()]);
        assert_eq!(
            tokens.live_token_count().await,
            0,
            "a committed token is gone"
        );
    }

    /// One-shot: the second submit is refused AND must not run `exec` again —
    /// asserted on a side effect, because "returned an error" alone would not
    /// prove no cancel happened.
    #[tokio::test]
    async fn second_commit_is_rejected_without_executing() {
        let tokens = CancelScopeTokens::new();
        let (token, _) = tokens.issue("conn-a", scope(&["t1"])).await;
        let runs = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        for expected in [Ok(()), Err(CancelScopeTokenError::Unknown)] {
            let runs = runs.clone();
            let got = tokens
                .commit("conn-a", &token, |_| async move {
                    runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                })
                .await;
            assert_eq!(got, expected);
        }
        assert_eq!(
            runs.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the rejected re-submit must not execute a second cancel"
        );
    }

    #[tokio::test]
    async fn token_from_one_connection_is_rejected_on_another() {
        let tokens = CancelScopeTokens::new();
        let (token, _) = tokens.issue("conn-a", scope(&["t1"])).await;

        let err = tokens
            .commit("conn-b", &token, |_| async { unreachable!("must not run") })
            .await
            .expect_err("cross-connection submit must be refused");
        assert_eq!(err, CancelScopeTokenError::ConnectionMismatch);

        // Refusing conn-b must not have burned the token for conn-a.
        tokens
            .commit("conn-a", &token, |_| async {})
            .await
            .expect("the rightful connection can still commit");
    }

    #[tokio::test]
    async fn expired_token_is_rejected_not_downgraded() {
        let tokens = CancelScopeTokens::new();
        let (token, _) = tokens.issue("conn-a", scope(&["t1"])).await;
        tokens.expire_now_for_test(&token).await;

        let err = tokens
            .commit("conn-a", &token, |_| async {
                unreachable!("an expired token must never reach execution")
            })
            .await
            .expect_err("expired token must be refused");
        assert_eq!(err, CancelScopeTokenError::Expired);
        assert_eq!(
            tokens.live_token_count().await,
            0,
            "expired entry is dropped"
        );
    }

    /// Concurrent commits of two DIFFERENT tokens: both are valid, so both run
    /// — the "exactly one takes effect" guarantee comes from the bounded
    /// execution (the second finds its ids already gone), not from the
    /// registry. What the registry must guarantee is that neither token is
    /// consumed twice.
    #[tokio::test]
    async fn concurrent_distinct_tokens_each_commit_once() {
        let tokens = CancelScopeTokens::new();
        let (t1, _) = tokens.issue("conn-a", scope(&["t1"])).await;
        let (t2, _) = tokens.issue("conn-a", scope(&["t1"])).await;

        let a = tokens.commit("conn-a", &t1, |s| async move { s.running.len() });
        let b = tokens.commit("conn-a", &t2, |s| async move { s.running.len() });
        let (ra, rb) = tokio::join!(a, b);
        assert_eq!((ra, rb), (Ok(1), Ok(1)));

        // Both are now dead.
        assert_eq!(
            tokens.commit("conn-a", &t1, |_| async {}).await,
            Err(CancelScopeTokenError::Unknown)
        );
        assert_eq!(
            tokens.commit("conn-a", &t2, |_| async {}).await,
            Err(CancelScopeTokenError::Unknown)
        );
    }
}
