from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

# NOTE: this is a lightweight runtime/context container used by fileops runners.
# It keeps services.fileops.* independent from Flask/routes and helps prevent
# routes->routes imports.


@dataclass(frozen=True)
class FileOpsRuntime:
    # General
    mgr: Any
    local_roots: List[str]

    # Time/progress/state
    now_fn: Callable[[], float]
    job_set_state: Callable[..., None]
    progress_set: Callable[..., None]
    core_log: Optional[Callable[..., None]] = None

    # Local path resolution helpers (raise RuntimeError on forbidden paths)
    ensure_local_follow: Callable[[str], str] | None = None
    ensure_local_nofollow: Callable[[str], str] | None = None

    # Local FS ops/helpers
    local_remove_entry: Callable[..., Any] | None = None
    local_soft_delete: Callable[..., Any] | None = None
    local_is_protected_entry_abs: Callable[..., Any] | None = None

    # LFTP helpers
    lftp_quote: Callable[[str], str] | None = None

    # Remote helpers (built on remotefs manager + lftp)
    remote_stat_size: Callable[..., Any] | None = None
    remote_free_bytes: Callable[..., Any] | None = None
    remote_du_bytes: Callable[..., Any] | None = None
    remote_is_dir: Callable[..., Any] | None = None
    remote_exists: Callable[..., Any] | None = None
    url_for_session_path: Callable[..., str] | None = None

    run_lftp_raw: Callable[..., Tuple[int, bytes, bytes]] | None = None
    popen_lftp_raw: Callable[..., Any] | None = None
    popen_lftp_quiet: Callable[..., Any] | None = None
    terminate_proc: Callable[..., None] | None = None
    build_lftp_url_script: Callable[..., str] | None = None

    # Spool helpers (remote->remote transfers)
    spool_tmp_file: Callable[..., str] | None = None
    spool_tmp_dir: Callable[..., str] | None = None
    dir_size_bytes: Callable[..., int] | None = None
    spool_cleanup_stale: Callable[..., None] | None = None
    spool_check_limit: Callable[..., None] | None = None

    # Feature flags
    remote2remote_direct: bool = True
    fxp_enabled: bool = True
