"""Deployment mode smoke tests with a fake Docker executable (no daemon/network)."""
import os
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "build-with-mihomo.sh"
DIRECT_COMPOSE = ROOT / "compose.no-proxy.yaml"
PROXY_COMPOSE = ROOT / "compose.yaml"


def setup_fake_deploy(tmp_path):
    project = tmp_path / "EasyADB"
    scripts = project / "scripts"
    scripts.mkdir(parents=True)
    shutil.copyfile(SCRIPT, scripts / "build-with-mihomo.sh")
    shutil.copyfile(DIRECT_COMPOSE, project / "compose.no-proxy.yaml")
    # This deliberately invalid entry must NEVER be read in direct mode.
    (project / ".env").write_text("EASYADB_BUILD_PROXY=not-a-valid-Mihomo-URL\n")
    (scripts / "update-m1.sh").write_text(
        '#!/bin/sh\nprintf "update-m1\\n" >> "$EASYADB_TEST_LOG"\n'
    )
    bindir = tmp_path / "bin"
    bindir.mkdir()
    docker = bindir / "docker"
    docker.write_text("""#!/bin/sh
printf '%s\\n' "$*" >> "$EASYADB_TEST_LOG"
case "$*" in
  "compose version"|"build --progress=plain --tag easyadb:local ."|"compose -f compose.no-proxy.yaml up -d --no-build")
    exit 0 ;;
  *)
    echo "Unexpected Docker invocation" >&2
    exit 73 ;;
esac
""")
    docker.chmod(0o755)
    env = os.environ.copy()
    env.pop("EASYADB_UPDATED", None)
    env.update({
        "PATH": str(bindir) + os.pathsep + env.get("PATH", ""),
        "EASYADB_TEST_LOG": str(tmp_path / "calls.log"),
    })
    return project, env


def invoke(project, env, *args):
    return subprocess.run(
        ["sh", "scripts/build-with-mihomo.sh", *args],
        cwd=project, env=env, text=True, capture_output=True, check=False,
    )


def test_no_proxy_mode_survives_auto_update_and_skips_mihomo(tmp_path):
    project, env = setup_fake_deploy(tmp_path)
    result = invoke(project, env, "--no-proxy")
    assert result.returncode == 0, result.stdout + result.stderr
    calls = (tmp_path / "calls.log").read_text().splitlines()
    assert calls == [
        "update-m1",
        "compose version",
        "build --progress=plain --tag easyadb:local .",
        "compose -f compose.no-proxy.yaml up -d --no-build",
    ]
    assert not any("mihomo" in call or "proxy-net" in call for call in calls)
    assert "without a scripted proxy" in result.stdout


def test_no_proxy_direct_reentry_has_no_extra_update(tmp_path):
    project, env = setup_fake_deploy(tmp_path)
    env["EASYADB_UPDATED"] = "1"
    result = invoke(project, env, "--no-proxy")
    assert result.returncode == 0, result.stderr
    assert "update-m1" not in (tmp_path / "calls.log").read_text()


def test_unsupported_options_and_help_never_touch_git_or_docker(tmp_path):
    project, env = setup_fake_deploy(tmp_path)
    invalid = invoke(project, env, "--no-proxy", "--unexpected")
    assert invalid.returncode == 2
    assert not (tmp_path / "calls.log").exists()
    help_result = invoke(project, env, "--help")
    assert help_result.returncode == 0
    assert "--no-proxy" in help_result.stdout
    assert not (tmp_path / "calls.log").exists()


def test_direct_compose_is_standalone_and_preserves_persistent_paths():
    direct = DIRECT_COMPOSE.read_text()
    proxy = PROXY_COMPOSE.read_text()
    for shared in (
        "image: easyadb:local",
        "EASYADB_DB: /app/data/devices.sqlite3",
        "./data/adb:/root/.android",
        "./data/storage:/app/data",
        "EASYADB_BIND_IP",
        "EASYADB_PORT",
        "EASYADB_TOKEN",
    ):
        assert shared in direct and shared in proxy
    assert "proxy-net" not in "\n".join(
        line for line in direct.splitlines() if not line.lstrip().startswith("#")
    )
    assert "mihomo:" not in direct
    assert "EASYADB_BUILD_PROXY" not in direct
    assert "build:" not in "\n".join(
        line for line in direct.splitlines() if not line.lstrip().startswith("#")
    )
    assert "network_mode: host" not in direct
