import json
import os
import shutil
import subprocess
import tempfile
from collections.abc import Sequence
from fractions import Fraction
from pathlib import Path

import pytest

from pb_tokei import main
from pb_tokei.convert import (
    AUDIO_BITRATE,
    KEYFRAME_INTERVAL,
    TARGET_FPS,
    VIDEO_CRF,
    VIDEO_PIX_FMT,
    VIDEO_PRESET,
    FootageConversionError,
    convert_footage,
    converted_path_for,
)

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


class FakeFfmpeg:
    """Test double for ffprobe and ffmpeg invocations."""

    def __init__(
        self,
        *,
        audio_codec: str | None = "opus",
        output_bytes: bytes = b"fake-60fps-mp4-bytes",
        probe_returncode: int = 0,
        probe_stderr: str = "",
        encode_returncode: int = 0,
        encode_stderr: str | None = "",
        write_output: bool = True,
    ) -> None:
        self.audio_codec = audio_codec
        self.output_bytes = output_bytes
        self.probe_returncode = probe_returncode
        self.probe_stderr = probe_stderr
        self.encode_returncode = encode_returncode
        self.encode_stderr = encode_stderr
        self.write_output = write_output
        self.calls: list[list[str]] = []

    @property
    def probe_calls(self) -> list[list[str]]:
        return [c for c in self.calls if c[0] == "ffprobe"]

    @property
    def encode_calls(self) -> list[list[str]]:
        return [c for c in self.calls if c[0] == "ffmpeg"]

    def __call__(self, args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        cmd = list(args)
        self.calls.append(cmd)
        if cmd[0] == "ffprobe":
            stdout = f"{self.audio_codec}\n" if self.audio_codec is not None else ""
            return subprocess.CompletedProcess(
                cmd, self.probe_returncode, stdout=stdout, stderr=self.probe_stderr
            )

        if cmd[0] == "ffmpeg":
            out_path = Path(cmd[-1])
            if self.encode_returncode == 0 and self.write_output:
                out_path.write_bytes(self.output_bytes)
            elif self.write_output and self.output_bytes:
                # Simulate partial output written before failing.
                out_path.write_bytes(b"partial-corrupt")
            return subprocess.CompletedProcess(
                cmd,
                self.encode_returncode,
                stdout="",
                stderr=self.encode_stderr,  # type: ignore[arg-type]
            )

        raise AssertionError(f"Unexpected command: {cmd}")


# --- converted_path_for -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        (Path("footage/dQw4w9WgXcQ.mkv"), Path("footage/dQw4w9WgXcQ.60fps.mp4")),
        (Path("footage/dQw4w9WgXcQ.mp4"), Path("footage/dQw4w9WgXcQ.60fps.mp4")),
        (Path("footage/dQw4w9WgXcQ.webm"), Path("footage/dQw4w9WgXcQ.60fps.mp4")),
        (Path("/abs/dir/clip.mov"), Path("/abs/dir/clip.60fps.mp4")),
    ],
)
def test_converted_path_for_derives_sibling_60fps_mp4(source: Path, expected: Path) -> None:
    assert converted_path_for(source) == expected


@pytest.mark.parametrize(
    "converted", [Path("footage/abc.60fps.mp4"), Path("footage/abc.60FPS.MP4")]
)
def test_converted_path_for_rejects_already_converted_file(converted: Path) -> None:
    with pytest.raises(FootageConversionError, match="already a converted"):
        converted_path_for(converted)


# --- convert_footage (unit tests with fake runner) ----------------------------------------


