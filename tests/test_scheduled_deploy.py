"""Scheduled bridge and changed-tree contracts (no Docker daemon or real cron)."""
import os
import shutil

import pytest

from deploy_migration_fixture import (
    LEGACY, TARGET, assert_preserved, git, invoke, remote_change, setup_migration,
)


def test_cron_start_status_no_early_run_due_run_and_stop(tmp_path):
    if not shutil.which("flock"):
        pytest.skip("flock not available")
    fixture = setup_migration(tmp_path, start="bridge")
    project = fixture.project
    cron = tmp_path / "cron.txt"
    cron.write_text("@reboot echo unrelated\n")
    result = invoke(fixture, "scheduled-deploy.sh", "start", "15m", "--no-proxy")
    assert result.returncode == 0, result.stderr
    lines = cron.read_text().splitlines()
    assert len(lines) == 2 and lines[0] == "@reboot echo unrelated"
    assert "EASYADB_SCHEDULED_DEPLOY:" in lines[1]
    assert "scripts/scheduled-deploy.sh' run" in lines[1]
    status = invoke(fixture, "scheduled-deploy.sh", "status")
    assert "enabled" in status.stdout and "15 minute(s)" in status.stdout
    assert TARGET in status.stdout and "direct" in status.stdout

    # Use a stub deployment to confirm cron passes the selected mode and branch.
    (project / "scripts/build-with-mihomo.sh").write_text('''#!/bin/sh
printf '%s|%s|%s\\n' "$EASYADB_SOURCE_BRANCH" "$SUDO_UID" "$*" >> "$EASYADB_TEST_LOG"
''')
    first = invoke(fixture, "scheduled-deploy.sh", "run")
    assert first.returncode == 0 and not (tmp_path / "docker.log").exists()
    state = project / "data/storage/.easyadb-schedule-last-check"
    state.write_text("0\n")
    due = invoke(fixture, "scheduled-deploy.sh", "run")
    assert due.returncode == 0, due.stderr
    entries = (tmp_path / "docker.log").read_text().splitlines()
    assert len(entries) == 1
    assert entries[0] == f"{TARGET}|{os.getuid()}|--if-changed --no-proxy"
    invoke(fixture, "scheduled-deploy.sh", "run")
    assert (tmp_path / "docker.log").read_text().splitlines() == entries
    assert "Last result:" in invoke(fixture, "scheduled-deploy.sh", "status").stdout
    stop = invoke(fixture, "scheduled-deploy.sh", "stop")
    assert stop.returncode == 0
    assert cron.read_text().strip() == "@reboot echo unrelated"
    assert "disabled" in invoke(fixture, "scheduled-deploy.sh", "status").stdout


@pytest.mark.parametrize("interval", ("0m", "45x", "10081m", "8d", "m", "0h"))
def test_invalid_interval_never_modifies_crontab(tmp_path, interval):
    fixture = setup_migration(tmp_path, start="bridge")
    result = invoke(fixture, "scheduled-deploy.sh", "start", interval)
    assert result.returncode == 2
    assert not (tmp_path / "cron.txt").exists()


def test_changed_tree_skips_rebuild_then_deploys_and_retries_failure(tmp_path):
    fixture = setup_migration(tmp_path, start="bridge")
    fixture.env["EASYADB_SOURCE_BRANCH"] = LEGACY
    marker = fixture.project / "data/storage/.easyadb-last-deployed-tree"
    # A known successful V4 deployment already matches the fetched target tree.
    # Migration must retain that marker and allow V4's unchanged-tree shortcut.
    marker.write_text(git(fixture.producer, fixture.env, "rev-parse", TARGET + "^{tree}").stdout)
    build_args = ("build-with-mihomo.sh", "--if-changed", "--no-proxy")
    initial = invoke(fixture, *build_args)
    assert initial.returncode == 0, initial.stderr
    assert "skipping Docker" in initial.stdout
    before = marker.read_text().strip()
    assert not fixture.log.exists()
    remote_change(fixture, "update one")
    updated = invoke(fixture, *build_args)
    assert updated.returncode == 0, updated.stdout + updated.stderr
    after = marker.read_text().strip()
    assert after != before
    calls = fixture.log.read_text().splitlines()
    assert calls == ["compose version", "build --progress=plain --tag easyadb:local .",
                     "compose -f compose.webrtc.yaml up -d --no-build"]
    unchanged = invoke(fixture, *build_args)
    assert unchanged.returncode == 0 and "skipping Docker" in unchanged.stdout
    assert fixture.log.read_text().splitlines() == calls

    remote_change(fixture, "update two")
    fixture.env["EASYADB_DOCKER_FAIL"] = "1"
    failed = invoke(fixture, *build_args)
    assert failed.returncode == 42, failed.stdout + failed.stderr
    assert marker.read_text().strip() == after, "failed build never advances deployment marker"
    fixture.env.pop("EASYADB_DOCKER_FAIL")
    retried = invoke(fixture, *build_args)
    assert retried.returncode == 0, retried.stdout + retried.stderr
    assert marker.read_text().strip() != after
    assert fixture.log.read_text().count("build --progress=plain") == 3
    assert_preserved(fixture)


