import subprocess
from collections.abc import Sequence
from pathlib import Path

import pytest

from pb_tokei import main
from pb_tokei.annotate import frontend

INSTALL = ["bun", "install", "--frozen-lockfile"]
BUILD = ["bun", "run", "build"]


@pytest.fixture
def checkout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    web_dir = tmp_path / "web"
    (web_dir / "src").mkdir(parents=True)
    (web_dir / "src" / "main.ts").write_text("export const value = 1;\n")
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "index.html").write_text("<!doctype html><title>app</title>")
    monkeypatch.setattr(frontend, "WEB_DIR", web_dir)
    monkeypatch.setattr(frontend, "STATIC_DIR", static_dir)
    return web_dir, static_dir


def test_source_hash_changes_when_contents_or_paths_change(checkout: tuple[Path, Path]) -> None:
    web_dir, _ = checkout
    script = web_dir / "src" / "main.ts"
    original = frontend.source_hash(web_dir)
    assert frontend.source_hash(web_dir) == original

    script.write_text("export const value = 2;\n")
    edited = frontend.source_hash(web_dir)
    assert edited != original

    script.rename(script.with_name("entry.ts"))
    assert frontend.source_hash(web_dir) != edited


def test_source_hash_ignores_node_modules(checkout: tuple[Path, Path]) -> None:
    web_dir, _ = checkout
    original = frontend.source_hash(web_dir)
    installed = web_dir / "node_modules" / "dependency" / "package.json"
    installed.parent.mkdir(parents=True)
    installed.write_text("{}\n")

    assert frontend.source_hash(web_dir) == original


def test_stamp_and_check(checkout: tuple[Path, Path]) -> None:
    web_dir, _ = checkout
    assert frontend.main(["check"]) == 1
    assert frontend.main(["stamp"]) == 0
    assert frontend.main(["check"]) == 0

    (web_dir / ".bun-version").write_text("1.3.14\n")

    assert frontend.main(["check"]) == 1


@pytest.mark.parametrize("state", ["fresh", "stale", "unstamped", "missing-index"])
def test_dev_update_builds_only_when_needed(
    checkout: tuple[Path, Path], state: str, capsys: pytest.CaptureFixture[str]
) -> None:
    web_dir, static_dir = checkout
    if state != "unstamped":
        frontend.stamp_bundle(web_dir, static_dir)
    if state == "stale":
        (web_dir / "src" / "main.ts").write_text("export const value = 2;\n")
    if state == "missing-index":
        (static_dir / "index.html").unlink()

    calls: list[list[str]] = []

    def run(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        calls.append(list(args))
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

    assert main(["dev", "update"], run=run) == 0

    output = capsys.readouterr()
    assert output.err == ""
    assert output.out.splitlines()[:2] == [
        "python deps: synced (uv run)",
        "web deps:    bun install --frozen-lockfile succeeded",
    ]
    if state == "fresh":
        assert calls == [INSTALL]
        assert "skipped build" in output.out
    else:
        assert calls == [INSTALL, BUILD]
        assert "rebuilt" in output.out


@pytest.mark.parametrize("failing_command", [INSTALL, BUILD])
def test_dev_update_stops_and_shows_the_failing_commands_output(
    checkout: tuple[Path, Path], failing_command: list[str], capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[list[str]] = []

    def run(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        command = list(args)
        calls.append(command)
        if command == failing_command:
            return subprocess.CompletedProcess(args, 2, stdout="step output", stderr="step error")
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

    assert main(["dev", "update"], run=run) != 0

    assert calls == ([INSTALL] if failing_command == INSTALL else [INSTALL, BUILD])
    output = capsys.readouterr()
    assert "rebuilt" not in output.out
    assert "exited with status 2" in output.err
    assert "step output" in output.err
    assert "step error" in output.err
