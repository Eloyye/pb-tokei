"""Shared pytest fixtures."""

from __future__ import annotations

from pathlib import Path

import pytest

from pb_tokei.state import STATE_DIR_ENV


@pytest.fixture(autouse=True)
def isolate_state_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Keep tests from reading or modifying the host user's per-user pb-tokei state."""
    state = tmp_path / ".pb-tokei-state"
    monkeypatch.setenv(STATE_DIR_ENV, str(state))
    return state
