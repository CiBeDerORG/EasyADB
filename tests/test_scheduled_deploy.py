"""Scheduled deployment + changed-Git-tree integration tests (no Docker daemon/cron)."""
from contextlib import contextmanager
import fcntl
import os
import select
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
V4_BRANCH = "refactor/v4-frontend-standards"
M3_BRANCH = "feat/m3-openwrt-discovery"


def shell(*args, cwd, env=None, check=True):
    return subprocess.run(args, cwd=cwd, env=env, text=True,
                          capture_output=True, check=check)


def setup_project(tmp_path, project_name="EasyADB"):
    project = tmp_path / project_name
    scripts = project / "scripts"
    scripts.mkdir(parents=True)
    for name in ("scheduled-deploy.sh", "build-with-mihomo.sh", "update-m2.sh", "deploy-lock.sh"):
        shutil.copyfile(ROOT / "scripts" / name, scripts / name)
    shutil.copyfile(ROOT / ".gitignore", project / ".gitignore")
    shutil.copyfile(ROOT / "compose.webrtc.yaml", project / "compose.webrtc.yaml")
    (project / "README.md").write_text("initial\n")
    shell("git", "init", "-b", V4_BRANCH, cwd=project)
    shell("git", "config", "user.email", "fixture@example.invalid", cwd=project)
    shell("git", "config", "user.name", "Fixture", cwd=project)
    shell("git", "add", ".", cwd=project)
    shell("git", "commit", "-m", "initial", cwd=project)
    remote = tmp_path / "remote.git"
    shell("git", "init", "--bare", str(remote), cwd=tmp_path)
    shell("git", "remote", "add", "origin", str(remote), cwd=project)
    shell("git", "push", "-u", "origin", V4_BRANCH, cwd=project)
    bindir = tmp_path / "bin"
    bindir.mkdir()
    crontab = bindir / "crontab"
    crontab.write_text('''#!/bin/sh
case "$1" in
 -l) [ -e "$FAKE_CRONTAB" ] || exit 1; cat "$FAKE_CRONTAB" ;;
 -) cat > "$FAKE_CRONTAB" ;;
 *) exit 83 ;;
esac
''')
    crontab.chmod(0o755)
    docker = bindir / "docker"
    docker.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$EASYADB_TEST_LOG"
if [ "${EASYADB_DOCKER_FAIL:-0}" = 1 ] && [ "$1" = build ]; then exit 42; fi
case "$*" in
 "compose version"|"build --progress=plain --tag easyadb:local ."|"compose -f compose.webrtc.yaml up -d --no-build")
   exit 0 ;;
esac
exit 74
''')
    docker.chmod(0o755)
    env = os.environ.copy()
    env.pop("EASYADB_UPDATED", None)
    env.pop("EASYADB_SOURCE_BRANCH", None)
    env.pop("EASYADB_VIDEO_ENGINE", None)
    env.pop("EASYADB_DOCKER_FAIL", None)
    env.pop("SUDO_UID", None)
    env.update({
        "PATH": str(bindir) + os.pathsep + env.get("PATH", ""),
        "FAKE_CRONTAB": str(tmp_path / "cron.txt"),
        "EASYADB_TEST_LOG": str(tmp_path / "docker.log"),
    })
    return project, env, remote


def invoke(project, env, name, *args):
    return shell("sh", "scripts/" + name, *args, cwd=project,
                 env=env, check=False)


def test_cron_start_status_no_early_run_due_run_and_stop(tmp_path):
    if not shutil.which("flock"):
        pytest.skip("flock not available")
    project, env, _ = setup_project(tmp_path)
    cron = tmp_path / "cron.txt"
    cron.write_text("@reboot echo unrelated\n")
    result = invoke(project, env, "scheduled-deploy.sh", "start", "15m", "--no-proxy")
    assert result.returncode == 0, result.stderr
    lines = cron.read_text().splitlines()
    assert len(lines) == 2 and lines[0] == "@reboot echo unrelated"
    assert "EASYADB_SCHEDULED_DEPLOY:" in lines[1]
    assert "scripts/scheduled-deploy.sh' run" in lines[1]
    status = invoke(project, env, "scheduled-deploy.sh", "status")
    assert "enabled" in status.stdout and "15 minute(s)" in status.stdout
    assert V4_BRANCH in status.stdout and "direct" in status.stdout

    # Use a stub deployment to confirm cron passes the selected mode and branch.
    (project / "scripts/build-with-mihomo.sh").write_text('''#!/bin/sh
