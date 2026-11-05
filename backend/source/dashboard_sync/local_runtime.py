from __future__ import annotations

from pathlib import Path

from .config import SHARE_STORE_DIRNAME
from .indexer import IncrementalSessionIndexer
from .store import SyncStore


class LocalMetricsRuntime:
    """Maintain local usage/activity indexes without starting network services."""

    def __init__(self, sessions_root: Path, store_path: Path | None = None) -> None:
        resolved_store = (
            Path(store_path)
            if store_path is not None
            else Path.home() / ".codex" / SHARE_STORE_DIRNAME / "sync.db"
        )
        self.store = SyncStore(resolved_store)
        self.credentials = self.store.load_credentials()
        self.indexer = IncrementalSessionIndexer(
            sessions_root,
            self.store,
            lambda: self.credentials,
            queue_events=False,
        )

    def scan_once(self) -> int:
        return self.indexer.scan_once()

    def close(self) -> None:
        self.store.close()