def test_convert_footage_builds_expected_ffmpeg_command_for_non_aac_audio(tmp_path: Path) -> None:
    source = tmp_path / "match1.mkv"
    source.write_bytes(b"original-video")
    fake = FakeFfmpeg(audio_codec="opus", output_bytes=b"converted-bytes")

    result = convert_footage(source, run=fake)

    expected_output = tmp_path / "match1.60fps.mp4"
    assert result.source_path == source
    assert result.output_path == expected_output
    assert result.already_converted is False
    assert expected_output.read_bytes() == b"converted-bytes"
    assert source.read_bytes() == b"original-video"

    assert len(fake.probe_calls) == 1
    assert len(fake.encode_calls) == 1
    cmd = fake.encode_calls[0]
    assert cmd[0] == "ffmpeg"
    assert "-nostats" in cmd
    assert cmd[cmd.index("-progress") + 1] == "pipe:1"
    assert cmd[cmd.index("-i") + 1] == str(source)
    assert cmd[cmd.index("-r") + 1] == str(TARGET_FPS)
    assert cmd[cmd.index("-fps_mode") + 1] == "cfr"
    assert cmd[cmd.index("-c:v") + 1] == "libx264"
    assert cmd[cmd.index("-preset") + 1] == VIDEO_PRESET
    assert cmd[cmd.index("-crf") + 1] == str(VIDEO_CRF)
    assert cmd[cmd.index("-pix_fmt") + 1] == VIDEO_PIX_FMT
    assert cmd[cmd.index("-g") + 1] == str(KEYFRAME_INTERVAL)
    assert cmd[cmd.index("-keyint_min") + 1] == str(KEYFRAME_INTERVAL)
    assert cmd[cmd.index("-sc_threshold") + 1] == "0"
    assert cmd[cmd.index("-c:a") + 1] == "aac"
    assert cmd[cmd.index("-b:a") + 1] == AUDIO_BITRATE
    assert cmd[cmd.index("-movflags") + 1] == "+faststart+negative_cts_offsets"
    assert cmd[cmd.index("-f") + 1] == "mp4"
    assert "-s" not in cmd

    # Wrote to a temp file in the same directory, then renamed to final output.
    temp_target = Path(cmd[-1])
    assert temp_target != expected_output
    assert temp_target.parent == tmp_path
    assert not temp_target.exists()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["match1.60fps.mp4", "match1.mkv"]


def test_convert_footage_copies_aac_audio_without_reencoding(tmp_path: Path) -> None:
    source = tmp_path / "match1.mp4"
    source.write_bytes(b"original-aac-video")
    fake = FakeFfmpeg(audio_codec="aac")

    convert_footage(source, run=fake)

    cmd = fake.encode_calls[0]
    assert cmd[cmd.index("-c:a") + 1] == "copy"
    assert "-b:a" not in cmd


def test_convert_footage_handles_video_without_audio_stream(tmp_path: Path) -> None:
    source = tmp_path / "silent.mp4"
    source.write_bytes(b"original-silent-video")
    fake = FakeFfmpeg(audio_codec=None)

    convert_footage(source, run=fake)

    cmd = fake.encode_calls[0]
    assert "-an" in cmd
    assert "-c:a" not in cmd


def test_convert_footage_skips_existing_output_unless_forced(tmp_path: Path) -> None:
    source = tmp_path / "match1.mkv"
    source.write_bytes(b"original")
    existing_out = tmp_path / "match1.60fps.mp4"
    existing_out.write_bytes(b"already-converted")
    fake = FakeFfmpeg(audio_codec="aac", output_bytes=b"reconverted")

    skipped = convert_footage(source, run=fake)
    assert skipped.already_converted is True
    assert skipped.output_path == existing_out
    assert existing_out.read_bytes() == b"already-converted"
    assert fake.calls == []

    forced = convert_footage(source, force=True, run=fake)
    assert forced.already_converted is False
    assert forced.output_path == existing_out
    assert existing_out.read_bytes() == b"reconverted"
    assert len(fake.encode_calls) == 1


def test_convert_footage_does_not_skip_empty_converted_file(tmp_path: Path) -> None:
    source = tmp_path / "match1.mkv"
    source.write_bytes(b"original")
    (tmp_path / "match1.60fps.mp4").write_bytes(b"")
    fake = FakeFfmpeg(audio_codec="aac", output_bytes=b"fresh-output")

    result = convert_footage(source, run=fake)

    assert result.already_converted is False
    assert result.output_path.read_bytes() == b"fresh-output"
    assert len(fake.encode_calls) == 1


def test_convert_footage_rebuilds_when_source_is_newer_than_converted_output(
    tmp_path: Path,
) -> None:
    source = tmp_path / "match1.mkv"
    source.write_bytes(b"newer-original")
    output = tmp_path / "match1.60fps.mp4"
    output.write_bytes(b"stale-converted")
    os.utime(output, (1_000_000, 1_000_000))
    os.utime(source, (1_000_010, 1_000_010))
    fake = FakeFfmpeg(audio_codec="aac", output_bytes=b"fresh-converted")

    result = convert_footage(source, run=fake)

    assert result.already_converted is False
    assert output.read_bytes() == b"fresh-converted"
    assert len(fake.encode_calls) == 1


