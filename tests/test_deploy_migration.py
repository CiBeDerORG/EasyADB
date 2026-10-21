"""Actual old M3 -> bridge -> V4 updates, using local Git and fake Docker."""
import pytest

from deploy_migration_fixture import (
    FIXTURES, LEGACY, TARGET, assert_preserved, git, invoke, setup_migration,
)


@pytest.mark.parametrize("args", ((), ("--no-proxy",), ("--if-changed",),
                                  ("--if-changed", "--no-proxy")))
def test_original_m3_command_crosses_both_updates_before_docker(tmp_path, args):
    fixture = setup_migration(tmp_path)
    assert git(fixture.project, fixture.env, "rev-parse", "HEAD").stdout.strip() == fixture.legacy_head
    # These are genuinely divergent Git histories, not an in-place file swap.
    assert git(fixture.producer, fixture.env, "merge-base", fixture.bridge_head,
               fixture.target_head).stdout.strip() == fixture.legacy_head
    result = invoke(fixture, "build-with-mihomo.sh", *args)
    assert result.returncode == 0, result.stdout + result.stderr
    assert git(fixture.project, fixture.env, "symbolic-ref", "--short", "HEAD").stdout.strip() == TARGET
    assert git(fixture.project, fixture.env, "rev-parse", "HEAD").stdout.strip() == fixture.target_head
    assert git(fixture.project, fixture.env, "rev-parse", LEGACY).stdout.strip() == fixture.bridge_head
    operations = fixture.git_log.read_text().splitlines()
    assert [line for line in operations if line.startswith("pull ")] == [
        "pull --ff-only origin " + LEGACY,
        "pull --ff-only origin " + TARGET,
    ]
    assert [line for line in operations if line.startswith("fetch ")] == [
        "fetch origin",
        "fetch origin refs/heads/" + TARGET + ":refs/remotes/origin/" + TARGET,
    ]
    assert "switch --no-track -c " + TARGET + " origin/" + TARGET in operations
    calls = fixture.log.read_text().splitlines()
    builds = [call for call in calls if call.startswith(("build ", "buildx build "))]
    assert len(builds) == 1
    assert builds[0].startswith("build " if "--no-proxy" in args else "buildx build ")
    assert calls[-1] == "compose -f compose.webrtc.yaml up -d --no-build"
    assert "compose -f compose.no-proxy.yaml up -d --no-build" not in calls
    marker = fixture.project / "data/storage/.easyadb-last-deployed-tree"
    assert marker.read_text().strip() == git(fixture.project, fixture.env, "rev-parse", "HEAD^{tree}").stdout.strip()
    assert_preserved(fixture)


def test_original_m3_old_mse_config_reaches_v4_validation_without_docker(tmp_path):
    fixture = setup_migration(tmp_path, video_engine="mse")
    result = invoke(fixture, "build-with-mihomo.sh", "--if-changed", "--no-proxy")
    assert result.returncode == 2, result.stdout + result.stderr
    assert "FFmpeg + MSE was removed" in result.stderr
    assert git(fixture.project, fixture.env, "rev-parse", "HEAD").stdout.strip() == fixture.target_head
    assert not fixture.log.exists()
    marker = fixture.project / "data/storage/.easyadb-last-deployed-tree"
    assert marker.read_text().strip() == git(fixture.project, fixture.env, "rev-parse", fixture.legacy_head + "^{tree}").stdout.strip()
    assert_preserved(fixture)


@pytest.mark.parametrize("source", (LEGACY, "feat/m2-web-control", "feat/display-mode-lab", TARGET))
def test_bridge_accepts_old_source_names_but_fetches_only_v4(tmp_path, source):
    fixture = setup_migration(tmp_path, start="bridge")
    fixture.env["EASYADB_SOURCE_BRANCH"] = source
    result = invoke(fixture, "update-m2.sh")
    assert result.returncode == 0, result.stdout + result.stderr
    operations = fixture.git_log.read_text().splitlines()
    assert [line for line in operations if line.startswith("fetch ")] == [
        "fetch origin refs/heads/" + TARGET + ":refs/remotes/origin/" + TARGET]
    assert [line for line in operations if line.startswith("pull ")] == ["pull --ff-only origin " + TARGET]
    assert git(fixture.project, fixture.env, "rev-parse", "HEAD").stdout.strip() == fixture.target_head
    assert not fixture.log.exists()
    assert_preserved(fixture)


