package screens

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

func tabIndexForFilter(t *testing.T, filter string) int {
	t.Helper()

	for i, tab := range pipelineTabs {
		if tab.filter == filter {
			return i
		}
	}

	t.Fatalf("expected pipeline tabs to include filter %q", filter)
	return -1
}

func TestWithReloadedDataPreservesStateAndSelection(t *testing.T) {
	initialApps := []model.CareerApplication{
		{
			Company:    "Acme",
			Role:       "Backend Engineer",
			Status:     "Evaluated",
			Score:      4.2,
			ReportPath: "reports/001-acme.md",
		},
		{
			Company:    "Beta",
			Role:       "Platform Engineer",
			Status:     "Applied",
			Score:      4.6,
			ReportPath: "reports/002-beta.md",
		},
	}

	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		initialApps,
		model.PipelineMetrics{Total: len(initialApps)},
		"..",
		120,
		40,
	)
	pm.sortMode = sortCompany
	pm.activeTab = 0
	pm.viewMode = "flat"
	pm.applyFilterAndSort()
	pm.cursor = 1
	pm.reportCache["reports/002-beta.md"] = reportSummary{tldr: "cached"}

	refreshedApps := []model.CareerApplication{
		initialApps[0],
		initialApps[1],
		{
			Company:    "Gamma",
			Role:       "AI Engineer",
			Status:     "Interview",
			Score:      4.8,
			ReportPath: "reports/003-gamma.md",
		},
	}

	reloaded := pm.WithReloadedData(refreshedApps, model.PipelineMetrics{Total: len(refreshedApps)})

	if reloaded.sortMode != sortCompany {
		t.Fatalf("expected sort mode %q, got %q", sortCompany, reloaded.sortMode)
	}
	if reloaded.viewMode != "flat" {
		t.Fatalf("expected view mode to stay flat, got %q", reloaded.viewMode)
	}
	if got := len(reloaded.filtered); got != 3 {
		t.Fatalf("expected 3 filtered apps after refresh, got %d", got)
	}
	if app, ok := reloaded.CurrentApp(); !ok || app.ReportPath != "reports/002-beta.md" {
		t.Fatalf("expected selection to stay on beta app, got %+v (ok=%v)", app, ok)
	}
	if reloaded.reportCache["reports/002-beta.md"].tldr != "cached" {
		t.Fatal("expected cached report summaries to survive refresh")
	}
}

func TestRenderAppLineIncludesDateColumn(t *testing.T) {
	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		nil,
		model.PipelineMetrics{},
		"..",
		120,
		40,
	)

	line := pm.renderAppLine(model.CareerApplication{
		Number:  42,
		Date:    "2026-04-13",
		Company: "Anthropic",
		Role:    "Forward Deployed Engineer",
		Status:  "Applied",
		Score:   4.5,
	}, false)

	if !strings.Contains(line, "2026-04-13") {
		t.Fatalf("expected rendered line to include date column, got %q", line)
	}
	if !strings.Contains(line, "#42") {
		t.Fatalf("expected rendered line to include tracker number marker, got %q", line)
	}
}

func TestRejectedAndDiscardedTabsFilterCorrectly(t *testing.T) {
	apps := []model.CareerApplication{
		{
			Company:    "Acme",
			Role:       "Backend Engineer",
			Status:     "Rejected",
			Score:      3.4,
			ReportPath: "reports/001-acme.md",
		},
		{
			Company:    "Beta",
			Role:       "Platform Engineer",
			Status:     "Discarded",
			Score:      2.1,
			ReportPath: "reports/002-beta.md",
		},
		{
			Company:    "Gamma",
			Role:       "AI Engineer",
			Status:     "Applied",
			Score:      4.6,
			ReportPath: "reports/003-gamma.md",
		},
	}

	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		apps,
		model.PipelineMetrics{Total: len(apps)},
		"..",
		120,
		40,
	)

	pm.activeTab = tabIndexForFilter(t, filterRejected)
	pm.applyFilterAndSort()
	if len(pm.filtered) != 1 || pm.filtered[0].Status != "Rejected" {
		t.Fatalf("expected rejected tab to isolate rejected rows, got %+v", pm.filtered)
	}

	pm.activeTab = tabIndexForFilter(t, filterDiscarded)
	pm.applyFilterAndSort()
	if len(pm.filtered) != 1 || pm.filtered[0].Status != "Discarded" {
		t.Fatalf("expected discarded tab to isolate discarded rows, got %+v", pm.filtered)
	}
}

// uKeyTestSetup builds a pipeline with one selected app at the given workspace.
func uKeyTestSetup(t *testing.T, workspace string) PipelineModel {
	t.Helper()
	apps := []model.CareerApplication{{
		Number:       1205,
		ReportNumber: "1205",
		Company:      "Abridge",
		Role:         "Full-Stack Engineer Intern",
		Status:       "Applied",
		Score:        4.5,
		ScoreRaw:     "4.5/5",
	}}
	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		apps,
		model.PipelineMetrics{Total: len(apps)},
		workspace,
		120, 40,
	)
	pm.viewMode = "flat"
	pm.applyFilterAndSort()
	pm.cursor = 0
	return pm
}

func TestUKey_NoExistingFile_DispatchesGenerate(t *testing.T) {
	tmp := t.TempDir()
	pm := uKeyTestSetup(t, tmp)

	updated, cmd := pm.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'u'}})
	if !updated.coverLetterGenerating {
		t.Error("expected coverLetterGenerating to be set after `u` press with no existing file")
	}
	if updated.flash == "" {
		t.Error("expected flash to be set during generation")
	}
	if cmd == nil {
		t.Fatal("expected a non-nil tea.Cmd dispatching the generate message")
	}
	switch cmd().(type) {
	case PipelineGenerateCoverLetterMsg:
		// good
	default:
		t.Errorf("expected PipelineGenerateCoverLetterMsg, got %T", cmd())
	}
}

func TestUKey_ExistingFile_DispatchesOpenViewer(t *testing.T) {
	tmp := t.TempDir()
	pm := uKeyTestSetup(t, tmp)
	app := pm.filtered[0]

	// Drop a canonical cover letter file.
	rel := data.CoverLetterPath(app)
	if err := os.MkdirAll(filepath.Join(tmp, filepath.Dir(rel)), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, rel), []byte("# letter\n"), 0644); err != nil {
		t.Fatal(err)
	}

	updated, cmd := pm.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'u'}})
	if updated.coverLetterGenerating {
		t.Error("did not expect generating flag when file already exists")
	}
	if cmd == nil {
		t.Fatal("expected open-viewer command")
	}
	msg, ok := cmd().(PipelineOpenReportMsg)
	if !ok {
		t.Fatalf("expected PipelineOpenReportMsg, got %T", cmd())
	}
	wantSuffix := filepath.Base(rel)
	if !strings.HasSuffix(msg.Path, wantSuffix) {
		t.Errorf("opened path = %q, want suffix %q", msg.Path, wantSuffix)
	}
	if !strings.Contains(msg.Title, "Cover Letter") {
		t.Errorf("title = %q, want it to mention Cover Letter", msg.Title)
	}
}

func TestUKey_DebouncedDuringGeneration(t *testing.T) {
	tmp := t.TempDir()
	pm := uKeyTestSetup(t, tmp)
	pm.coverLetterGenerating = true

	updated, cmd := pm.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'u'}})
	if cmd != nil {
		t.Errorf("expected nil cmd while already generating, got %T", cmd())
	}
	if !strings.Contains(strings.ToLower(updated.flash), "still generating") {
		t.Errorf("expected flash to mention still generating, got %q", updated.flash)
	}
}
