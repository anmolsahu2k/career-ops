import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import h1bgrader_lookup as h


def test_company_slug_guess():
    assert h.slug_guess("Google LLC") == "google-llc"
    assert h.slug_guess("Acme, Inc.") == "acme-inc"
    assert h.slug_guess("AT&T") == "at-t"


def test_parse_sponsor_page_extracts_signal():
    html = '<h1>Google LLC H1B</h1> ... 8,779 LCA ... 8,685 Certified ... NOT a H1B Dependent Employer ... $184,000 median'
    sig = h.parse_sponsor_page(html)
    assert sig["has_history"] is True
    assert sig["lca_recent"] == 8779
    assert sig["dependent"] is False


def test_parse_sponsor_page_zero_history():
    sig = h.parse_sponsor_page("<h1>Acme</h1> profile loaded, 0 LCA records on file")
    assert sig["has_history"] is False


def test_parse_sponsor_page_404_is_unknown():
    sig = h.parse_sponsor_page("<h1>Page Not Found</h1> we couldn't find that sponsor")
    assert sig["has_history"] is None
    assert h.parse_sponsor_page("")["has_history"] is None


if __name__ == "__main__":
    test_company_slug_guess(); test_parse_sponsor_page_extracts_signal()
    test_parse_sponsor_page_zero_history(); test_parse_sponsor_page_404_is_unknown()
    print("ok")
