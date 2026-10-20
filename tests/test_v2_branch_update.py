"""Small regression: auto-update must preserve a checked-out V2 branch."""
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def git(cwd, *args, env=None, ok=True):
    return subprocess.run(["git", *args], cwd=cwd, env=env, text=True,
                          capture_output=True, check=ok)


def test_v2_update_keeps_branch_and_rejects_unknown_checkout(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    (project / "scripts").mkdir()
    shutil.copyfile(ROOT / "scripts/update-m2.sh", project / "scripts/update-m2.sh")
    git(project, "init", "-b", "refactor/v2-session-governance")
    git(project, "config", "user.email", "test@example.invalid")
    git(project, "config", "user.name", "Test")
    git(project, "add", ".")
    git(project, "commit", "-m", "fixture")
    remote = tmp_path / "remote.git"
    git(tmp_path, "init", "--bare", str(remote))
    git(project, "remote", "add", "origin", str(remote))
    git(project, "push", "-u", "origin", "refactor/v2-session-governance")
    env = os.environ.copy()
    env.pop("EASYADB_SOURCE_BRANCH", None)
    env.pop("SUDO_UID", None)
    preserved = subprocess.run(["sh", "scripts/update-m2.sh"], cwd=project, env=env,
                               text=True, capture_output=True)
    assert preserved.returncode == 0, preserved.stdout + preserved.stderr
    assert "Source ready: refactor/v2-session-governance" in preserved.stdout
    assert git(project, "branch", "--show-current").stdout.strip() == "refactor/v2-session-governance"

    git(project, "switch", "-c", "unknown/experiment")
    rejected = subprocess.run(["sh", "scripts/update-m2.sh"], cwd=project, env=env,
                              text=True, capture_output=True)
    assert rejected.returncode == 2
    assert "refusing implicit checkout switch" in rejected.stderr
    assert git(project, "branch", "--show-current").stdout.strip() == "unknown/experiment"

    env["EASYADB_SOURCE_BRANCH"] = "feat/m4-screen-mapping-m1"
    explicit = subprocess.run(["sh", "scripts/update-m2.sh"], cwd=project, env=env,
                              text=True, capture_output=True)
    assert explicit.returncode == 2
    assert git(project, "branch", "--show-current").stdout.strip() == "unknown/experiment"
