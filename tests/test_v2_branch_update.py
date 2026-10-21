"""Real local-Git deployment migration, with no network or Docker daemon."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]
V4_BRANCH = "refactor/v4-frontend-standards"
M3_BRANCH = "feat/m3-openwrt-discovery"


def git(cwd, *args, env=None, ok=True):
    return subprocess.run(["git", *args], cwd=cwd, env=env, text=True,
                          capture_output=True, check=ok)


def setup_project(tmp_path, branch=V4_BRANCH):
    project = tmp_path / "project"
    project.mkdir()
    (project / "scripts").mkdir()
    shutil.copyfile(ROOT / "scripts/update-m2.sh", project / "scripts/update-m2.sh")
    shutil.copyfile(ROOT / ".gitignore", project / ".gitignore")
    (project / "README.md").write_text("common deployment baseline\n")
    git(project, "init", "-b", branch)
    git(project, "config", "user.email", "test@example.invalid")
    git(project, "config", "user.name", "Test")
    git(project, "add", ".")
    git(project, "commit", "-m", "fixture")
    remote = tmp_path / "remote.git"
    git(tmp_path, "init", "--bare", str(remote))
    git(project, "remote", "add", "origin", str(remote))
    git(project, "push", "-u", "origin", branch)
    env = os.environ.copy()
    env.pop("EASYADB_SOURCE_BRANCH", None)
    env.pop("SUDO_UID", None)
    return project, env, remote


def update(project, env):
    return subprocess.run(["sh", "scripts/update-m2.sh"], cwd=project, env=env,
                          text=True, capture_output=True)


def commit_readme(project, value):
    (project / "README.md").write_text(value + "\n")
    git(project, "add", "README.md")
    git(project, "commit", "-m", value)
    return git(project, "rev-parse", "HEAD").stdout.strip()


def setup_diverged_m3_and_v4(tmp_path, local_v4=True):
    project, env, remote = setup_project(tmp_path, M3_BRANCH)
    base = git(project, "rev-parse", "HEAD").stdout.strip()
    m3_head = commit_readme(project, "M3-only history")
    git(project, "push", "origin", M3_BRANCH)
    git(project, "switch", "-c", V4_BRANCH, base)
    v4_head = commit_readme(project, "V4-only history")
    git(project, "push", "-u", "origin", V4_BRANCH)
    git(project, "switch", M3_BRANCH)
    # The migration must switch branches; pulling V4 into M3 cannot fast-forward.
    assert git(project, "merge-base", "--is-ancestor", m3_head, v4_head, ok=False).returncode == 1
    assert git(project, "merge-base", "--is-ancestor", v4_head, m3_head, ok=False).returncode == 1
    if not local_v4:
        git(project, "branch", "-D", V4_BRANCH)
    return project, env, remote, m3_head, v4_head


def test_v2_update_keeps_branch_and_rejects_unknown_checkout(tmp_path):
    project, env, _ = setup_project(tmp_path, "refactor/v2-session-governance")
    preserved = update(project, env)
    assert preserved.returncode == 0, preserved.stdout + preserved.stderr
    assert "Source ready: refactor/v2-session-governance" in preserved.stdout
    assert git(project, "branch", "--show-current").stdout.strip() == "refactor/v2-session-governance"

    git(project, "switch", "-c", "unknown/experiment")
    rejected = update(project, env)
    assert rejected.returncode == 2
    assert "refusing implicit checkout switch" in rejected.stderr
    assert git(project, "branch", "--show-current").stdout.strip() == "unknown/experiment"

    env["EASYADB_SOURCE_BRANCH"] = "feat/m4-screen-mapping-m1"
    explicit = update(project, env)
    assert explicit.returncode == 2
    assert git(project, "branch", "--show-current").stdout.strip() == "unknown/experiment"


@pytest.mark.parametrize("branch", (
    "feat/display-mode-lab", "feat/m2-web-control",
    "refactor/foundation-v1", "refactor/session-v2",
))
def test_other_explicitly_allowed_current_branches_stay_selected(tmp_path, branch):
    project, env, _ = setup_project(tmp_path, branch)
    preserved = update(project, env)
    assert preserved.returncode == 0, preserved.stdout + preserved.stderr
    assert git(project, "branch", "--show-current").stdout.strip() == branch


@pytest.mark.parametrize("explicit", (False, True))
def test_v4_current_or_explicit_source_fetches_and_fast_forwards(tmp_path, explicit):
    project, env, remote = setup_project(tmp_path)
    producer = tmp_path / "producer"
    git(tmp_path, "clone", "--branch", V4_BRANCH, str(remote), str(producer))
    git(producer, "config", "user.email", "fixture@example.invalid")
    git(producer, "config", "user.name", "Fixture")
    upstream = commit_readme(producer, "V4 upstream update")
    git(producer, "push", "origin", V4_BRANCH)
    if explicit:
        env["EASYADB_SOURCE_BRANCH"] = V4_BRANCH
    result = update(project, env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert f"Source ready: {V4_BRANCH}" in result.stdout
    assert git(project, "branch", "--show-current").stdout.strip() == V4_BRANCH
    assert git(project, "rev-parse", "HEAD").stdout.strip() == upstream
    assert (project / "README.md").read_text() == "V4 upstream update\n"


@pytest.mark.parametrize("source", (None, M3_BRANCH, V4_BRANCH))
@pytest.mark.parametrize("local_v4", (False, True))
def test_m3_migration_switches_diverged_history_without_merging_or_resetting(
        tmp_path, source, local_v4):
    project, env, _, m3_head, v4_head = setup_diverged_m3_and_v4(tmp_path, local_v4)
    # Match an old --single-branch M3 clone: an ordinary `fetch origin` cannot
    # discover V4, so the updater must fetch its selected remote ref explicitly.
    git(project, "config", "remote.origin.fetch",
        f"+refs/heads/{M3_BRANCH}:refs/remotes/origin/{M3_BRANCH}")
    git(project, "update-ref", "-d", f"refs/remotes/origin/{V4_BRANCH}")
    if source is not None:
        env["EASYADB_SOURCE_BRANCH"] = source
    (project / ".env").write_text("EASYADB_TOKEN=fixture-only-not-a-real-token\n")
    storage = project / "data/storage"
    storage.mkdir(parents=True)
    (storage / "fixture.sqlite3").write_bytes(b"retained fixture data")
    result = update(project, env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert git(project, "branch", "--show-current").stdout.strip() == V4_BRANCH
    assert git(project, "rev-parse", "HEAD").stdout.strip() == v4_head
    assert git(project, "rev-parse", M3_BRANCH).stdout.strip() == m3_head
    assert (project / "README.md").read_text() == "V4-only history\n"
    assert (project / ".env").read_text() == "EASYADB_TOKEN=fixture-only-not-a-real-token\n"
    assert (storage / "fixture.sqlite3").read_bytes() == b"retained fixture data"
    assert git(project, "status", "--porcelain").stdout == ""
    assert git(project, "config", "--get-all", "remote.origin.fetch").stdout.strip() == (
        f"+refs/heads/{M3_BRANCH}:refs/remotes/origin/{M3_BRANCH}"
    )


@pytest.mark.parametrize("empty_override", (False, True))
def test_detached_head_with_empty_source_defaults_to_v4(tmp_path, empty_override):
    project, env, _, m3_head, v4_head = setup_diverged_m3_and_v4(tmp_path)
    git(project, "checkout", "--detach", m3_head)
    if empty_override:
        env["EASYADB_SOURCE_BRANCH"] = ""
    result = update(project, env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert git(project, "branch", "--show-current").stdout.strip() == V4_BRANCH
    assert git(project, "rev-parse", "HEAD").stdout.strip() == v4_head
    assert git(project, "rev-parse", M3_BRANCH).stdout.strip() == m3_head


@pytest.mark.parametrize("dirty_file", ("README.md", "untracked-note.txt"))
def test_m3_migration_refuses_dirty_worktree_without_discarding_changes(tmp_path, dirty_file):
    project, env, _, m3_head, v4_head = setup_diverged_m3_and_v4(tmp_path)
    (project / dirty_file).write_text("local work must survive\n")
    before = git(project, "status", "--porcelain").stdout
    result = update(project, env)
    assert result.returncode == 1
    assert "local Git changes or untracked files" in result.stderr
    assert git(project, "branch", "--show-current").stdout.strip() == M3_BRANCH
    assert git(project, "rev-parse", "HEAD").stdout.strip() == m3_head
    assert git(project, "rev-parse", V4_BRANCH).stdout.strip() == v4_head
    assert git(project, "status", "--porcelain").stdout == before
    assert (project / dirty_file).read_text() == "local work must survive\n"


@pytest.mark.parametrize("branch", ("feat/m4-screen-mapping-m1", "experimental/unknown"))
@pytest.mark.parametrize("explicit", (False, True))
def test_m4_and_unknown_sources_remain_rejected(tmp_path, branch, explicit):
    project, env, _ = setup_project(tmp_path)
    if explicit:
        env["EASYADB_SOURCE_BRANCH"] = branch
    else:
        git(project, "switch", "-c", branch)
    before_branch = git(project, "branch", "--show-current").stdout
    before_head = git(project, "rev-parse", "HEAD").stdout
    result = update(project, env)
    assert result.returncode == 2
    assert "refusing implicit checkout switch" in result.stderr
    assert git(project, "branch", "--show-current").stdout == before_branch
    assert git(project, "rev-parse", "HEAD").stdout == before_head


def test_m3_migration_without_remote_v4_stops_before_switching(tmp_path):
    project, env, _ = setup_project(tmp_path, M3_BRANCH)
    before_head = git(project, "rev-parse", "HEAD").stdout
    result = update(project, env)
    assert result.returncode != 0
    assert V4_BRANCH in result.stdout + result.stderr
    assert git(project, "branch", "--show-current").stdout.strip() == M3_BRANCH
    assert git(project, "rev-parse", "HEAD").stdout == before_head


def test_diverged_v4_update_refuses_merge_or_reset_and_preserves_local_commit(tmp_path):
    project, env, remote = setup_project(tmp_path)
    producer = tmp_path / "producer"
    git(tmp_path, "clone", "--branch", V4_BRANCH, str(remote), str(producer))
    git(producer, "config", "user.email", "fixture@example.invalid")
    git(producer, "config", "user.name", "Fixture")
    local_head = commit_readme(project, "local V4-only commit")
    remote_head = commit_readme(producer, "remote V4-only commit")
    git(producer, "push", "origin", V4_BRANCH)
    result = update(project, env)
    assert result.returncode != 0
    assert git(project, "branch", "--show-current").stdout.strip() == V4_BRANCH
    assert git(project, "rev-parse", "HEAD").stdout.strip() == local_head
    assert git(project, "rev-parse", f"origin/{V4_BRANCH}").stdout.strip() == remote_head
    assert (project / "README.md").read_text() == "local V4-only commit\n"
    assert git(project, "status", "--porcelain").stdout == ""
    assert not (project / ".git/MERGE_HEAD").exists()
