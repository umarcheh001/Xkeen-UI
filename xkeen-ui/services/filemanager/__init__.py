"""Local file manager services.

This package contains implementation details for local filesystem operations.
The public API is intentionally small and used by the /api/fs routes.
"""

from .local_ops import (
    apply_local_metadata_best_effort,
    tmp_free_bytes,
    dir_walk_sum_bytes,
    dir_size_bytes_best_effort,
    mkdir_local,
    rename_local,
    touch_local,
)
from .transfer import save_stream_to_tmp, save_filestorage_to_tmp, stream_file_then_cleanup
from .trash import soft_delete_local, remove_local, restore_local_from_trash, clear_local_trash
from .perms import parse_mode_value, chmod_local, chown_local
from .checksum import hash_stream, hash_file

__all__ = [
    "apply_local_metadata_best_effort",
    "tmp_free_bytes",
    "dir_walk_sum_bytes",
    "dir_size_bytes_best_effort",
    "mkdir_local",
    "rename_local",
    "touch_local",
    "save_stream_to_tmp",
    "save_filestorage_to_tmp",
    "stream_file_then_cleanup",
    "soft_delete_local",
    "remove_local",
    "restore_local_from_trash",
    "clear_local_trash",
    "parse_mode_value",
    "chmod_local",
    "chown_local",
    "hash_stream",
    "hash_file",
]
