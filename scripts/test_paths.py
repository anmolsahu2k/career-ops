import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths  # noqa: E402


def test_default_is_ft():
    os.environ.pop("CAREER_OPS_DATA_DIR", None)
    p = _paths.resolve_paths(__file__)
    assert p["root"].name == "career-ops", p["root"]
    assert str(p["apps_file"]).endswith("ft/data/applications.md"), p["apps_file"]
    assert str(p["portals_file"]).endswith("career-ops/portals.yml"), p["portals_file"]


def test_dot_targets_root_archive():
    os.environ["CAREER_OPS_DATA_DIR"] = "."
    p = _paths.resolve_paths(__file__)
    assert str(p["apps_file"]).endswith("career-ops/data/applications.md"), p["apps_file"]
    os.environ.pop("CAREER_OPS_DATA_DIR", None)


def test_rejects_absolute_and_traversal():
    for bad in ["/etc", "../evil", "ft/../.."]:
        os.environ["CAREER_OPS_DATA_DIR"] = bad
        try:
            _paths.resolve_paths(__file__)
            assert False, f"should reject {bad}"
        except ValueError:
            pass
    os.environ.pop("CAREER_OPS_DATA_DIR", None)


def test_empty_env_defaults_to_ft():
    os.environ["CAREER_OPS_DATA_DIR"] = ""   # set-but-empty must NOT resolve to root archive
    p = _paths.resolve_paths(__file__)
    assert str(p["apps_file"]).endswith("ft/data/applications.md"), p["apps_file"]
    os.environ.pop("CAREER_OPS_DATA_DIR", None)


if __name__ == "__main__":
    test_default_is_ft(); test_dot_targets_root_archive()
    test_rejects_absolute_and_traversal(); test_empty_env_defaults_to_ft()
    print("ok")
