#!/usr/bin/env python3
"""CLI and production composition root for the sandbox runtime."""

from __future__ import annotations

import argparse
import asyncio
import os
import signal

from .agent_bridge_process import AgentBridgeProcess
from .boot_warnings import BootWarningSink
from .browser_desktop import BrowserDesktop
from .code_server import CodeServer
from .constants import VNC_DISPLAY, VNC_PASSWORD_ENV_VAR
from .dev_services import DevServiceManager
from .harness_credentials import materialize_harness_credentials
from .log_config import configure_logging, get_logger
from .managed_skills import ManagedSkillsClient, ManagedSkillsMaterializer
from .modal_image_build_start import MODAL_IMAGE_BUILD_START_ARGUMENT, run_modal_image_build
from .opencode_server import OpenCodeServer, resolve_opencode_global_config_dir
from .repository_boot import RepositoryBoot
from .repository_hooks import RepositoryHooks
from .repository_sync import RepositorySynchronizer
from .runtime_config import RuntimeConfig
from .runtime_launch import validate_runtime_launch
from .supervisor import SandboxSupervisor
from .tunnel_environment import TunnelEnvironment
from .types import AgentHarness
from .web_terminal import WebTerminal

configure_logging()


def build_supervisor(shutdown_event: asyncio.Event) -> SandboxSupervisor:
    """Consume process secrets and compose the production runtime."""
    config = RuntimeConfig.from_env(os.environ)
    vnc_password = os.environ.pop(VNC_PASSWORD_ENV_VAR, None) or None
    if vnc_password:
        os.environ["DISPLAY"] = VNC_DISPLAY
    log = get_logger(
        "supervisor",
        service="sandbox",
        sandbox_id=config.sandbox_id,
        session_id=str(config.session_config.get("session_id", "")),
    )
    warnings = BootWarningSink(log)
    validate_runtime_launch(
        config.session_config,
        os.environ,
        expected_harness=config.agent_harness,
    )
    materialize_harness_credentials(os.environ, log, warnings.record, config.agent_harness)
    dev_services = DevServiceManager(
        workspace_path=config.workspace_path,
        log=log,
        warn=warnings.record,
    )
    repository_boot = RepositoryBoot(
        config.repository_config(),
        log,
        warnings,
        TunnelEnvironment(config.sandbox_id, log),
        RepositoryHooks(log),
        RepositorySynchronizer(config.vcs_host, log),
        dev_services,
    )
    managed_skills_config = config.managed_skills_config()
    managed_skills = None
    if managed_skills_config.control_plane_url and managed_skills_config.session_id:
        skills_root = {
            AgentHarness.OPENCODE: resolve_opencode_global_config_dir() / "skills",
            AgentHarness.CODEX: config.workspace_path / ".codex" / "skills",
            AgentHarness.CLAUDE: config.workspace_path / ".claude" / "skills",
            AgentHarness.DEEPSEEK: config.workspace_path / ".agents" / "skills",
        }[config.agent_harness]
        managed_skills = ManagedSkillsMaterializer(
            ManagedSkillsClient(
                managed_skills_config.control_plane_url,
                managed_skills_config.session_id,
                managed_skills_config.sandbox_token,
            ),
            skills_root,
            log,
        )
    opencode_server = OpenCodeServer(
        config.opencode_config(),
        shutdown_event,
        log,
        warnings.record,
    )
    agent_bridge = AgentBridgeProcess(config.bridge_process_config(), log)
    code_server = CodeServer(log)
    web_terminal = WebTerminal(log)
    browser_desktop = BrowserDesktop(log, password=vnc_password)
    supervisor = SandboxSupervisor(
        config,
        repository_boot,
        opencode_server,
        agent_bridge,
        code_server,
        web_terminal,
        browser_desktop,
        managed_skills,
        shutdown_event,
        log,
    )
    supervisor.dev_services = dev_services
    return supervisor


def install_signal_handlers(supervisor: SandboxSupervisor) -> None:
    """Route process signals to the supervisor-owned shutdown event."""
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, supervisor.request_shutdown, sig)


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Open-Inspect sandbox supervisor")
    parser.add_argument(
        MODAL_IMAGE_BUILD_START_ARGUMENT,
        dest="await_modal_image_build_token",
        action="store_true",
    )
    args = parser.parse_args(argv)

    supervisor = build_supervisor(asyncio.Event())
    install_signal_handlers(supervisor)
    if not args.await_modal_image_build_token:
        await supervisor.run()
        return 0
    return await run_modal_image_build(supervisor)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
