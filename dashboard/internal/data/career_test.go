package data

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseApplicationsUsesTrackerNumberColumn(t *testing.T) {
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("failed to create data dir: %v", err)
	}

	applications := `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 140 | 2026-04-16 | Arize AI | AI Engineer, Instrumentation | 4.7/5 | Evaluated | ✅ | [140](reports/140-arize-ai-engineer-instrumentation-2026-04-16.md) | Strong fit |
| 143 | 2026-04-16 | Arize AI | AI Sales Engineer, US | 4.1/5 | Evaluated | ❌ | [143](reports/143-arize-ai-sales-engineer-us-2026-04-16.md) | Good fit |
`

	applicationsPath := filepath.Join(dataDir, "applications.md")
	if err := os.WriteFile(applicationsPath, []byte(applications), 0o644); err != nil {
		t.Fatalf("failed to write applications tracker: %v", err)
	}

	apps := ParseApplications(tempDir)
	if len(apps) != 2 {
		t.Fatalf("expected 2 parsed applications, got %d", len(apps))
	}

	if apps[0].Number != 140 {
		t.Fatalf("expected first application number to be 140, got %d", apps[0].Number)
	}
	if apps[1].Number != 143 {
		t.Fatalf("expected second application number to be 143, got %d", apps[1].Number)
	}
	if apps[0].ReportNumber != "140" || apps[1].ReportNumber != "143" {
		t.Fatalf("expected report numbers to stay aligned with tracker IDs, got %q and %q", apps[0].ReportNumber, apps[1].ReportNumber)
	}
}

func TestExpireStaleEvaluations(t *testing.T) {
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("failed to create data dir: %v", err)
	}

	// "now" anchor: 2026-05-08. Cutoff is 21 days back -> 2026-04-17.
	now := time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC)

	// Five rows covering each branch:
	//  140: Evaluated, 2026-03-01 -> stale, FLIP
	//  141: Evaluated, 2026-04-30 -> recent, keep
	//  142: Applied,   2026-03-01 -> not Evaluated, keep
	//  143: Discarded, 2026-03-01 -> already Discarded, keep (idempotent)
	//  144: Evaluated, 2026-04-17 -> exactly cutoff, keep (strictly older required)
	applications := `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 140 | 2026-03-01 | StaleCo | Engineer | 4.0/5 | Evaluated | ❌ | [140](reports/140.md) | original note |
| 141 | 2026-04-30 | RecentCo | Engineer | 3.5/5 | Evaluated | ❌ | [141](reports/141.md) |  |
| 142 | 2026-03-01 | AppliedCo | Engineer | 4.2/5 | Applied | ✅ | [142](reports/142.md) | submitted |
| 143 | 2026-03-01 | DiscardedCo | Engineer | 1.5/5 | Discarded | ❌ | [143](reports/143.md) | not a fit |
| 144 | 2026-04-17 | EdgeCo | Engineer | 3.0/5 | Evaluated | ❌ | [144](reports/144.md) |  |
`
	appsPath := filepath.Join(dataDir, "applications.md")
	if err := os.WriteFile(appsPath, []byte(applications), 0o644); err != nil {
		t.Fatalf("failed to write applications: %v", err)
	}

	flipped, err := ExpireStaleEvaluations(tempDir, now)
	if err != nil {
		t.Fatalf("ExpireStaleEvaluations returned error: %v", err)
	}
	if flipped != 1 {
		t.Fatalf("expected 1 flipped row, got %d", flipped)
	}

	out, err := os.ReadFile(appsPath)
	if err != nil {
		t.Fatalf("failed to read post-sweep file: %v", err)
	}
	got := string(out)

	if !strings.Contains(got, "| 140 | 2026-03-01 | StaleCo | Engineer | 4.0/5 | Discarded |") {
		t.Errorf("row 140 should have been flipped to Discarded; got:\n%s", got)
	}
	if !strings.Contains(got, "auto-discarded 2026-05-08 (>21d stale)") {
		t.Errorf("row 140 should have audit suffix in Notes; got:\n%s", got)
	}
	if !strings.Contains(got, "original note; auto-discarded 2026-05-08") {
		t.Errorf("row 140 should preserve original note before suffix; got:\n%s", got)
	}
	if strings.Contains(got, "| 141 | 2026-04-30 | RecentCo | Engineer | 3.5/5 | Discarded") {
		t.Errorf("row 141 (recent) should NOT have been flipped; got:\n%s", got)
	}
	if strings.Contains(got, "| 142 | 2026-03-01 | AppliedCo | Engineer | 4.2/5 | Discarded") {
		t.Errorf("row 142 (Applied) should NOT have been flipped; got:\n%s", got)
	}
	if strings.Contains(got, "| 144 | 2026-04-17 | EdgeCo | Engineer | 3.0/5 | Discarded") {
		t.Errorf("row 144 (cutoff boundary) should NOT have been flipped; got:\n%s", got)
	}

	// Idempotency: second sweep should be a no-op.
	flipped2, err := ExpireStaleEvaluations(tempDir, now)
	if err != nil {
		t.Fatalf("second ExpireStaleEvaluations errored: %v", err)
	}
	if flipped2 != 0 {
		t.Fatalf("expected 0 flipped rows on idempotent re-run, got %d", flipped2)
	}
}
