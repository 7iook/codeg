//! Work-task CRUD + engine-dispatched commands. The `*_core` fns are
//! mode-agnostic and shared by the Tauri wrappers and the Axum handlers.
//! Anything that launches, cancels, merges, or touches a worktree routes
//! through the process-global task engine (per-folder git mutex + run_seq
//! generations live there); a process that does not hold the engine lock gets
//! a clean "engine not running" error.

use crate::app_error::AppCommandError;
use crate::commands::folders::{get_folder_core, git_diff_with_branch};
use crate::db::entities::work_task::WorkTaskStatus;
use crate::db::error::DbError;
use crate::db::service::work_task_service;
use crate::db::AppDatabase;
use crate::models::{
    WorkTaskChangedFile, WorkTaskDraft, WorkTaskEventInfo, WorkTaskFolderSettings, WorkTaskInfo,
};
use crate::web::event_bridge::{
    emit_event, EventEmitter, WorkTaskChange, WORK_TASK_CHANGED_EVENT,
};

fn engine() -> Result<std::sync::Arc<crate::work_task::TaskEngine>, DbError> {
    crate::work_task::engine()
        .ok_or_else(|| DbError::Validation("task engine not running".to_string()))
}

// ── shared business logic (both modes) ──────────────────────────────────────

pub async fn work_task_list_core(
    db: &AppDatabase,
    folder_id: Option<i32>,
) -> Result<Vec<WorkTaskInfo>, DbError> {
    work_task_service::list(&db.conn, folder_id).await
}

pub async fn work_task_get_core(db: &AppDatabase, id: i32) -> Result<WorkTaskInfo, DbError> {
    work_task_service::get(&db.conn, id).await
}

pub async fn work_task_events_core(
    db: &AppDatabase,
    task_id: i32,
    limit: u64,
) -> Result<Vec<WorkTaskEventInfo>, DbError> {
    work_task_service::list_events(&db.conn, task_id, limit).await
}

pub async fn work_task_attention_count_core(db: &AppDatabase) -> Result<u64, DbError> {
    work_task_service::attention_count(&db.conn).await
}

pub async fn work_task_create_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    draft: WorkTaskDraft,
) -> Result<WorkTaskInfo, DbError> {
    let info = work_task_service::create(&db.conn, draft).await?;
    emit_event(
        emitter,
        WORK_TASK_CHANGED_EVENT,
        WorkTaskChange::Upsert { id: info.id },
    );
    Ok(info)
}

pub async fn work_task_update_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
    draft: WorkTaskDraft,
) -> Result<WorkTaskInfo, DbError> {
    let info = work_task_service::update(&db.conn, id, draft).await?;
    emit_event(
        emitter,
        WORK_TASK_CHANGED_EVENT,
        WorkTaskChange::Upsert { id },
    );
    Ok(info)
}

/// Delete a task. An active run is canceled first; `delete_worktree` also
/// removes its worktree (best-effort — a cleanup failure does not block the
/// delete, the worktree just stays on disk). Refused while merging.
pub async fn work_task_delete_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
    delete_worktree: bool,
) -> Result<(), DbError> {
    let task = work_task_service::get_model(&db.conn, id).await?;
    if task.status == WorkTaskStatus::Merging {
        return Err(DbError::Validation(
            "task is merging — wait for it to finish".to_string(),
        ));
    }
    if matches!(
        task.status,
        WorkTaskStatus::Queued | WorkTaskStatus::Running | WorkTaskStatus::AwaitingInput
    ) {
        engine()?.cancel(id).await.map_err(DbError::Validation)?;
    }
    if delete_worktree && task.worktree_folder_id.is_some() {
        if let Err(e) = engine()?.cleanup_task(id).await {
            tracing::warn!("[work_task] cleanup during delete of task {id}: {e}");
        }
    }
    work_task_service::soft_delete(&db.conn, id).await?;
    emit_event(
        emitter,
        WORK_TASK_CHANGED_EVENT,
        WorkTaskChange::Deleted { id },
    );
    Ok(())
}

