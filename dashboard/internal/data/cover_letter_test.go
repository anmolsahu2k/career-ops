package data

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Anthropic":                "anthropic",
		"AAA Mountainwest Group":   "aaa-mountainwest-group",
		"BMW Group, Inc.":          "bmw-group-inc",
		"Foo & Bar / Baz":          "foo-bar-baz",
		"  --leading and trailing": "leading-and-trailing",
		"":                         "untitled",
	}
	for in, want := range cases {
		if got := Slugify(in); got != want {
			t.Errorf("Slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCoverLetterPath(t *testing.T) {
	app := model.CareerApplication{
		Number:       42,
		ReportNumber: "1205",
		Company:      "Abridge",
		Role:         "Full-Stack Engineer Intern",
	}
	got := CoverLetterPath(app)
	want := filepath.Join("reports", "abridge", "1205-abridge-full-stack-engineer-intern-cover-letter.md")
	if got != want {
		t.Errorf("CoverLetterPath = %q, want %q", got, want)
	}

	// Falls back to Number when ReportNumber empty
	app.ReportNumber = ""
	got = CoverLetterPath(app)
	want = filepath.Join("reports", "abridge", "42-abridge-full-stack-engineer-intern-cover-letter.md")
	if got != want {
		t.Errorf("CoverLetterPath (no ReportNumber) = %q, want %q", got, want)
	}
}

func TestFindExistingCoverLetter_Canonical(t *testing.T) {
	tmp := t.TempDir()
	app := model.CareerApplication{
		ReportNumber: "1205",
		Company:      "Abridge",
		Role:         "Full-Stack Engineer Intern",
	}
	if _, ok := FindExistingCoverLetter(tmp, app); ok {
		t.Fatal("expected not-exists for empty workspace")
	}

	canonical := CoverLetterPath(app)
	if err := os.MkdirAll(filepath.Join(tmp, filepath.Dir(canonical)), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, canonical), []byte("# letter"), 0644); err != nil {
		t.Fatal(err)
	}
	rel, ok := FindExistingCoverLetter(tmp, app)
	if !ok || rel != canonical {
		t.Errorf("FindExistingCoverLetter = %q, %v; want %q, true", rel, ok, canonical)
	}
}

func TestFindExistingCoverLetter_LegacyGlob(t *testing.T) {
	tmp := t.TempDir()
	app := model.CareerApplication{
		ReportNumber: "1949",
		Company:      "Apple",
		Role:         "Some Other Role Spelling",
	}
	// Simulate a legacy filename that doesn't match the canonical role slug.
	dir := filepath.Join(tmp, "reports", "apple")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(dir, "1949-apple-ml-intern-cover-letter.md")
	if err := os.WriteFile(legacy, []byte("# legacy"), 0644); err != nil {
		t.Fatal(err)
	}
	rel, ok := FindExistingCoverLetter(tmp, app)
	if !ok {
		t.Fatal("expected legacy glob match, got not-exists")
	}
	if !strings.HasSuffix(rel, "1949-apple-ml-intern-cover-letter.md") {
		t.Errorf("FindExistingCoverLetter = %q; want match for legacy filename", rel)
	}
}

func TestBuildCoverLetterPrompt_ContainsKeyFacts(t *testing.T) {
	app := model.CareerApplication{
		ReportNumber: "1205",
		Company:      "Abridge",
		Role:         "ML Research Intern",
		Status:       "Applied",
		Score:        4.5,
		ScoreRaw:     "4.5/5",
		ReportPath:   "reports/abridge/1205-eval.md",
		JobURL:       "https://example.com/job/123",
	}
	target := CoverLetterPath(app)
	prompt := BuildCoverLetterPrompt(app, target)

	for _, want := range []string{
		"Abridge",
		"ML Research Intern",
		"https://example.com/job/123",
		"reports/abridge/1205-eval.md",
		target,
		"MLE PDF", // ML role should pick MLE
		"no em-dashes",
		"DONE",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q", want)
		}
	}
}

func TestBuildCoverLetterPrompt_SDERole(t *testing.T) {
	app := model.CareerApplication{
		Number:  42,
		Company: "Stripe",
		Role:    "Backend Engineer Intern",
	}
	prompt := BuildCoverLetterPrompt(app, CoverLetterPath(app))
	if !strings.Contains(prompt, "SDE PDF") {
		t.Error("expected backend role to pick SDE PDF")
	}
	if strings.Contains(prompt, "MLE PDF") {
		t.Error("backend role should not match MLE PDF")
	}
}

// fakeClaude writes a tiny shell script to tmp that simulates `claude -p` by
// creating the target file (parsed from the prompt argument).
func fakeClaude(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "claude")
	// The fake reads the prompt argument (last arg), extracts the path after
	// "save it to ", and writes a stub file there relative to its cwd.
	script := `#!/usr/bin/env bash
set -e
prompt="$4"
target=$(printf '%s' "$prompt" | grep -oE 'save it to [^.]+\.md' | head -1 | sed 's/^save it to //')
mkdir -p "$(dirname "$target")"
printf '# Cover letter (fake)\n' > "$target"
echo "DONE"
`
	if err := os.WriteFile(path, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestGenerateCoverLetter_WritesFile(t *testing.T) {
	tmp := t.TempDir()
	claudeBin := fakeClaude(t)

	app := model.CareerApplication{
		ReportNumber: "1205",
		Company:      "Abridge",
		Role:         "Full-Stack Engineer Intern",
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	rel, err := GenerateCoverLetter(ctx, tmp, app, claudeBin)
	if err != nil {
		t.Fatalf("GenerateCoverLetter error: %v", err)
	}
	want := CoverLetterPath(app)
	if rel != want {
		t.Errorf("returned path = %q, want %q", rel, want)
	}
	if _, err := os.Stat(filepath.Join(tmp, rel)); err != nil {
		t.Errorf("expected file at %s, got error: %v", rel, err)
	}
}

func TestGenerateCoverLetter_EmptyCompany(t *testing.T) {
	tmp := t.TempDir()
	if _, err := GenerateCoverLetter(context.Background(), tmp, model.CareerApplication{}, "claude-not-needed"); err == nil {
		t.Fatal("expected error for empty company")
	}
}

func TestGenerateCoverLetter_ClaudeFails(t *testing.T) {
	tmp := t.TempDir()
	// Fake claude that exits non-zero without writing the file.
	dir := t.TempDir()
	bin := filepath.Join(dir, "claude-fail")
	if err := os.WriteFile(bin, []byte("#!/usr/bin/env bash\necho 'simulated failure' >&2\nexit 1\n"), 0755); err != nil {
		t.Fatal(err)
	}
	app := model.CareerApplication{
		ReportNumber: "1",
		Company:      "Foo",
		Role:         "Bar",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := GenerateCoverLetter(ctx, tmp, app, bin); err == nil {
		t.Fatal("expected error when claude exits non-zero")
	}
}
