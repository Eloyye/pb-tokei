import errno
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


@pytest.mark.parametrize(
    "relative_path",
    [
        "node_modules/dependency/package.json",
        "src/nested/node_modules/dependency/package.json",
        ".DS_Store",
        "src/.DS_Store",
        "src/.main.ts.swp",
        "src/main.ts~",
        ".env.local",
        "coverage/index.html",
        "src/main.test.ts",
        "src/panel.test.tsx",
        ".oxlintrc.json",
        ".oxfmtrc.json",
    ],
)
def test_source_hash_ignores_files_outside_the_build(
    checkout: tuple[Path, Path], relative_path: str
) -> None:
    web_dir, _ = checkout
    original = frontend.source_hash(web_dir)
    local_file = web_dir / relative_path
    local_file.parent.mkdir(parents=True, exist_ok=True)
    local_file.write_text("changed\n")

    assert frontend.source_hash(web_dir) == original


def test_stamp_and_check(checkout: tuple[Path, Path]) -> None:
    web_dir, _ = checkout
    assert frontend.main(["check"]) == 1
    assert frontend.main(["stamp", frontend.source_hash(web_dir)]) == 0
    assert frontend.main(["check"]) == 0

    (web_dir / ".bun-version").write_text("1.3.14\n")

    assert frontend.main(["check"]) == 1


def test_stamp_keeps_the_pre_build_hash_when_sources_change(
    checkout: tuple[Path, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    web_dir, static_dir = checkout
    assert frontend.main(["hash"]) == 0
    pre_build_hash = capsys.readouterr().out.strip()
    assert pre_build_hash == frontend.source_hash(web_dir)

    (web_dir / "src" / "main.ts").write_text("export const value = 2;\n")

    assert frontend.main(["stamp", pre_build_hash]) == 0
    assert (static_dir / frontend.SOURCE_HASH_FILE).read_text().strip() == pre_build_hash
    assert frontend.main(["check"]) == 1


@pytest.mark.parametrize("state", ["fresh", "stale", "unstamped", "missing-index"])
def test_dev_update_builds_only_when_needed(
    checkout: tuple[Path, Path], state: str, capsys: pytest.CaptureFixture[str]
) -> None:
    web_dir, static_dir = checkout
    if state != "unstamped":
        frontend.stamp_bundle(static_dir, frontend.source_hash(web_dir))
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
        "python deps: managed by uv run",
        "web deps:    bun install --frozen-lockfile succeeded",
    ]
    if state == "fresh":
        assert calls == [INSTALL]
        assert "skipped build" in output.out
    else:
        assert calls == [INSTALL, BUILD]
        assert "rebuilt" in output.out


@pytest.mark.parametrize("failing_command", [INSTALL, BUILD])
def test_dev_update_stops_and_reports_the_failing_command(
    checkout: tuple[Path, Path], failing_command: list[str], capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[list[str]] = []

    def run(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        command = list(args)
        calls.append(command)
        if command == failing_command:
            return subprocess.CompletedProcess(args, 2)
        return subprocess.CompletedProcess(args, 0)

    assert main(["dev", "update"], run=run) != 0

    assert calls == ([INSTALL] if failing_command == INSTALL else [INSTALL, BUILD])
    output = capsys.readouterr()
    assert "rebuilt" not in output.out
    assert output.err == f"error: {' '.join(failing_command)} exited with status 2\n"


def test_dev_update_reports_missing_bun(
    checkout: tuple[Path, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    def run(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        assert list(args) == INSTALL
        raise FileNotFoundError(errno.ENOENT, "No such file or directory", "bun")

    assert main(["dev", "update"], run=run) == 1

    assert capsys.readouterr().err == "error: [Errno 2] No such file or directory: 'bun'\n"


def test_dev_update_requires_a_source_checkout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    web_dir = tmp_path / "missing-web"
    monkeypatch.setattr(frontend, "WEB_DIR", web_dir)

    def run(_args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        pytest.fail("Bun ran without a source checkout")

    assert main(["dev", "update"], run=run) == 1

    assert (
        capsys.readouterr().err == f"error: dev update requires a source checkout with {web_dir}\n"
    )