def test_convert_footage_rejects_ambiguous_sibling_sources_sharing_stem(tmp_path: Path) -> None:
    mkv = tmp_path / "clip.mkv"
    mp4 = tmp_path / "clip.mp4"
    mkv.write_bytes(b"video-one")
    mp4.write_bytes(b"video-two")
    fake = FakeFfmpeg()

    with pytest.raises(FootageConversionError, match="Multiple source videos share output name"):
        convert_footage(mkv, run=fake)

    with pytest.raises(FootageConversionError, match="Multiple source videos share output name"):
        convert_footage(mp4, run=fake)

    assert fake.calls == []


def test_convert_footage_ignores_non_video_and_empty_siblings_with_same_stem(
    tmp_path: Path,
) -> None:
    source = tmp_path / "clip.mkv"
    source.write_bytes(b"video-one")
    (tmp_path / "clip.mp4").write_bytes(b"")  # empty file ignored
    (tmp_path / "clip.mp4.part").write_bytes(b"partial")
    (tmp_path / "clip.json").write_text("{}")
    fake = FakeFfmpeg(audio_codec="aac", output_bytes=b"converted")

    result = convert_footage(source, run=fake)

    assert result.already_converted is False
    assert result.output_path == tmp_path / "clip.60fps.mp4"


def test_convert_footage_wraps_filesystem_oserrors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "match1.mkv"
    source.write_bytes(b"original")
    fake = FakeFfmpeg(audio_codec="aac", output_bytes=b"converted")

    def fail_mkstemp(*args: object, **kwargs: object) -> tuple[int, str]:
        raise PermissionError("read-only directory")

    monkeypatch.setattr(tempfile, "mkstemp", fail_mkstemp)
    with pytest.raises(FootageConversionError, match="Cannot create temporary file"):
        convert_footage(source, run=fake)

    monkeypatch.undo()

    def fail_replace(self: Path, target: Path) -> Path:
        raise PermissionError("cannot rename")

    monkeypatch.setattr(Path, "replace", fail_replace)
    with pytest.raises(FootageConversionError, match="Cannot write converted output"):
        convert_footage(source, run=fake)

    # Temporary file was cleaned up even when rename failed.
    assert [p.name for p in tmp_path.iterdir()] == ["match1.mkv"]


def test_convert_footage_cleans_up_temp_file_and_preserves_target_on_failure(
    tmp_path: Path,
) -> None:
    source = tmp_path / "match1.mkv"
    source.write_bytes(b"original")
    fake = FakeFfmpeg(encode_returncode=1, encode_stderr="codec error")

    with pytest.raises(FootageConversionError, match="codec error"):
        convert_footage(source, run=fake)

    assert not (tmp_path / "match1.60fps.mp4").exists()
    assert [p.name for p in tmp_path.iterdir()] == ["match1.mkv"]

    # When forcing over an existing converted file, a failed run leaves the previous file intact.
    existing = tmp_path / "match1.60fps.mp4"
    existing.write_bytes(b"previous-good-file")
    with pytest.raises(FootageConversionError, match="codec error"):
        convert_footage(source, force=True, run=fake)

    assert existing.read_bytes() == b"previous-good-file"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["match1.60fps.mp4", "match1.mkv"]


def test_convert_footage_falls_back_to_exit_status_when_ffmpeg_stderr_is_none(
    tmp_path: Path,
) -> None:
    source = tmp_path / "match1.mkv"
    source.write_bytes(b"original")
    fake = FakeFfmpeg(encode_returncode=2, encode_stderr=None)

    with pytest.raises(FootageConversionError, match="exit status 2"):
        convert_footage(source, run=fake)


def test_convert_footage_strips_progress_lines_when_reporting_ffmpeg_error(
    tmp_path: Path,
) -> None:
    source = tmp_path / "match1.mkv"
    source.write_bytes(b"original")
    fake = FakeFfmpeg(
        encode_returncode=1,
        encode_stderr=(
            "frame=   10 fps=0.0 time=00:00:00.16\rInvalid data found when processing input\n"
        ),
    )

    with pytest.raises(FootageConversionError, match="Invalid data found") as exc_info:
        convert_footage(source, run=fake)
    assert "frame=" not in str(exc_info.value)


def test_convert_footage_rejects_empty_ffmpeg_output_and_cleans_up_temp_file(
    tmp_path: Path,
) -> None:
    source = tmp_path / "match1.mkv"
    source.write_bytes(b"original")
    fake = FakeFfmpeg(output_bytes=b"")

    with pytest.raises(FootageConversionError, match="empty output file"):
        convert_footage(source, run=fake)

    assert [p.name for p in tmp_path.iterdir()] == ["match1.mkv"]