printf '%s|%s|%s\\n' "$EASYADB_SOURCE_BRANCH" "$SUDO_UID" "$*" >> "$EASYADB_TEST_LOG"
''')
    first = invoke(project, env, "scheduled-deploy.sh", "run")
    assert first.returncode == 0 and not (tmp_path / "docker.log").exists()
    state = project / "data/storage/.easyadb-schedule-last-check"
    state.write_text("0\n")
    due = invoke(project, env, "scheduled-deploy.sh", "run")
    assert due.returncode == 0, due.stderr
    entries = (tmp_path / "docker.log").read_text().splitlines()
    assert len(entries) == 1
    assert entries[0] == f"{V4_BRANCH}|{os.getuid()}|--if-changed --no-proxy"
    invoke(project, env, "scheduled-deploy.sh", "run")
    assert (tmp_path / "docker.log").read_text().splitlines() == entries
    assert "Last result:" in invoke(project, env, "scheduled-deploy.sh", "status").stdout
    stop = invoke(project, env, "scheduled-deploy.sh", "stop")
    assert stop.returncode == 0
    assert cron.read_text().strip() == "@reboot echo unrelated"
    assert "disabled" in invoke(project, env, "scheduled-deploy.sh", "status").stdout


@pytest.mark.parametrize("interval", ("0m", "45x", "10081m", "8d", "m", "0h"))
def test_invalid_interval_never_modifies_crontab(tmp_path, interval):
    project, env, _ = setup_project(tmp_path)
    result = invoke(project, env, "scheduled-deploy.sh", "start", interval)
    assert result.returncode == 2
    assert not (tmp_path / "cron.txt").exists()


@pytest.mark.parametrize("project_name", ("EasyADB", "EasyADB [lab].+", "EasyADB\\tools"))
def test_cron_exact_job_identity_preserves_prefix_projects_and_unrelated_lines(tmp_path, project_name):
    project, env, _ = setup_project(tmp_path, project_name)
    sibling = project.with_name(project_name + "-staging")
    shutil.copytree(project, sibling)
    marker = "EASYADB_SCHEDULED_DEPLOY:" + str(project)
    unrelated = [
        "@reboot echo unrelated",
        "# Notes about " + marker,
        "15 * * * * echo archived # " + marker + "-archive",
        "30 * * * * echo marker-reference " + marker + " --dry-run",
    ]
    cron = tmp_path / "cron.txt"
    cron.write_text("\n".join(unrelated) + "\n")

    # A longer sibling name and text references do not enable this checkout.
    started = invoke(sibling, env, "scheduled-deploy.sh", "start", "2m", "--no-proxy")
    assert started.returncode == 0, started.stderr
    sibling_table = cron.read_text()
    assert "Status: disabled" in invoke(project, env, "scheduled-deploy.sh", "status").stdout
    assert invoke(project, env, "scheduled-deploy.sh", "stop").returncode == 0
    assert cron.read_text() == sibling_table

    started = invoke(project, env, "scheduled-deploy.sh", "start", "1m", "--no-proxy")
    assert started.returncode == 0, started.stderr
    lines = cron.read_text().splitlines()
    assert lines[:len(unrelated)] == unrelated
    assert len(lines) == len(unrelated) + 2
    sibling_entry = next(line for line in lines if line.endswith(" # " + marker + "-staging"))
    assert sibling_entry in sibling_table.splitlines()
    assert sum(line.endswith(" # " + marker) for line in lines) == 1
    assert "Status: enabled" in invoke(project, env, "scheduled-deploy.sh", "status").stdout
    assert "Status: enabled" in invoke(sibling, env, "scheduled-deploy.sh", "status").stdout

    # Reconfiguration replaces our entry once, retaining the sibling exactly.
    assert invoke(project, env, "scheduled-deploy.sh", "start", "3m").returncode == 0
    lines = cron.read_text().splitlines()
    assert lines[:len(unrelated)] == unrelated
    assert sibling_entry in lines and len(lines) == len(unrelated) + 2
    assert sum(line.endswith(" # " + marker) for line in lines) == 1
    assert "3 minute(s)" in invoke(project, env, "scheduled-deploy.sh", "status").stdout

    assert invoke(project, env, "scheduled-deploy.sh", "stop").returncode == 0
    assert cron.read_text().splitlines() == unrelated + [sibling_entry]
    assert "Status: disabled" in invoke(project, env, "scheduled-deploy.sh", "status").stdout
    assert "Status: enabled" in invoke(sibling, env, "scheduled-deploy.sh", "status").stdout
    # Stopped checkout still has config on disk; its sibling must not make
    # installed() true and allow a stale cron/manual run to deploy it.
    state = project / "data/storage/.easyadb-schedule-last-check"
    state.write_text("0\n")
    for command in ("run", "run-locked"):
        assert invoke(project, env, "scheduled-deploy.sh", command).returncode == 0
    assert state.read_text() == "0\n" and not (tmp_path / "docker.log").exists()
    assert invoke(sibling, env, "scheduled-deploy.sh", "stop").returncode == 0
    assert cron.read_text().splitlines() == unrelated


def test_changed_tree_skips_rebuild_then_deploys_and_retries_failure(tmp_path):
    project, env, remote = setup_project(tmp_path)
    producer = tmp_path / "producer"
    shell("git", "clone", str(remote), str(producer), cwd=tmp_path)
    shell("git", "checkout", V4_BRANCH, cwd=producer)
    shell("git", "config", "user.email", "fixture@example.invalid", cwd=producer)
    shell("git", "config", "user.name", "Fixture", cwd=producer)
    env["EASYADB_SOURCE_BRANCH"] = V4_BRANCH

    def remote_change(value):
        (producer / "README.md").write_text(value + "\n")
        shell("git", "add", "README.md", cwd=producer)
        shell("git", "commit", "-m", value, cwd=producer)
        shell("git", "push", "origin", V4_BRANCH, cwd=producer)

    build_args = ("build-with-mihomo.sh", "--if-changed", "--no-proxy")
    initial = invoke(project, env, *build_args)
    assert initial.returncode == 0, initial.stderr
    assert "skipping Docker" in initial.stdout
    marker = project / "data/storage/.easyadb-last-deployed-tree"
    before = marker.read_text().strip()
    assert not (tmp_path / "docker.log").exists()
    remote_change("update one")
    updated = invoke(project, env, *build_args)
    assert updated.returncode == 0, updated.stdout + updated.stderr
    after = marker.read_text().strip()
    assert after != before
    calls = (tmp_path / "docker.log").read_text().splitlines()
    assert calls == ["compose version", "build --progress=plain --tag easyadb:local .",
                     "compose -f compose.webrtc.yaml up -d --no-build"]
    unchanged = invoke(project, env, *build_args)
    assert unchanged.returncode == 0 and "skipping Docker" in unchanged.stdout
    assert (tmp_path / "docker.log").read_text().splitlines() == calls

    remote_change("update two")
    env["EASYADB_DOCKER_FAIL"] = "1"
    failed = invoke(project, env, *build_args)
    assert failed.returncode == 42, failed.stdout + failed.stderr
    assert marker.read_text().strip() == after, "failed build never advances deployment marker"
    env.pop("EASYADB_DOCKER_FAIL")
    retried = invoke(project, env, *build_args)
    assert retried.returncode == 0, retried.stdout + retried.stderr
    assert marker.read_text().strip() != after
    assert (tmp_path / "docker.log").read_text().count("build --progress=plain") == 3


@pytest.mark.parametrize("branch,expected,explicit", (
    (M3_BRANCH, V4_BRANCH, True),
    (M3_BRANCH, V4_BRANCH, False),
    (V4_BRANCH, V4_BRANCH, True),
    (V4_BRANCH, V4_BRANCH, False),
    ("feat/display-mode-lab", "feat/display-mode-lab", True),
    ("feat/m2-web-control", "feat/m2-web-control", True),
    ("refactor/foundation-v1", "refactor/foundation-v1", True),
    ("refactor/session-v2", "refactor/session-v2", True),
    ("refactor/v2-session-governance", "refactor/v2-session-governance", True),
))
def test_scheduler_start_read_config_and_due_run_agree_on_allowed_branch(
        tmp_path, branch, expected, explicit):
    project, env, _ = setup_project(tmp_path)
    if explicit:
        env["EASYADB_SOURCE_BRANCH"] = branch
    elif branch != V4_BRANCH:
        shell("git", "switch", "-c", branch, cwd=project)
    started = invoke(project, env, "scheduled-deploy.sh", "start", "15m", "--no-proxy")
    assert started.returncode == 0, started.stdout + started.stderr
    status = invoke(project, env, "scheduled-deploy.sh", "status")
    assert f"Branch: {expected}" in status.stdout
    config = (project / "data/storage/.easyadb-schedule").read_text().splitlines()
    assert config == ["15", "direct", str(os.getuid()), expected]

    # Force a scheduled tick, with a fake builder (no Git/Docker deployment).
    (project / "scripts/build-with-mihomo.sh").write_text(
        '#!/bin/sh\nprintf "%s|%s\\n" "$EASYADB_SOURCE_BRANCH" "$*" >> "$EASYADB_TEST_LOG"\n'
    )
    (project / "data/storage/.easyadb-schedule-last-check").write_text("0\n")
    due = invoke(project, env, "scheduled-deploy.sh", "run-locked")
    assert due.returncode == 0, due.stdout + due.stderr
    assert (tmp_path / "docker.log").read_text().splitlines() == [
        f"{expected}|--if-changed --no-proxy"
    ]


@pytest.mark.parametrize("checked_out", (M3_BRANCH, V4_BRANCH))
def test_legacy_m3_schedule_migrates_to_v4_without_manual_config_edit(tmp_path, checked_out):
    project, env, _ = setup_project(tmp_path)
    shell("git", "switch", "-c", M3_BRANCH, cwd=project)
    (project / "README.md").write_text("old M3 deployment\n")
    shell("git", "add", "README.md", cwd=project)
    shell("git", "commit", "-m", "M3-only history", cwd=project)
    shell("git", "push", "-u", "origin", M3_BRANCH, cwd=project)
    m3_head = shell("git", "rev-parse", "HEAD", cwd=project).stdout.strip()
    m3_tree = shell("git", "rev-parse", "HEAD^{tree}", cwd=project).stdout.strip()
    shell("git", "switch", V4_BRANCH, cwd=project)
    (project / "README.md").write_text("new V4 deployment\n")
    shell("git", "add", "README.md", cwd=project)
    shell("git", "commit", "-m", "V4-only history", cwd=project)
    shell("git", "push", "-u", "origin", V4_BRANCH, cwd=project)
    v4_head = shell("git", "rev-parse", "HEAD", cwd=project).stdout.strip()
    v4_tree = shell("git", "rev-parse", "HEAD^{tree}", cwd=project).stdout.strip()
    shell("git", "switch", checked_out, cwd=project)

    cron = tmp_path / "cron.txt"
    cron.write_text("@reboot echo unrelated\n")
    started = invoke(project, env, "scheduled-deploy.sh", "start", "15m", "--no-proxy")
    assert started.returncode == 0, started.stdout + started.stderr
    cron_before = cron.read_text()
    state = project / "data/storage"
    # Model an existing installation made by an older scheduler. Production
    # must normalize this persisted source without asking the user to rewrite it.
    config = state / ".easyadb-schedule"
    config.write_text(f"15\ndirect\n{os.getuid()}\n{M3_BRANCH}\n")
    marker = state / ".easyadb-last-deployed-tree"
    marker.write_text(m3_tree + "\n")
    (state / ".easyadb-schedule-last-check").write_text("0\n")
    (project / ".env").write_text("EASYADB_VIDEO_ENGINE=webrtc\n")
    (state / "fixture.sqlite3").write_bytes(b"preserved deployed database")

    status = invoke(project, env, "scheduled-deploy.sh", "status")
    assert status.returncode == 0, status.stdout + status.stderr
    assert f"Branch: {V4_BRANCH}" in status.stdout
    due = invoke(project, env, "scheduled-deploy.sh", "run-locked")
    assert due.returncode == 0, due.stdout + due.stderr
    assert f"Scheduled Git check: {V4_BRANCH} / direct" in due.stdout
    assert shell("git", "branch", "--show-current", cwd=project).stdout.strip() == V4_BRANCH
    assert shell("git", "rev-parse", "HEAD", cwd=project).stdout.strip() == v4_head
    assert shell("git", "rev-parse", M3_BRANCH, cwd=project).stdout.strip() == m3_head
    assert marker.read_text().strip() == v4_tree
    assert cron.read_text() == cron_before
    assert (project / ".env").read_text() == "EASYADB_VIDEO_ENGINE=webrtc\n"
    assert (state / "fixture.sqlite3").read_bytes() == b"preserved deployed database"
    calls = (tmp_path / "docker.log").read_text().splitlines()
    assert calls == ["compose version", "build --progress=plain --tag easyadb:local .",
                     "compose -f compose.webrtc.yaml up -d --no-build"]

    # A subsequent tick still targets V4 and recognizes the deployed file tree.
    (state / ".easyadb-schedule-last-check").write_text("0\n")
    again = invoke(project, env, "scheduled-deploy.sh", "run-locked")
    assert again.returncode == 0, again.stdout + again.stderr
    assert "skipping Docker" in again.stdout
    assert shell("git", "branch", "--show-current", cwd=project).stdout.strip() == V4_BRANCH
    assert (tmp_path / "docker.log").read_text().splitlines() == calls
    assert f"Branch: {V4_BRANCH}" in invoke(project, env, "scheduled-deploy.sh", "status").stdout


@pytest.mark.parametrize("branch", ("feat/m4-screen-mapping-m1", "experimental/unknown"))
def test_scheduler_rejects_m4_and_unknown_branch_without_cron_mutation(tmp_path, branch):
    project, env, _ = setup_project(tmp_path)
    env["EASYADB_SOURCE_BRANCH"] = branch
    rejected = invoke(project, env, "scheduled-deploy.sh", "start", "15m")
    assert rejected.returncode == 2
    assert "unsupported scheduled branch" in rejected.stderr
    assert not (tmp_path / "cron.txt").exists()
    assert not (project / "data/storage/.easyadb-schedule").exists()


@pytest.mark.parametrize("branch", ("feat/m4-screen-mapping-m1", "experimental/unknown"))
def test_scheduler_rejects_invalid_persisted_branch_before_running_builder(tmp_path, branch):
    project, env, _ = setup_project(tmp_path)
    started = invoke(project, env, "scheduled-deploy.sh", "start", "15m", "--no-proxy")
    assert started.returncode == 0, started.stdout + started.stderr
    config_path = project / "data/storage/.easyadb-schedule"
    config = config_path.read_text().splitlines()
    config[3] = branch
    config_path.write_text("\n".join(config) + "\n")
    rejected = invoke(project, env, "scheduled-deploy.sh", "run-locked")
    assert rejected.returncode == 1
    assert "invalid scheduled deployment state" in rejected.stderr
    assert not (tmp_path / "docker.log").exists()


def setup_concurrent_deploy(tmp_path):
    """Real local Git/flock; Docker signals a paused build through inherited pipes."""
    project, env, remote = setup_project(tmp_path)
    scripts = project / "scripts"
    # Exercise the real default Buildx path without discovering a real proxy.
    (scripts / "proxy-config.sh").write_text("PROXY=http://mihomo:7890\n")
    (scripts / "proxy-host.sh").write_text("HOST_PROXY=http://127.0.0.1:7890\nMIHOMO_IP=192.0.2.11\n")
    shell("git", "add", "scripts", cwd=project)
    shell("git", "commit", "-m", "fixture proxy configuration", cwd=project)
    shell("git", "push", "origin", V4_BRANCH, cwd=project)
    producer = tmp_path / "producer"
    shell("git", "clone", "--branch", V4_BRANCH, str(remote), str(producer), cwd=tmp_path)
    shell("git", "config", "user.email", "fixture@example.invalid", cwd=producer)
    shell("git", "config", "user.name", "Fixture", cwd=producer)
    state = tmp_path / "docker-state"
    state.mkdir()
    env["EASYADB_TEST_STATE"] = str(state)
    docker = tmp_path / "bin/docker"
    docker.write_text("#!" + sys.executable + "\n" + r'''
