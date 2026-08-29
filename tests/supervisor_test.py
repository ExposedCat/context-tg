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


if __name__ == "__main__":
    unittest.main()