@pytest.mark.parametrize("source", ("feat/m4-device-screen-settings", "unknown-branch"))
def test_bridge_rejects_unknown_sources_before_fetch(tmp_path, source):
    fixture = setup_migration(tmp_path, start="bridge")
    fixture.env["EASYADB_SOURCE_BRANCH"] = source
    result = invoke(fixture, "build-with-mihomo.sh", "--no-proxy")
    assert result.returncode == 2 and "unsupported source branch" in result.stderr
    assert not any(line.startswith(("fetch ", "pull ", "switch "))
                   for line in fixture.git_log.read_text().splitlines())
    assert git(fixture.project, fixture.env, "rev-parse", "HEAD").stdout.strip() == fixture.bridge_head
    assert not fixture.log.exists()
    assert_preserved(fixture)


@pytest.mark.parametrize("dirty", ("tracked", "untracked"))
def test_bridge_dirty_tree_is_untouched_and_never_deployed(tmp_path, dirty):
    fixture = setup_migration(tmp_path, start="bridge")
    changed = fixture.project / ("README.md" if dirty == "tracked" else "untracked.txt")
    changed.write_text("keep my local work\n")
    before = git(fixture.project, fixture.env, "status", "--porcelain").stdout
    result = invoke(fixture, "build-with-mihomo.sh", "--no-proxy")
    assert result.returncode == 1 and "refusing to switch or pull" in result.stderr
    assert git(fixture.project, fixture.env, "status", "--porcelain").stdout == before
    assert changed.read_text() == "keep my local work\n"
    assert git(fixture.project, fixture.env, "rev-parse", "HEAD").stdout.strip() == fixture.bridge_head
    assert not fixture.log.exists()
    assert not any(line.startswith("fetch ") for line in fixture.git_log.read_text().splitlines())


def test_bridge_missing_v4_remote_does_not_deploy_old_m3(tmp_path):
    fixture = setup_migration(tmp_path, start="bridge")
    git(fixture.producer, fixture.env, "push", "origin", "--delete", TARGET)
    result = invoke(fixture, "build-with-mihomo.sh", "--no-proxy")
    assert result.returncode != 0, result.stdout + result.stderr
    assert git(fixture.project, fixture.env, "rev-parse", "HEAD").stdout.strip() == fixture.bridge_head
    assert not fixture.log.exists()
    assert_preserved(fixture)


def test_bridge_existing_divergent_v4_is_not_reset_or_merged(tmp_path):
    fixture = setup_migration(tmp_path, start="bridge")
    git(fixture.project, fixture.env, "switch", "-c", TARGET)
    (fixture.project / "local-only.txt").write_text("keep this commit\n")
    git(fixture.project, fixture.env, "add", ".")
    git(fixture.project, fixture.env, "commit", "-m", "local V4 divergence")
    local = git(fixture.project, fixture.env, "rev-parse", "HEAD").stdout.strip()
    git(fixture.project, fixture.env, "switch", LEGACY)
    result = invoke(fixture, "build-with-mihomo.sh", "--no-proxy")
    assert result.returncode != 0 and "fast-forward" in result.stderr
    assert git(fixture.project, fixture.env, "rev-parse", "HEAD").stdout.strip() == local
    assert (fixture.project / "local-only.txt").read_text() == "keep this commit\n"
    assert not fixture.log.exists()
    assert_preserved(fixture)


def test_v4_snapshot_keeps_the_production_handoff_protocol():
    # Keep fixtures tied to the real V4 contract, not a permissive success stub.
    builder = (FIXTURES / "v4/build-with-mihomo.sh").read_text()
    updater = (FIXTURES / "v4/update-m2.sh").read_text()
    assert 'if [ "${EASYADB_UPDATED:-0}" != 1 ]; then' in builder
    assert 'exec sh scripts/build-with-mihomo.sh "$@"' in builder
    assert "FFmpeg + MSE was removed" in builder
    assert builder.index("FFmpeg + MSE was removed") < builder.index("sh scripts/update-m2.sh")
    assert "docker compose -f compose.webrtc.yaml up -d --no-build" in builder
    assert "docker compose -f compose.no-proxy.yaml up" not in builder
    assert 'git_as_owner pull --ff-only origin "$TARGET_BRANCH"' in updater
    assert 'git_as_owner switch --no-track -c "$TARGET_BRANCH"' in updater
