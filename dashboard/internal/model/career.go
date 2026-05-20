package model

// CareerApplication represents a single job application from the tracker.
type CareerApplication struct {
	Number       int
	Date         string
	Company      string
	Role         string
	Status       string
	Score        float64
	ScoreRaw     string
	HasPDF       bool
	ReportPath   string
	ReportNumber string
	Notes        string
	JobURL       string // URL of the original job posting
	// Enrichment (lazy loaded from report)
	Archetype    string
	TlDr         string
	Remote       string
	CompEstimate string
}

// PipelineMetrics holds aggregate stats for the pipeline dashboard.
type PipelineMetrics struct {
	Total      int
	ByStatus   map[string]int
	AvgScore   float64
	TopScore   float64
	WithPDF    int
	Actionable int
}

// TimeBucket selects the granularity of the time-series activity chart.
type TimeBucket int

const (
	BucketDay TimeBucket = iota
	BucketWeek
	BucketMonth
)

// ProgressMetrics holds job search progress analytics.
type ProgressMetrics struct {
	// Funnel
	FunnelStages []FunnelStage

	// Score distribution
	ScoreBuckets []ScoreBucket

	// Applications-submitted activity, pre-bucketed at three granularities.
	// Each slice covers a fixed trailing window (14 days / 8 weeks / 6 months)
	// and includes zero-count entries so the chart shows gaps.
	DailyActivity   []BucketActivity
	WeeklyActivity  []BucketActivity
	MonthlyActivity []BucketActivity

	// Rates
	ResponseRate  float64 // Responded / Applied
	InterviewRate float64 // Interview / Applied
	OfferRate     float64 // Offer / Applied

	// Averages
	AvgScore    float64
	TopScore    float64
	TotalOffers int
	ActiveApps  int // not skip/rejected/discarded
}

// FunnelStage represents one stage of the application funnel.
type FunnelStage struct {
	Label string
	Count int
	Pct   float64 // percentage of total
}

// ScoreBucket represents a score range and its count.
type ScoreBucket struct {
	Label string // e.g., "4.5-5.0", "4.0-4.4", "3.5-3.9", "3.0-3.4", "<3.0"
	Count int
}

// BucketActivity represents application activity for a single time bucket
// (a day, ISO week, or calendar month, depending on context).
type BucketActivity struct {
	Label string // e.g., "2026-05-08", "2026-W19", "2026-05"
	Count int
}