pub async fn work_task_start_core(id: i32) -> Result<(), DbError> {
    engine()?.start(id).await.map_err(DbError::Validation)
}

pub async fn work_task_start_all_core(folder_id: i32) -> Result<u32, DbError> {
    engine()?
        .start_all(folder_id)
        .await
        .map_err(DbError::Validation)
}

pub async fn work_task_retry_core(id: i32) -> Result<(), DbError> {
    engine()?.retry(id).await.map_err(DbError::Validation)
}

/// canceled → todo. Pure DB (no engine needed) — the user starts it again
/// explicitly.
pub async fn work_task_requeue_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
) -> Result<(), DbError> {
    if !work_task_service::requeue_canceled(&db.conn, id).await? {
        return Err(DbError::Validation("task is not canceled".to_string()));
    }
    emit_event(
        emitter,
        WORK_TASK_CHANGED_EVENT,
        WorkTaskChange::Upsert { id },
    );
    Ok(())
}

pub async fn work_task_return_core(id: i32, feedback: String) -> Result<(), DbError> {
    let feedback = feedback.trim().to_string();
    if feedback.is_empty() {
        return Err(DbError::Validation("feedback is required".to_string()));
    }
    engine()?
        .return_task(id, feedback)
        .await
        .map_err(DbError::Validation)
}

pub async fn work_task_cancel_core(id: i32) -> Result<(), DbError> {
    engine()?.cancel(id).await.map_err(DbError::Validation)
}

/// Kick off the merge and return immediately — progress and the outcome ride
/// the `task://changed` events (merging → done, or back to review with a
/// readable error). Preconditions (in review, message present) are validated
/// before the spawn so the caller still gets immediate feedback for those.
pub async fn work_task_merge_core(
    db: &AppDatabase,
    id: i32,
    message: String,
    strategy: Option<String>,
    delete_worktree: bool,
) -> Result<(), DbError> {
    let engine = engine()?;
    let task = work_task_service::get_model(&db.conn, id).await?;
    if task.status != WorkTaskStatus::Review {
        return Err(DbError::Validation("task is not in review".to_string()));
    }
    if message.trim().is_empty() {
        return Err(DbError::Validation("commit message is required".to_string()));
    }
    tokio::spawn(async move {
        if let Err(e) = engine.merge_task(id, message, strategy, delete_worktree).await {
            tracing::info!("[work_task] merge {id}: {e}");
        }
    });
    Ok(())
}

pub async fn work_task_cleanup_core(id: i32) -> Result<(), DbError> {
    engine()?.cleanup_task(id).await.map_err(DbError::Validation)
}

/// Diff of the task worktree vs. its recorded base (`base_sha`, so the view is
/// stable even when the base branch advances). `file = None` → full patch.
pub async fn work_task_diff_core(
    db: &AppDatabase,
    id: i32,
    file: Option<String>,
) -> Result<String, AppCommandError> {
    let task = work_task_service::get_model(&db.conn, id)
        .await
        .map_err(AppCommandError::from)?;
    let wt_id = task
        .worktree_folder_id
        .ok_or_else(|| AppCommandError::not_found("task has no worktree"))?;
    let base = task
        .base_sha
        .clone()
        .or(task.base_branch.clone())
        .ok_or_else(|| AppCommandError::not_found("task has no recorded base"))?;
    let wt = get_folder_core(db, wt_id)
        .await
        .map_err(AppCommandError::from)?;
    git_diff_with_branch(wt.path, base, file).await
}

