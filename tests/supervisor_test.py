import importlib.util
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path


SCRIPT_PATH = Path(__file__).parents[1] / "deploy/scripts/loylex-supervisor"
LOADER = SourceFileLoader("loylex_supervisor", str(SCRIPT_PATH))
SPEC = importlib.util.spec_from_loader("loylex_supervisor", LOADER)
if SPEC is None:
    raise RuntimeError("Unable to load loylex-supervisor")
SUPERVISOR = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(SUPERVISOR)


class SupervisorTest(unittest.TestCase):
    def test_replaces_only_expected_image(self) -> None:
        content = "[Container]\nImage=ghcr.io/chelokot/loylex-agent:main\nReadOnly=true\n"
        updated = SUPERVISOR.replace_image_line(
            content,
            "ghcr.io/chelokot/loylex-agent",
            "ghcr.io/chelokot/loylex-agent@sha256:123",
        )
        self.assertEqual(
            updated,
            "[Container]\nImage=ghcr.io/chelokot/loylex-agent@sha256:123\nReadOnly=true\n",
        )

    def test_rejects_missing_or_ambiguous_image(self) -> None:
        with self.assertRaises(SUPERVISOR.SupervisorError):
            SUPERVISOR.replace_image_line("[Container]\n", "example/image", "example/image@sha256:1")
        with self.assertRaises(SUPERVISOR.SupervisorError):
            SUPERVISOR.replace_image_line(
                "Image=example/image:main\nImage=example/image:old\n",
                "example/image",
                "example/image@sha256:1",
            )

    def test_selects_only_fixed_components(self) -> None:
        self.assertEqual(SUPERVISOR.selected_components("agent"), ["agent"])
        self.assertEqual(SUPERVISOR.selected_components("all"), ["gateway", "agent"])
        with self.assertRaises(SUPERVISOR.SupervisorError):
            SUPERVISOR.selected_components("host")

    def test_renders_distinct_draining_agent_slots(self) -> None:
        content = (
            "[Unit]\n"
            "Description=Loylex persistent Codex agent\n"
            "[Container]\n"
            "ContainerName=loylex-agent\n"
            "Environment=CODEX_MODEL=test\n"
            "NoNewPrivileges=false\n"
            "[Service]\n"
            "Restart=always\n"
        )
        blue = SUPERVISOR.render_agent_slot(content, "blue")
        green = SUPERVISOR.render_agent_slot(content, "green")
        self.assertIn("Description=Loylex persistent Codex agent (blue)", blue)
        self.assertIn("ContainerName=loylex-agent-blue", blue)
        self.assertIn("Environment=LOYLEX_WORKER_SLOT=blue", blue)
        self.assertIn("Restart=on-failure", blue)
        self.assertIn("ContainerName=loylex-agent-green", green)
        self.assertIn("Environment=LOYLEX_WORKER_SLOT=green", green)
        self.assertNotIn("LOYLEX_WORKER_SLOT=blue", green)

    def test_rejects_invalid_agent_slot_quadlet(self) -> None:
        with self.assertRaises(SUPERVISOR.SupervisorError):
            SUPERVISOR.render_agent_slot("[Container]\nContainerName=loylex-agent\n", "blue")
        with self.assertRaises(SUPERVISOR.SupervisorError):
            SUPERVISOR.render_agent_slot("[Unit]\nDescription=agent\n", "blue")


if __name__ == "__main__":
    unittest.main()
