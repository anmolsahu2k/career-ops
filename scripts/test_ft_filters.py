import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import discovery_filters as df


def test_newgrad_titles_pass_without_intern_token():
    for t in ["New Grad Software Engineer", "Software Engineer, University Graduate 2026",
              "Associate Data Scientist", "Forward Deployed Engineer", "Solutions Engineer (New Grad)",
              "Member of Technical Staff"]:
        assert df.role_matches_targets(t), f"should be on-target: {t}"


def test_senior_titles_still_denied():
    for t in ["Senior Software Engineer", "Staff Machine Learning Engineer",
              "Principal Engineer", "Engineering Manager", "Product Manager"]:
        assert not df.role_matches_targets(t), f"should be denied: {t}"


def test_season_gate_neutral_for_ft():
    for t in ["New Grad Software Engineer 2027 Start", "Software Engineer, Class of 2027"]:
        assert df.role_in_season(t), f"FT season gate should pass: {t}"


def test_us_only_geo_rejects_bare_global_remote():
    assert df.location_is_us_or_remote("San Francisco, CA")
    assert df.location_is_us_or_remote("Remote, US")
    assert df.location_is_us_or_remote("Remote (United States)")
    assert not df.location_is_us_or_remote("Remote, India")
    assert not df.location_is_us_or_remote("Remote - EMEA")
    assert not df.location_is_us_or_remote("Remote")
    assert df.location_is_us_or_remote("", is_remote=True)
    assert not df.location_is_us_or_remote("Remote, India", is_remote=True)


if __name__ == "__main__":
    test_newgrad_titles_pass_without_intern_token()
    test_senior_titles_still_denied()
    test_season_gate_neutral_for_ft()
    test_us_only_geo_rejects_bare_global_remote()
    print("ok")