pub async fn work_task_changed_files_core(
    db: &AppDatabase,
    id: i32,
) -> Result<Vec<WorkTaskChangedFile>, AppCommandError> {
    let task = work_task_service::get_model(&db.conn, id)
        .await
        .map_err(AppCommandError::from)?;
    let Some(wt_id) = task.worktree_folder_id else {
        return Ok(vec![]);
    };
    let Some(base) = task.base_sha.clone().or(task.base_branch.clone()) else {
        return Ok(vec![]);
    };
    let wt = get_folder_core(db, wt_id)
        .await
        .map_err(AppCommandError::from)?;
    crate::work_task::git::diff_numstat(&wt.path, &base).await
}

pub async fn work_task_settings_get_core(
    db: &AppDatabase,
    folder_id: i32,
) -> Result<WorkTaskFolderSettings, DbError> {
    work_task_service::settings_get(&db.conn, folder_id).await
}

pub async fn work_task_settings_set_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    folder_id: i32,
    settings: WorkTaskFolderSettings,
) -> Result<(), DbError> {
    work_task_service::settings_set(&db.conn, folder_id, &settings).await?;
    emit_event(
        emitter,
        WORK_TASK_CHANGED_EVENT,
        WorkTaskChange::Settings { folder_id },
    );
    Ok(())
}

// ── Tauri command wrappers (desktop only) ───────────────────────────────────

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_list(
    db: tauri::State<'_, AppDatabase>,
    folder_id: Option<i32>,
) -> Result<Vec<WorkTaskInfo>, DbError> {
    work_task_list_core(&db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_get(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<WorkTaskInfo, DbError> {
    work_task_get_core(&db, id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_events(
    db: tauri::State<'_, AppDatabase>,
    task_id: i32,
    limit: Option<u64>,
) -> Result<Vec<WorkTaskEventInfo>, DbError> {
    work_task_events_core(&db, task_id, limit.unwrap_or(500)).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_attention_count(
    db: tauri::State<'_, AppDatabase>,
) -> Result<u64, DbError> {
    work_task_attention_count_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_create(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    draft: WorkTaskDraft,
) -> Result<WorkTaskInfo, DbError> {
    work_task_create_core(&EventEmitter::Tauri(app), &db, draft).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_update(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    draft: WorkTaskDraft,
) -> Result<WorkTaskInfo, DbError> {
    work_task_update_core(&EventEmitter::Tauri(app), &db, id, draft).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_delete(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    delete_worktree: Option<bool>,
) -> Result<(), DbError> {
    work_task_delete_core(
        &EventEmitter::Tauri(app),
        &db,
        id,
        delete_worktree.unwrap_or(false),
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_start(id: i32) -> Result<(), DbError> {
    work_task_start_core(id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_start_all(folder_id: i32) -> Result<u32, DbError> {
    work_task_start_all_core(folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_retry(id: i32) -> Result<(), DbError> {
    work_task_retry_core(id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_requeue(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<(), DbError> {
    work_task_requeue_core(&EventEmitter::Tauri(app), &db, id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_return(id: i32, feedback: String) -> Result<(), DbError> {
    work_task_return_core(id, feedback).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_cancel(id: i32) -> Result<(), DbError> {
    work_task_cancel_core(id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_merge(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    message: String,
    strategy: Option<String>,
    delete_worktree: bool,
) -> Result<(), DbError> {
    work_task_merge_core(&db, id, message, strategy, delete_worktree).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_cleanup(id: i32) -> Result<(), DbError> {
    work_task_cleanup_core(id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_diff(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    file: Option<String>,
) -> Result<String, AppCommandError> {
    work_task_diff_core(&db, id, file).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_changed_files(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<Vec<WorkTaskChangedFile>, AppCommandError> {
    work_task_changed_files_core(&db, id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_settings_get(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<WorkTaskFolderSettings, DbError> {
    work_task_settings_get_core(&db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_settings_set(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    settings: WorkTaskFolderSettings,
) -> Result<(), DbError> {
    work_task_settings_set_core(&EventEmitter::Tauri(app), &db, folder_id, settings).await
}