import json
import os
from pathlib import Path
import subprocess
import sys

state = Path(os.environ["EASYADB_TEST_STATE"])
role = os.environ.get("EASYADB_TEST_ROLE", "scheduled")
args = sys.argv[1:]
with (state / "calls.jsonl").open("a") as output:
    output.write(json.dumps({"role": role, "args": args}) + "\n")
if args == ["compose", "version"] or args[:2] in (["network", "inspect"], ["image", "inspect"]):
    sys.exit(0)
if args[:1] == ["inspect"]:
    print("true" if "State.Running" in args[2] else "yes")
    sys.exit(0)
if args[:2] == ["buildx", "inspect"]:
    sys.exit(1)
if args[:2] in (["buildx", "version"], ["buildx", "create"]):
    sys.exit(0)
if args[:1] == ["build"] or args[:2] == ["buildx", "build"]:
    tree = subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], text=True).strip()
    (state / ("built-" + role)).write_text(tree)
    if os.environ.get("EASYADB_TEST_PAUSE") == "1":
        os.write(int(os.environ["EASYADB_TEST_READY_FD"]), b"ready\n")
        if os.read(int(os.environ["EASYADB_TEST_RELEASE_FD"]), 1) != b"1":
            sys.exit(94)
    if os.environ.get("EASYADB_TEST_FAIL_BUILD") == "1":
        sys.exit(42)
    (state / "image-tree").write_text(tree)
    sys.exit(0)
