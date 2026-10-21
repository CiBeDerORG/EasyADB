"""Isolated Git history and mocked external commands for the M3 -> V4 bridge.

The legacy/target scripts are checked-in snapshots, so shallow CI needs neither
old repository objects nor access to GitHub. Git itself is real and file-only.
"""
import os
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests/fixtures/m3-migration"
LEGACY = "feat/m3-openwrt-discovery"
TARGET = "refactor/v4-frontend-standards"
SCRIPTS = ("build-with-mihomo.sh", "update-m2.sh", "scheduled-deploy.sh")
REAL_GIT = shutil.which("git")


def shell(*args, cwd, env=None, check=True):
    return subprocess.run(args, cwd=cwd, env=env, text=True,
                          capture_output=True, check=check, timeout=30)


def git(project, env, *args, check=True):
    return shell(REAL_GIT, *args, cwd=project, env=env, check=check)


def executable(path, content):
    path.write_text(content)
    path.chmod(0o755)


def setup_migration(tmp_path, *, start="legacy", video_engine="webrtc"):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("GIT_", "EASYADB_", "SUDO_"))}
    env.update({
        "PATH": str(bindir) + os.pathsep + env.get("PATH", ""),
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_ALLOW_PROTOCOL": "file",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_AUTHOR_NAME": "Fixture",
        "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
        "GIT_COMMITTER_NAME": "Fixture",
        "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
        "LC_ALL": "C",
        "EASYADB_REAL_GIT": REAL_GIT,
        "EASYADB_EXPECTED_BRANCH": TARGET,
        "EASYADB_TEST_LOG": str(tmp_path / "docker.log"),
        "EASYADB_TEST_GIT_LOG": str(tmp_path / "git.log"),
        "FAKE_CRONTAB": str(tmp_path / "cron.txt"),
    })
    executable(bindir / "git", '''#!/bin/sh
printf '%s\\n' "$*" >> "$EASYADB_TEST_GIT_LOG"
exec "$EASYADB_REAL_GIT" "$@"
''')
    executable(bindir / "docker", '''#!/bin/sh
set -eu
# Any Docker command before the V4 transition is a test failure.
[ "$(git symbolic-ref --short HEAD)" = "$EASYADB_EXPECTED_BRANCH" ] || exit 91
printf '%s\\n' "$*" >> "$EASYADB_TEST_LOG"
if [ "${EASYADB_DOCKER_FAIL:-0}" = 1 ]; then
  case "$1:$2" in build:*|buildx:build) exit 42 ;; esac
fi
case "$*" in
  "compose version"|"build --progress=plain --tag easyadb:local ."|"compose -f compose.webrtc.yaml up -d --no-build") exit 0 ;;
esac
case "$1" in
  network) [ "$2" = inspect ] && exit 0 ;;
  inspect)
    case "$3" in
      *State.Running*) echo true; exit 0 ;;
      *NetworkSettings.Networks*) echo yes; exit 0 ;;
    esac ;;
  buildx)
    case "$2" in
      version|create|build) exit 0 ;;
      inspect) exit 1 ;;
    esac ;;
  image) [ "$2" = inspect ] && exit 0 ;;
esac
echo "Unexpected Docker invocation" >&2
exit 74
''')
    executable(bindir / "crontab", '''#!/bin/sh
case "$1" in
  -l) [ -e "$FAKE_CRONTAB" ] || exit 1; cat "$FAKE_CRONTAB" ;;
  -) cat > "$FAKE_CRONTAB" ;;
  *) exit 83 ;;
esac
''')
    for name in ("ssh", "curl", "wget", "sudo"):
        executable(bindir / name, '#!/bin/sh\necho "Unexpected external command" >&2\nexit 97\n')

    remote = tmp_path / "remote.git"
    producer = tmp_path / "producer"
    project = tmp_path / "EasyADB"
    git(tmp_path, env, "init", "--bare", "--initial-branch=" + LEGACY, str(remote))
    git(tmp_path, env, "init", "--initial-branch=" + LEGACY, str(producer))
    scripts = producer / "scripts"
    scripts.mkdir()
    shutil.copyfile(ROOT / ".gitignore", producer / ".gitignore")
    for name in SCRIPTS:
        shutil.copyfile(FIXTURES / "legacy" / name, scripts / name)
    # External proxy discovery is deliberately outside the migration contract.
    (scripts / "proxy-config.sh").write_text("PROXY=http://mihomo:7890\n")
    (scripts / "proxy-host.sh").write_text(
        "HOST_PROXY=http://127.0.0.1:7890\nMIHOMO_IP=192.0.2.11\n")
    (producer / "README.md").write_text("legacy M3\n")
    git(producer, env, "add", ".")
    git(producer, env, "commit", "-m", "old M3 scripts")
    legacy_head = git(producer, env, "rev-parse", "HEAD").stdout.strip()
    git(producer, env, "remote", "add", "origin", str(remote))
    git(producer, env, "push", "origin", LEGACY)

    git(producer, env, "switch", "-c", TARGET)
    for name in SCRIPTS:
        shutil.copyfile(FIXTURES / "v4" / name, scripts / name)
    (producer / "README.md").write_text("V4 target\n")
    git(producer, env, "add", ".")
    git(producer, env, "commit", "-m", "V4 target scripts")
    target_head = git(producer, env, "rev-parse", "HEAD").stdout.strip()
    git(producer, env, "push", "origin", TARGET)

    # The installation starts before the bridge exists and fetches only M3.
    git(tmp_path, env, "clone", "--single-branch", "--branch", LEGACY,
        str(remote), str(project))
    git(producer, env, "switch", LEGACY)
    for name in SCRIPTS:
        shutil.copyfile(ROOT / "scripts" / name, scripts / name)
    (producer / "README.md").write_text("M3 migration bridge\n")
    git(producer, env, "add", ".")
    git(producer, env, "commit", "-m", "M3 migration bridge")
    bridge_head = git(producer, env, "rev-parse", "HEAD").stdout.strip()
    git(producer, env, "push", "origin", LEGACY)
    if start == "bridge":
        git(project, env, "pull", "--ff-only", "origin", LEGACY)
    elif start != "legacy":
        raise ValueError(start)

    ignored = {
        ".env": ("EASYADB_TOKEN=fixture-only\nEASYADB_VIDEO_ENGINE=" + video_engine + "\n").encode(),
        "data/adb/adbkey": b"fixture only, not a real key\n",
        "data/storage/devices.sqlite3": b"existing fixture database bytes\x00\x01",
        ".cache/keep": b"existing cache\n",
    }
    for relative, content in ignored.items():
        path = project / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    return SimpleNamespace(project=project, env=env, remote=remote,
                           producer=producer, legacy_head=legacy_head,
                           bridge_head=bridge_head, target_head=target_head,
                           ignored=ignored, log=tmp_path / "docker.log",
                           git_log=tmp_path / "git.log", cron=tmp_path / "cron.txt")


def invoke(fixture, name="build-with-mihomo.sh", *args):
    return shell("sh", "scripts/" + name, *args, cwd=fixture.project,
                 env=fixture.env, check=False)


def assert_preserved(fixture):
    for relative, content in fixture.ignored.items():
        assert (fixture.project / relative).read_bytes() == content, relative
    assert git(fixture.project, fixture.env, "status", "--porcelain").stdout == ""
    assert git(fixture.project, fixture.env, "config", "--get-all", "remote.origin.fetch").stdout.strip() == (
        "+refs/heads/" + LEGACY + ":refs/remotes/origin/" + LEGACY)


def remote_change(fixture, value):
    git(fixture.producer, fixture.env, "switch", TARGET)
    (fixture.producer / "README.md").write_text(value + "\n")
    git(fixture.producer, fixture.env, "add", "README.md")
    git(fixture.producer, fixture.env, "commit", "-m", value)
    git(fixture.producer, fixture.env, "push", "origin", TARGET)
    fixture.target_head = git(fixture.producer, fixture.env, "rev-parse", "HEAD").stdout.strip()
