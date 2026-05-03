package data

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

var (
	reSlugNonWord = regexp.MustCompile(`[^a-z0-9]+`)
	reSlugTrim    = regexp.MustCompile(`(^-+|-+$)`)
)

// Slugify converts a string to lowercase hyphenated slug form.
// Mirrors the slugifier in scripts/reorg-reports-by-company.py.
func Slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = reSlugNonWord.ReplaceAllString(s, "-")
	s = reSlugTrim.ReplaceAllString(s, "")
	if s == "" {
		s = "untitled"
	}
	return s
}

// trackerNum returns the canonical tracker number string for an app.
func trackerNum(app model.CareerApplication) string {
	if app.ReportNumber != "" {
		return app.ReportNumber
	}
	if app.Number > 0 {
		return fmt.Sprintf("%d", app.Number)
	}
	return ""
}

// CoverLetterPath returns the canonical relative path where a cover letter for
// `app` should be written.
func CoverLetterPath(app model.CareerApplication) string {
	companySlug := Slugify(app.Company)
	roleSlug := Slugify(app.Role)
	num := trackerNum(app)
	return filepath.Join(
		"reports",
		companySlug,
		fmt.Sprintf("%s-%s-%s-cover-letter.md", num, companySlug, roleSlug),
	)
}

// FindExistingCoverLetter returns the relative path of an existing cover-letter
// file for app, if one is on disk. It first checks the canonical path, then
// globs `reports/<companySlug>/<NN>-*-cover-letter.md` to catch legacy
// filenames (e.g. with a different role-slug spelling, or company-only).
func FindExistingCoverLetter(careerOpsPath string, app model.CareerApplication) (string, bool) {
	companySlug := Slugify(app.Company)
	if companySlug == "untitled" {
		return "", false
	}
	canonical := CoverLetterPath(app)
	if _, err := os.Stat(filepath.Join(careerOpsPath, canonical)); err == nil {
		return canonical, true
	}
	num := trackerNum(app)
	if num == "" {
		return "", false
	}
	matches, _ := filepath.Glob(filepath.Join(
		careerOpsPath, "reports", companySlug, num+"-*-cover-letter.md",
	))
	if len(matches) > 0 {
		if rel, err := filepath.Rel(careerOpsPath, matches[0]); err == nil {
			return rel, true
		}
		return matches[0], true
	}
	return "", false
}

// resumeHint returns "MLE PDF" for ML/AI/DS/research roles, else "SDE PDF".
func resumeHint(role string) string {
	r := strings.ToLower(role)
	for _, kw := range []string{"machine learning", "data scien", "applied scien", "research", "deep learning", "ml ", " ml", "/ml", "ai/", "/ai", "ai ", " ai"} {
		if strings.Contains(r, kw) {
			return "MLE PDF"
		}
	}
	return "SDE PDF"
}

// BuildCoverLetterPrompt returns the prompt sent to `claude -p`.
func BuildCoverLetterPrompt(app model.CareerApplication, target string) string {
	jobURL := app.JobURL
	if jobURL == "" {
		jobURL = "(none)"
	}
	reportRef := app.ReportPath
	if reportRef == "" {
		reportRef = "(none)"
	}
	score := app.ScoreRaw
	if score == "" && app.Score > 0 {
		score = fmt.Sprintf("%.1f/5", app.Score)
	}
	if score == "" {
		score = "(unscored)"
	}
	rh := resumeHint(app.Role)
	num := trackerNum(app)
	if num == "" {
		num = "(unnumbered)"
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Write a cover letter for this internship role and save it to %s. Do not modify any other file. Do not append to the tracker. When done, print exactly DONE.\n\n", target)
	fmt.Fprintf(&b, "Tracker #: %s\n", num)
	fmt.Fprintf(&b, "Company: %s\n", app.Company)
	fmt.Fprintf(&b, "Role: %s\n", app.Role)
	fmt.Fprintf(&b, "Score: %s\n", score)
	fmt.Fprintf(&b, "Status: %s\n", app.Status)
	fmt.Fprintf(&b, "Job URL: %s\n", jobURL)
	fmt.Fprintf(&b, "Eval report (read this first for context): %s\n", reportRef)
	fmt.Fprintf(&b, "Resume to recommend in the cover letter header: %s\n\n", rh)
	b.WriteString("Apply all rules from CLAUDE.md (auto-loaded for this directory): ")
	b.WriteString("no em-dashes or en-dashes, no F-1/CPT/Heinz/OIE explainer, no CV PDF generation. ")
	b.WriteString("Reference cv.md as the source-of-truth resume. ")
	b.WriteString("Length 250-350 words, paragraph form (no bullets unless the JD form specifically asks). ")
	b.WriteString("End with a clear close.\n")
	return b.String()
}

// GenerateCoverLetter shells out to claude with `-p` and asks it to write the
// cover letter at the canonical path. claudeBin defaults to "claude" but can be
// overridden for tests. Returns the relative path of the written file.
func GenerateCoverLetter(ctx context.Context, careerOpsPath string, app model.CareerApplication, claudeBin string) (string, error) {
	if claudeBin == "" {
		claudeBin = "claude"
	}
	companySlug := Slugify(app.Company)
	if companySlug == "untitled" {
		return "", fmt.Errorf("company name is empty")
	}

	target := CoverLetterPath(app)
	if err := os.MkdirAll(filepath.Join(careerOpsPath, "reports", companySlug), 0755); err != nil {
		return "", fmt.Errorf("mkdir reports/%s: %w", companySlug, err)
	}

	prompt := BuildCoverLetterPrompt(app, target)

	cmd := exec.CommandContext(ctx, claudeBin, "--permission-mode", "acceptEdits", "-p", prompt)
	cmd.Dir = careerOpsPath
	var stderr bytes.Buffer
	cmd.Stdout = io.Discard
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("claude exited: %w (stderr: %s)", err, strings.TrimSpace(stderr.String()))
	}
	fullPath := filepath.Join(careerOpsPath, target)
	if _, err := os.Stat(fullPath); err != nil {
		return "", fmt.Errorf("claude finished but file missing at %s", target)
	}
	return target, nil
}