@pytest.mark.parametrize("source", (LEGACY, "feat/m2-web-control", "feat/display-mode-lab", TARGET))
def test_scheduler_saves_only_the_canonical_v4_target(tmp_path, source):
    fixture = setup_migration(tmp_path, start="bridge")
    fixture.env["EASYADB_SOURCE_BRANCH"] = source
    result = invoke(fixture, "scheduled-deploy.sh", "start", "2h")
    assert result.returncode == 0, result.stdout + result.stderr
    state = fixture.project / "data/storage/.easyadb-schedule"
    assert state.read_text().splitlines() == ["120", "proxy", str(os.getuid()), TARGET]
    assert not fixture.log.exists()


@pytest.mark.parametrize("source", ("feat/m4-device-screen-settings", "unknown-branch"))
def test_scheduler_rejects_unsupported_source_without_changing_cron(tmp_path, source):
    fixture = setup_migration(tmp_path, start="bridge")
    fixture.env["EASYADB_SOURCE_BRANCH"] = source
    fixture.cron.write_text("@reboot echo unrelated\n")
    result = invoke(fixture, "scheduled-deploy.sh", "start", "15m")
    assert result.returncode == 2
    assert fixture.cron.read_text() == "@reboot echo unrelated\n"
    assert not (fixture.project / "data/storage/.easyadb-schedule").exists()
    assert not fixture.log.exists()


@pytest.mark.parametrize("source", (LEGACY, "feat/m2-web-control", "feat/display-mode-lab"))
def test_saved_alias_is_rewritten_only_when_due_and_second_tick_stays_v4(tmp_path, source):
    fixture = setup_migration(tmp_path, start="bridge")
    result = invoke(fixture, "scheduled-deploy.sh", "start", "15m", "--no-proxy")
    assert result.returncode == 0, result.stderr
    state = fixture.project / "data/storage/.easyadb-schedule"
    previous = ["15", "direct", str(os.getuid()), source]
    state.write_text("\n".join(previous) + "\n")
    status = invoke(fixture, "scheduled-deploy.sh", "status")
    assert "Branch: " + TARGET in status.stdout
    assert state.read_text().splitlines() == previous, "status must stay read-only"
    early = invoke(fixture, "scheduled-deploy.sh", "run")
    assert early.returncode == 0 and not fixture.log.exists()
    assert state.read_text().splitlines() == previous, "not-due ticks must not rewrite state"
    last_check = fixture.project / "data/storage/.easyadb-schedule-last-check"
    last_check.write_text("0\n")
    due = invoke(fixture, "scheduled-deploy.sh", "run")
    assert due.returncode == 0, due.stdout + due.stderr
    assert state.read_text().splitlines() == previous[:3] + [TARGET]
    assert state.stat().st_mode & 0o777 == 0o600
    assert git(fixture.project, fixture.env, "rev-parse", "HEAD").stdout.strip() == fixture.target_head
    calls = fixture.log.read_text().splitlines()
    assert calls[-1] == "compose -f compose.webrtc.yaml up -d --no-build"
    last_check.write_text("0\n")
    second = invoke(fixture, "scheduled-deploy.sh", "run")
    assert second.returncode == 0, second.stdout + second.stderr
    assert "skipping Docker" in second.stdout
    assert fixture.log.read_text().splitlines() == calls
    pulls = [line for line in fixture.git_log.read_text().splitlines() if line.startswith("pull ")]
    assert pulls == ["pull --ff-only origin " + TARGET] * 2
    assert_preserved(fixture)


def test_original_m3_schedule_migrates_on_next_due_tick_and_does_not_return(tmp_path):
    fixture = setup_migration(tmp_path)
    result = invoke(fixture, "scheduled-deploy.sh", "start", "15m", "--no-proxy")
    assert result.returncode == 0, result.stderr
    state = fixture.project / "data/storage/.easyadb-schedule"
    assert state.read_text().splitlines()[-1] == LEGACY
    cron = fixture.cron.read_text()
    last_check = fixture.project / "data/storage/.easyadb-schedule-last-check"
    last_check.write_text("0\n")
    first = invoke(fixture, "scheduled-deploy.sh", "run")
    assert first.returncode == 0, first.stdout + first.stderr
    assert git(fixture.project, fixture.env, "rev-parse", "HEAD").stdout.strip() == fixture.target_head
    calls = fixture.log.read_text().splitlines()
    assert calls == ["compose version", "build --progress=plain --tag easyadb:local .",
                     "compose -f compose.webrtc.yaml up -d --no-build"]
    last_check.write_text("0\n")
    second = invoke(fixture, "scheduled-deploy.sh", "run")
    assert second.returncode == 0 and "skipping Docker" in second.stdout
    assert fixture.log.read_text().splitlines() == calls
    assert fixture.cron.read_text() == cron
    pulls = [line for line in fixture.git_log.read_text().splitlines() if line.startswith("pull ")]
    assert pulls == ["pull --ff-only origin " + LEGACY,
                     "pull --ff-only origin " + TARGET, "pull --ff-only origin " + TARGET]
    assert_preserved(fixture)