if args == ["compose", "-f", "compose.webrtc.yaml", "up", "-d", "--no-build"]:
    if os.environ.get("EASYADB_TEST_FAIL_START") == "1":
        sys.exit(43)
    (state / "running-tree").write_text((state / "image-tree").read_text())
    sys.exit(0)
sys.exit(95)
''')
    docker.chmod(0o755)
    return project, env, producer, state


def publish_change(producer, value, *, replace_builder=False):
    (producer / "README.md").write_text(value + "\n")
    if replace_builder:
        builder = producer / "scripts/build-with-mihomo.sh"
        builder.write_text(builder.read_text().replace(
            "set -eu\n", "set -eu\nprintf '%s\\n' \"$*\" >> \"$EASYADB_TEST_STATE/reentry.log\"\n", 1))
    shell("git", "add", ".", cwd=producer)
    shell("git", "commit", "-m", value, cwd=producer)
    shell("git", "push", "origin", V4_BRANCH, cwd=producer)
    return shell("git", "rev-parse", "HEAD^{tree}", cwd=producer).stdout.strip()


@contextmanager
def paused_deployment(project, env, script, *args):
    # Pipe readiness is a real execution boundary, not a sleep-based guess.
    ready_read, ready_write = os.pipe()
    release_read, release_write = os.pipe()
    # The production scripts reserve FD 9; keep test signaling descriptors
    # outside that range regardless of pytest's current capture descriptors.
    ready_inherited = fcntl.fcntl(ready_write, fcntl.F_DUPFD_CLOEXEC, 20)
    release_inherited = fcntl.fcntl(release_read, fcntl.F_DUPFD_CLOEXEC, 20)
    os.close(ready_write)
    os.close(release_read)
    child_env = dict(env, EASYADB_TEST_PAUSE="1", EASYADB_TEST_READY_FD=str(ready_inherited),
                     EASYADB_TEST_RELEASE_FD=str(release_inherited))
    process = subprocess.Popen(
        ["sh", "scripts/" + script, *args], cwd=project, env=child_env,
        text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        pass_fds=(ready_inherited, release_inherited),
    )
    os.close(ready_inherited)
    os.close(release_inherited)

    def resume():
        nonlocal release_write
        if release_write is not None:
            try:
                os.write(release_write, b"1")
            except BrokenPipeError:
                pass
            os.close(release_write)
            release_write = None

    try:
        readable, _, _ = select.select([ready_read], [], [], 10)
        assert readable, "Deployment never reached the paused Docker build"
        assert os.read(ready_read, 6) == b"ready\n", process.communicate(timeout=5)
        yield process, resume
    finally:
        resume()
        os.close(ready_read)
        if process.poll() is None:
            process.communicate(timeout=10)


@pytest.mark.parametrize("direct", (False, True), ids=("mihomo", "direct"))
def test_manual_build_excludes_cron_and_failed_new_version_is_retried(tmp_path, direct):
    project, env, producer, docker_state = setup_concurrent_deploy(tmp_path)
    mode = ("--no-proxy",) if direct else ()
    assert invoke(project, env, "scheduled-deploy.sh", "start", "1m", *mode).returncode == 0
    state = project / "data/storage"
    marker = state / ".easyadb-last-deployed-tree"
    last_check = state / ".easyadb-schedule-last-check"
    last_result = state / ".easyadb-schedule-last-result"
    tree_a = shell("git", "rev-parse", "HEAD^{tree}", cwd=project).stdout.strip()
    marker.write_text(tree_a + "\n")
    last_check.write_text("0\n")
    result_before = last_result.read_text()
    (state / "fixture.sqlite3").write_bytes(b"preserved database")
    (project / ".env").write_text("EASYADB_VIDEO_ENGINE=webrtc\n")
    with paused_deployment(project, dict(env, EASYADB_TEST_ROLE="manual"),
                           "build-with-mihomo.sh", *mode) as (manual, resume):
        assert (docker_state / "built-manual").read_text() == tree_a
        tree_b = publish_change(producer, "version B")
        calls_before = (docker_state / "calls.jsonl").read_text()
        for command in ("run", "run-locked"):
            skipped = invoke(project, env, "scheduled-deploy.sh", command)
            assert skipped.returncode == 0, skipped.stderr
        for override in ({}, {"EASYADB_UPDATED": "1"}):
            rejected = invoke(project, dict(env, **override), "build-with-mihomo.sh", *mode)
            assert rejected.returncode == 75, rejected.stdout + rejected.stderr
            assert "already running" in rejected.stderr
        assert (docker_state / "calls.jsonl").read_text() == calls_before
        assert shell("git", "rev-parse", "HEAD^{tree}", cwd=project).stdout.strip() == tree_a
        assert last_check.read_text() == "0\n" and last_result.read_text() == result_before
        resume()
        stdout, stderr = manual.communicate(timeout=10)
        assert manual.returncode == 0, stdout + stderr
    assert marker.read_text().strip() == (docker_state / "running-tree").read_text() == tree_a

    # Both image build and container-start failures retain A's marker, so B
    # remains eligible for the next due tick rather than being falsely skipped.
    for failure, code in (("EASYADB_TEST_FAIL_BUILD", 42), ("EASYADB_TEST_FAIL_START", 43)):
        last_check.write_text("0\n")
        failed = invoke(project, dict(env, **{failure: "1"}), "scheduled-deploy.sh", "run")
        assert failed.returncode == 0
        assert f"FAILED (exit {code})" in last_result.read_text()
        assert (docker_state / "built-scheduled").read_text() == tree_b
        assert marker.read_text().strip() == (docker_state / "running-tree").read_text() == tree_a
    last_check.write_text("0\n")
    retried = invoke(project, env, "scheduled-deploy.sh", "run")
    assert retried.returncode == 0, retried.stdout + retried.stderr
    assert "deployment successful" in last_result.read_text()
    assert marker.read_text().strip() == (docker_state / "running-tree").read_text() == tree_b
    assert (state / "fixture.sqlite3").read_bytes() == b"preserved database"
    assert (project / ".env").read_text() == "EASYADB_VIDEO_ENGINE=webrtc\n"
    calls_before = (docker_state / "calls.jsonl").read_text()
    last_check.write_text("0\n")
    unchanged = invoke(project, env, "scheduled-deploy.sh", "run")
    assert "skipping Docker" in unchanged.stdout
    assert (docker_state / "calls.jsonl").read_text() == calls_before


@pytest.mark.parametrize("direct", (False, True), ids=("mihomo", "direct"))
def test_scheduler_keeps_deployment_lock_and_arguments_across_builder_self_update(tmp_path, direct):
    project, env, producer, docker_state = setup_concurrent_deploy(tmp_path)
    mode = ("--no-proxy",) if direct else ()
    assert invoke(project, env, "scheduled-deploy.sh", "start", "1m", *mode).returncode == 0
    state = project / "data/storage"
    marker = state / ".easyadb-last-deployed-tree"
    tree_a = shell("git", "rev-parse", "HEAD^{tree}", cwd=project).stdout.strip()
    marker.write_text(tree_a + "\n")
    tree_b = publish_change(producer, "updated builder B", replace_builder=True)
    last_check = state / ".easyadb-schedule-last-check"
    last_check.write_text("0\n")
    with paused_deployment(project, env, "scheduled-deploy.sh", "run") as (scheduled, resume):
        assert (docker_state / "built-scheduled").read_text() == tree_b
        assert (docker_state / "reentry.log").read_text().splitlines() == [
            "--if-changed --no-proxy" if direct else "--if-changed"
        ]
        check_before = last_check.read_text()
        calls_before = (docker_state / "calls.jsonl").read_text()
        rejected = invoke(project, env, "build-with-mihomo.sh", *mode)
        assert rejected.returncode == 75
        assert invoke(project, env, "scheduled-deploy.sh", "run").returncode == 0
        assert last_check.read_text() == check_before
        assert (docker_state / "calls.jsonl").read_text() == calls_before
        assert marker.read_text().strip() == tree_a
        resume()
        stdout, stderr = scheduled.communicate(timeout=10)
        assert scheduled.returncode == 0, stdout + stderr
    assert marker.read_text().strip() == (docker_state / "running-tree").read_text() == tree_b


def test_external_git_change_during_build_cannot_be_certified_as_deployed(tmp_path):
    project, env, producer, docker_state = setup_concurrent_deploy(tmp_path)
    marker = project / "data/storage/.easyadb-last-deployed-tree"
    marker.parent.mkdir(parents=True)
    tree_a = shell("git", "rev-parse", "HEAD^{tree}", cwd=project).stdout.strip()
    marker.write_text(tree_a + "\n")
    with paused_deployment(project, env, "build-with-mihomo.sh", "--no-proxy") as (manual, resume):
        tree_b = publish_change(producer, "external Git change B")
        # An operator running plain Git does not participate in deployment
        # locking; the final identity check must fail closed in that case.
        shell("git", "pull", "--ff-only", "origin", V4_BRANCH, cwd=project)
        resume()
        stdout, stderr = manual.communicate(timeout=10)
        assert manual.returncode == 1, stdout + stderr
        assert "marker was not advanced" in stderr
    assert marker.read_text().strip() == tree_a
    assert (docker_state / "running-tree").read_text() == tree_a
    retried = invoke(project, env, "build-with-mihomo.sh", "--no-proxy", "--if-changed")
    assert retried.returncode == 0, retried.stdout + retried.stderr
    assert marker.read_text().strip() == (docker_state / "running-tree").read_text() == tree_b
