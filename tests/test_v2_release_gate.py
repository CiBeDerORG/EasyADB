"""V2-F09 release gate: keep the tested WebRTC-only deployment contract visible.

This gate is run explicitly before the existing full pytest suite. In addition
to behavior tests, it ensures CI cannot quietly omit a critical regression
module, Node contract, shell syntax check or OpenWrt smoke test.

No device, daemon, NAS, Docker, Git remote or network access is performed.
"""
import ast
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "test.yml"

# Each behavior here already has an executable test; these anchors ensure a
# future refactor cannot remove whole critical suites yet leave CI green.
CRITICAL_PYTHON = {
    "test_v2_branch_update.py": (
        "test_v2_update_keeps_branch_and_rejects_unknown_checkout",
    ),
    "test_scheduled_deploy.py": (
        "test_scheduler_start_read_config_and_due_run_agree_on_allowed_branch",
        "test_scheduler_rejects_m4_and_unknown_branch_without_cron_mutation",
        "test_scheduler_rejects_invalid_persisted_branch_before_running_builder",
        "test_changed_tree_skips_rebuild_then_deploys_and_retries_failure",
    ),
    "test_deploy_modes.py": (
        "test_default_mode_still_uses_original_mihomo_builder",
        "test_no_proxy_mode_survives_auto_update_and_skips_mihomo",
        "test_invalid_engine_rejected_before_git_or_docker",
        "test_invalid_engine_not_hidden_by_if_changed_short_circuit",
        "test_every_v2_compose_entry_has_identical_host_network_webrtc_runtime",
    ),
    "test_v2_max_starting_config.py": (
        "test_all_compose_entries_forward_identical_startup_budget",
        "test_startup_budget_reaches_fresh_app_and_public_metadata",
        "test_invalid_startup_budget_refuses_application_start",
    ),
    "test_v2_admission.py": (
        "test_runtime_admission_limit_released_after_verified_stop",
    ),
    "test_v2_session_state.py": (
        "test_start_stop_clean_release_requires_resource_proof",
        "test_dirty_stays_exclusive_until_explicit_recovery_and_proof",
        "test_invalid_skip_or_duplicate_release_fails_closed",
    ),
    "test_v2_session_manager.py": (
        "test_coordinator_never_frees_dirty_or_foreign_session",
        "test_duplicate_stop_and_cross_device_state_isolation",
    ),
    "test_v2_cleanup.py": (
        "test_deferred_real_peer_close_releases_dirty_session_through_manager",
        "test_late_peer_failure_or_unverified_worker_remains_dirty",
        "test_no_worker_stop_failure_cannot_be_overwritten_by_synthetic_finish",
        "test_peer_close_wrapper_exception_does_not_skip_worker_cleanup",
    ),
    "test_v2_resources.py": (
        "test_byte_budget_drops_old_packets_and_requires_new_idr",
        "test_reader_thread_callback_backlog_has_independent_byte_and_count_limits",
        "test_oversize_submission_is_never_held_by_callback_and_recovers_on_idr",
        "test_stop_racing_producer_disables_new_submission_and_unblocks_recv",
        "test_submission_failure_returns_reserved_budget_and_does_not_touch_queue",
    ),
    "test_v2_webrtc_only.py": (
        "test_v2_has_no_ffmpeg_mse_server_or_browser_pipeline",
        "test_mse_is_invalid_config_and_old_script_is_not_served",
        "test_v2_retired_mse_diagnostics_and_ws_binary_video_cannot_return",
    ),
}
NODE_CONTRACTS = (
    "m2_quality_metrics.cjs", "m2_multi_contract.cjs",
    "m2_twenty_contract.cjs", "m2_group_contract.cjs",
    "m2_batch_connect.cjs", "device_connect_order_contract.cjs",
    "progressive_connect_contract.cjs", "m2_webrtc_contract.cjs",
    "m2_traffic_meter.cjs", "m2_touch_contract.cjs",
    "m3_page_contract.cjs", "global_toast_contract.cjs",
    "inventory_drawer_contract.cjs",
)


def test_critical_v2_regressions_remain_discoverable():
    for filename, required_functions in CRITICAL_PYTHON.items():
        path = ROOT / "tests" / filename
        assert path.is_file(), f"lost V2 test module: {filename}"
        module = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        found = {node.name for node in module.body
                 if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
        assert set(required_functions) <= found, (
            f"{filename} lost critical test cases: {set(required_functions) - found}"
        )


def test_workflow_runs_complete_python_node_shell_and_openwrt_suites():
    text = WORKFLOW.read_text(encoding="utf-8")
    # Inspect executable workflow lines, not mentions in a comment or README.
    lines = [line.strip() for line in text.splitlines()
             if line.strip() and not line.lstrip().startswith("#")]
    assert "refactor/v2-session-governance" in text
    assert "continue-on-error: true" not in text
    assert "run: python -m pytest -q tests/test_v2_release_gate.py" in lines
    assert "run: python -m pytest -q" in lines, "never replace full pytest with selected tests"
    assert "python -m compileall -q server tests" in text
    assert 'for script in scripts/*.sh; do sh -n "$script"; done' in text
    assert "run: sh luci-avahi-web/tests/smoke.sh" in lines
    for filename in NODE_CONTRACTS:
        assert (ROOT / "tests" / filename).is_file(), filename
        assert f"node tests/{filename}" in lines, f"CI lost Node contract {filename}"
    assert text.index("run: python -m pytest -q tests/test_v2_release_gate.py") < (
        text.index("run: python -m pytest -q\n")
    )


def test_v2_runtime_and_delivery_cannot_silently_select_old_mse_or_mapping():
    build = (ROOT / "scripts" / "build-with-mihomo.sh").read_text()
    updater = (ROOT / "scripts" / "update-m2.sh").read_text()
    schedule = (ROOT / "scripts" / "scheduled-deploy.sh").read_text()
    # Explicitly reject retired/unimplemented engines before update/Docker.
    engine_guard = build.index('case "$VIDEO_ENGINE" in')
    git_update = build.index('sh scripts/update-m2.sh')
    assert engine_guard < git_update
    assert 'mse) echo ' in build and 'webcodecs) echo ' in build
    assert build.count("docker compose -f compose.webrtc.yaml up -d --no-build") == 2
    assert "compose.no-proxy.yaml up" not in build
    assert re.search(r"(?m)^\s*docker compose up", build) is None
    assert "refactor/v2-session-governance" in updater
    assert "refusing implicit checkout switch" in updater
    assert schedule.count("refactor/v2-session-governance") >= 2
    assert "feat/m4-screen-mapping-m1" not in schedule
    for filename in ("compose.yaml", "compose.no-proxy.yaml", "compose.webrtc.yaml"):
        content = (ROOT / filename).read_text()
        assert "network_mode: host" in content
        assert "EASYADB_VIDEO_ENGINE: webrtc" in content
        assert "EASYADB_MAX_STARTING: " + "$" + "{EASYADB_MAX_STARTING:-3}" in content
        assert "    ports:" not in content
        assert "    networks:" not in content
    assert not (ROOT / "web" / "m2-player.js").exists()
    assert not (ROOT / "server" / "m2_player.py").exists()
