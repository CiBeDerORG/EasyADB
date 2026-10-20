"""Scheduled deployment + changed-Git-tree integration tests (no Docker daemon/cron)."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def shell(*args, cwd, env=None, check=True):
    return subprocess.run(args, cwd=cwd, env=env, text=True,
                          capture_output=True, check=check)


def setup_project(tmp_path):
    project = tmp_path / "EasyADB"
    scripts = project / "scripts"
    scripts.mkdir(parents=True)
    for name in ("scheduled-deploy.sh", "build-with-mihomo.sh", "update-m2.sh"):
        shutil.copyfile(ROOT / "scripts" / name, scripts / name)
    shutil.copyfile(ROOT / ".gitignore", project / ".gitignore")
    shutil.copyfile(ROOT / "compose.no-proxy.yaml", project / "compose.no-proxy.yaml")
    (project / "README.md").write_text("initial\n")
    shell("git", "init", "-b", "feat/m3-openwrt-discovery", cwd=project)
    shell("git", "config", "user.email", "fixture@example.invalid", cwd=project)
    shell("git", "config", "user.name", "Fixture", cwd=project)
    shell("git", "add", ".", cwd=project)
    shell("git", "commit", "-m", "initial", cwd=project)
    remote = tmp_path / "remote.git"
    shell("git", "init", "--bare", str(remote), cwd=tmp_path)
    shell("git", "remote", "add", "origin", str(remote), cwd=project)
    shell("git", "push", "-u", "origin", "feat/m3-openwrt-discovery", cwd=project)
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
 "compose version"|"build --progress=plain --tag easyadb:local ."|"compose -f compose.no-proxy.yaml up -d --no-build")
   exit 0 ;;
esac
exit 74
''')
    docker.chmod(0o755)
    env = os.environ.copy()
    env.pop("EASYADB_UPDATED", None)
    env.pop("EASYADB_SOURCE_BRANCH", None)
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
    assert "feat/m3-openwrt-discovery" in status.stdout and "direct" in status.stdout

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
    assert entries[0] == f"feat/m3-openwrt-discovery|{os.getuid()}|--if-changed --no-proxy"
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


def test_changed_tree_skips_rebuild_then_deploys_and_retries_failure(tmp_path):
    project, env, remote = setup_project(tmp_path)
    producer = tmp_path / "producer"
    shell("git", "clone", str(remote), str(producer), cwd=tmp_path)
    shell("git", "checkout", "feat/m3-openwrt-discovery", cwd=producer)
    shell("git", "config", "user.email", "fixture@example.invalid", cwd=producer)
    shell("git", "config", "user.name", "Fixture", cwd=producer)
    env["EASYADB_SOURCE_BRANCH"] = "feat/m3-openwrt-discovery"

    def remote_change(value):
        (producer / "README.md").write_text(value + "\n")
        shell("git", "add", "README.md", cwd=producer)
        shell("git", "commit", "-m", value, cwd=producer)
        shell("git", "push", "origin", "feat/m3-openwrt-discovery", cwd=producer)

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
                     "compose -f compose.no-proxy.yaml up -d --no-build"]
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


@pytest.mark.parametrize("branch", (
    "feat/m2-web-control",
    "feat/display-mode-lab",
    "feat/m3-openwrt-discovery",
    "refactor/foundation-v1",
    "refactor/session-v2",
    "refactor/v2-session-governance",
))
def test_scheduler_start_read_config_and_due_run_agree_on_allowed_branch(tmp_path, branch):
    project, env, _ = setup_project(tmp_path)
    env["EASYADB_SOURCE_BRANCH"] = branch
    started = invoke(project, env, "scheduled-deploy.sh", "start", "15m", "--no-proxy")
    assert started.returncode == 0, started.stdout + started.stderr
    status = invoke(project, env, "scheduled-deploy.sh", "status")
    assert f"Branch: {branch}" in status.stdout
    config = (project / "data/storage/.easyadb-schedule").read_text().splitlines()
    assert config == ["15", "direct", str(os.getuid()), branch]

    # Force a scheduled tick, with a fake builder (no Git/Docker deployment).
    (project / "scripts/build-with-mihomo.sh").write_text(
        '#!/bin/sh\nprintf "%s|%s\\n" "$EASYADB_SOURCE_BRANCH" "$*" >> "$EASYADB_TEST_LOG"\n'
    )
    (project / "data/storage/.easyadb-schedule-last-check").write_text("0\n")
    due = invoke(project, env, "scheduled-deploy.sh", "run-locked")
    assert due.returncode == 0, due.stdout + due.stderr
    assert (tmp_path / "docker.log").read_text().splitlines() == [
        f"{branch}|--if-changed --no-proxy"
    ]


@pytest.mark.parametrize("branch", ("feat/m4-screen-mapping-m1", "experimental/unknown"))
def test_scheduler_rejects_m4_and_unknown_branch_without_cron_mutation(tmp_path, branch):
    project, env, _ = setup_project(tmp_path)
    env["EASYADB_SOURCE_BRANCH"] = branch
    rejected = invoke(project, env, "scheduled-deploy.sh", "start", "15m")
    assert rejected.returncode == 2
    assert "unsupported scheduled branch" in rejected.stderr
    assert not (tmp_path / "cron.txt").exists()
    assert not (project / "data/storage/.easyadb-schedule").exists()


def test_scheduler_rejects_invalid_persisted_branch_before_running_builder(tmp_path):
    project, env, _ = setup_project(tmp_path)
    started = invoke(project, env, "scheduled-deploy.sh", "start", "15m", "--no-proxy")
    assert started.returncode == 0, started.stdout + started.stderr
    config_path = project / "data/storage/.easyadb-schedule"
    config = config_path.read_text().splitlines()
    config[3] = "feat/m4-screen-mapping-m1"
    config_path.write_text("\n".join(config) + "\n")
    rejected = invoke(project, env, "scheduled-deploy.sh", "run-locked")
    assert rejected.returncode == 1
    assert "invalid scheduled deployment state" in rejected.stderr
    assert not (tmp_path / "docker.log").exists()