def test_convert_footage_surfaces_ffprobe_failure_without_running_ffmpeg(tmp_path: Path) -> None:
    source = tmp_path / "corrupt.mkv"
    source.write_bytes(b"not-a-video")
    fake = FakeFfmpeg(probe_returncode=1, probe_stderr="Invalid data found")

    with pytest.raises(FootageConversionError, match="Invalid data found"):
        convert_footage(source, run=fake)

    assert fake.encode_calls == []
    assert [p.name for p in tmp_path.iterdir()] == ["corrupt.mkv"]


def test_convert_footage_rejects_missing_and_empty_sources(tmp_path: Path) -> None:
    fake = FakeFfmpeg()

    with pytest.raises(FootageConversionError, match="not found"):
        convert_footage(tmp_path / "missing.mkv", run=fake)

    empty = tmp_path / "empty.mkv"
    empty.write_bytes(b"")
    with pytest.raises(FootageConversionError, match="empty"):
        convert_footage(empty, run=fake)

    already = tmp_path / "clip.60fps.mp4"
    already.write_bytes(b"converted")
    with pytest.raises(FootageConversionError, match="already a converted"):
        convert_footage(already, run=fake)

    assert fake.calls == []


def test_convert_footage_raises_clear_error_when_ffmpeg_or_ffprobe_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "match1.mkv"
    source.write_bytes(b"original")
    real_popen = subprocess.Popen

    def missing_ffprobe(args: Sequence[str], **kwargs: object) -> subprocess.Popen[bytes]:
        raise FileNotFoundError(f"No such file or directory: {args[0]!r}")

    monkeypatch.setattr(subprocess, "Popen", missing_ffprobe)
    with pytest.raises(FootageConversionError, match="install ffmpeg"):
        convert_footage(source)

    def missing_ffmpeg(args: Sequence[str], **_kwargs: object) -> subprocess.Popen[bytes]:
        if args[0] == "ffmpeg":
            raise FileNotFoundError("No such file or directory: 'ffmpeg'")
        import sys

        return real_popen(
            [
                sys.executable,
                "-c",
                'print(\'{"streams": [{"codec_type": "audio", "codec_name": "aac"}]}\')',
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    monkeypatch.setattr(subprocess, "Popen", missing_ffmpeg)
    with pytest.raises(FootageConversionError, match="ffmpeg is not installed"):
        convert_footage(source)

    assert [p.name for p in tmp_path.iterdir()] == ["match1.mkv"]


# --- CLI convert --------------------------------------------------------------------------


def test_cli_convert_prints_output_path_and_supports_force(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    source = tmp_path / "match1.mkv"
    source.write_bytes(b"original")
    fake = FakeFfmpeg(audio_codec="opus", output_bytes=b"first")

    code1 = main(["convert", str(source)], run=fake)
    out1 = capsys.readouterr()

    fake.output_bytes = b"second"
    code2 = main(["convert", str(source)], run=fake)
    out2 = capsys.readouterr()

    code3 = main(["convert", str(source), "--force"], run=fake)
    out3 = capsys.readouterr()

    expected = tmp_path / "match1.60fps.mp4"
    assert code1 == 0
    assert code2 == 0
    assert code3 == 0
    assert out1.out == f"{expected}\n"
    assert out2.out == f"{expected}\n"
    assert out3.out == f"{expected}\n"
    assert out1.err == ""
    assert out2.err == ""
    assert out3.err == ""
    assert expected.read_bytes() == b"second"
    assert len(fake.encode_calls) == 2


def test_cli_convert_returns_nonzero_on_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = FakeFfmpeg()

    code = main(["convert", str(tmp_path / "does_not_exist.mkv")], run=fake)
    captured = capsys.readouterr()

    assert code == 1
    assert captured.out == ""
    assert "not found" in captured.err


# --- Real ffmpeg integration tests --------------------------------------------------------


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg and ffprobe are required")
@pytest.mark.parametrize(
    ("name", "rate", "ext", "audio_codec"),
    [
        ("clip_30fps", "30", "mkv", "pcm_s16le"),
        ("clip_5994fps", "60000/1001", "mp4", "aac"),
        ("clip_60fps", "60", "mp4", "aac"),
    ],
)
def test_real_ffmpeg_conversion_produces_exact_60fps_cfr_with_audio(
    tmp_path: Path,
    name: str,
    rate: str,
    ext: str,
    audio_codec: str,
) -> None:
    source = tmp_path / f"{name}.{ext}"
    # testsrc2 burns the exact frame number directly into each video frame with no font dependency.
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size=160x90:rate={rate}:duration=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            audio_codec,
            str(source),
        ],
        check=True,
    )
    original_bytes = source.read_bytes()

    result = convert_footage(source)

    assert result.already_converted is False
    assert result.output_path == tmp_path / f"{name}.60fps.mp4"
    assert result.output_path.is_file()
    assert source.read_bytes() == original_bytes

    video_probe = json.loads(
        subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_streams",
                "-show_frames",
                "-of",
                "json",
                str(result.output_path),
            ],
            text=True,
        )
    )
    video_stream = video_probe["streams"][0]
    frames = video_probe["frames"]
    time_base = Fraction(video_stream["time_base"])

    assert video_stream["codec_name"] == "h264"
    assert video_stream["pix_fmt"] == "yuv420p"
    assert video_stream["width"] == 160
    assert video_stream["height"] == 90
    assert video_stream["r_frame_rate"] == "60/1"
    assert video_stream["avg_frame_rate"] == "60/1"
    assert len(frames) >= 119

    for n, frame in enumerate(frames):
        pts_seconds = Fraction(int(frame["pts"])) * time_base
        assert pts_seconds == Fraction(n, 60), f"frame {n} had pts {pts_seconds}"

    keyframe_indices = [i for i, frame in enumerate(frames) if frame.get("key_frame") == 1]
    assert keyframe_indices == list(range(0, len(frames), KEYFRAME_INTERVAL))

    audio_probe = json.loads(
        subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_streams",
                "-of",
                "json",
                str(result.output_path),
            ],
            text=True,
        )
    )
    assert len(audio_probe["streams"]) == 1
    audio_stream = audio_probe["streams"][0]
    assert audio_stream["codec_name"] == "aac"
    assert float(audio_stream["duration"]) > 1.5

    # Re-running skips without error; --force re-converts cleanly.
    skipped = convert_footage(source)
    assert skipped.already_converted is True
    assert skipped.output_path == result.output_path

    forced = convert_footage(source, force=True)
    assert forced.already_converted is False
    assert forced.output_path == result.output_path
    assert forced.output_path.is_file()
    assert forced.output_path.stat().st_size > 0


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg and ffprobe are required")
@pytest.mark.parametrize(
    ("name", "ext", "ffmpeg_source_args"),
    [
        (
            "video_after_audio_offset",
            "mp4",
            [
                "-itsoffset",
                "0.067",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x90:rate=30:duration=2",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
            ],
        ),
        (
            "mpegts_nonzero_start",
            "ts",
            [
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x90:rate=30:duration=2",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=2",
                "-output_ts_offset",
                "5.0",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
            ],
        ),
    ],
)
def test_real_ffmpeg_conversion_resets_nonzero_start_times_to_zero(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    name: str,
    ext: str,
    ffmpeg_source_args: list[str],
) -> None:
    source = tmp_path / f"{name}.{ext}"
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            *ffmpeg_source_args,
            str(source),
        ],
        check=True,
    )

    progress_updates: list[float | None] = []
    result = convert_footage(source, on_progress=lambda p: progress_updates.append(p.percent))
    assert any(p is not None and p > 0 for p in progress_updates)
    assert progress_updates[-1] == 100.0

    # Check both default ffprobe (honoring edit lists) and -ignore_editlist 1 so frame 0 is
    # guaranteed to have literal pts=0 in the MP4 without depending on an edit list.
    for ignore_editlist in ("0", "1"):
        video_probe = json.loads(
            subprocess.check_output(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-ignore_editlist",
                    ignore_editlist,
                    "-select_streams",
                    "v:0",
                    "-show_streams",
                    "-show_frames",
                    "-of",
                    "json",
                    str(result.output_path),
                ],
                text=True,
            )
        )
        video_stream = video_probe["streams"][0]
        frames = video_probe["frames"]
        time_base = Fraction(video_stream["time_base"])

        assert float(video_stream["start_time"]) == 0.0
        assert video_stream["r_frame_rate"] == "60/1"
        assert video_stream["avg_frame_rate"] == "60/1"
        assert len(frames) >= 120
        for n, frame in enumerate(frames):
            pts_seconds = Fraction(int(frame["pts"])) * time_base
            assert pts_seconds == Fraction(n, 60), (
                f"{name} (ignore_editlist={ignore_editlist}) frame {n} had pts {pts_seconds}"
            )
