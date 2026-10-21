"""Deployment mode contracts through the real M3 bridge (fake Docker only)."""
from pathlib import Path

from deploy_migration_fixture import TARGET, assert_preserved, invoke, setup_migration

ROOT = Path(__file__).resolve().parents[1]
DIRECT_COMPOSE = ROOT / "compose.no-proxy.yaml"
PROXY_COMPOSE = ROOT / "compose.yaml"


def test_no_proxy_mode_survives_auto_update_and_skips_mihomo(tmp_path):
    fixture = setup_migration(tmp_path, start="bridge")
    result = invoke(fixture, "build-with-mihomo.sh", "--no-proxy")
    assert result.returncode == 0, result.stdout + result.stderr
    calls = fixture.log.read_text().splitlines()
    assert calls == [
        "compose version",
        "build --progress=plain --tag easyadb:local .",
        "compose -f compose.webrtc.yaml up -d --no-build",
    ]
    assert not any("mihomo" in call or "proxy-net" in call for call in calls)
    assert "without a scripted proxy" in result.stdout
    assert_preserved(fixture)


def test_inherited_updated_flag_still_migrates_before_no_proxy_deploy(tmp_path):
    fixture = setup_migration(tmp_path, start="bridge")
    fixture.env["EASYADB_UPDATED"] = "1"
    result = invoke(fixture, "build-with-mihomo.sh", "--no-proxy")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "pull --ff-only origin " + TARGET in fixture.git_log.read_text().splitlines()
    assert fixture.log.read_text().splitlines()[-1] == "compose -f compose.webrtc.yaml up -d --no-build"
    assert_preserved(fixture)


def test_unsupported_options_and_help_never_touch_git_or_docker(tmp_path):
    fixture = setup_migration(tmp_path, start="bridge")
    for args in (("--no-proxy", "--unexpected"), ("--no-proxy", "--no-proxy"),
                 ("--if-changed", "--if-changed")):
        invalid = invoke(fixture, "build-with-mihomo.sh", *args)
        assert invalid.returncode == 2
        assert not fixture.git_log.exists() and not fixture.log.exists()
    help_result = invoke(fixture, "build-with-mihomo.sh", "--help")
    assert help_result.returncode == 0
    assert "--no-proxy" in help_result.stdout and "--if-changed" in help_result.stdout
    assert not fixture.git_log.exists() and not fixture.log.exists()


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



def test_default_mode_reaches_v4_mihomo_builder_without_direct_flag(tmp_path):
    fixture = setup_migration(tmp_path, start="bridge")
    result = invoke(fixture)
    assert result.returncode == 0, result.stdout + result.stderr
    calls = fixture.log.read_text().splitlines()
    assert "network inspect proxy-net" in calls
    assert "buildx version" in calls
    assert "image inspect moby/buildkit:buildx-stable-1" in calls
    assert any(call.startswith("buildx create --name easyadb-proxy ") for call in calls)
    assert any(call.startswith("buildx build --builder easyadb-proxy ") for call in calls)
    assert calls[-1] == "compose -f compose.webrtc.yaml up -d --no-build"
    assert not any("compose.no-proxy.yaml" in call for call in calls)
    assert_preserved(fixture)
