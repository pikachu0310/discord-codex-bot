package store

import (
	"path/filepath"
	"testing"
	"time"
)

func TestStoreSessionAndRunRoundTrip(t *testing.T) {
	base := t.TempDir()
	st := New(base)
	if err := st.Init(); err != nil {
		t.Fatalf("init: %v", err)
	}

	now := time.Now().UTC()
	sess := SessionState{
		ThreadID:      "thread-1",
		Mode:          SessionModeChat,
		WorkspacePath: "/tmp/work",
		Status:        SessionStatusActive,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := st.SaveSession(sess); err != nil {
		t.Fatalf("save session: %v", err)
	}

	gotSess, err := st.LoadSession("thread-1")
	if err != nil {
		t.Fatalf("load session: %v", err)
	}
	if gotSess == nil || gotSess.ThreadID != "thread-1" {
		t.Fatalf("unexpected session: %#v", gotSess)
	}

	run := RunState{
		ThreadID:      "thread-1",
		LastRunID:     "run-1",
		Status:        RunStatusRunning,
		LastUpdatedAt: now,
	}
	if err := st.SaveRun(run); err != nil {
		t.Fatalf("save run: %v", err)
	}
	gotRun, err := st.LoadRun("thread-1")
	if err != nil {
		t.Fatalf("load run: %v", err)
	}
	if gotRun == nil || gotRun.LastRunID != "run-1" {
		t.Fatalf("unexpected run: %#v", gotRun)
	}

	_ = filepath.Join(base, "noop")
}

func TestStoreTokenUsageAggregation(t *testing.T) {
	st := New(t.TempDir())
	if err := st.Init(); err != nil {
		t.Fatalf("init: %v", err)
	}

	now := time.Now().UTC()
	events := []TokenUsageEvent{
		{TimestampUTC: now.Add(-6 * time.Hour), Tokens: 100},
		{TimestampUTC: now.Add(-4 * time.Hour), Tokens: 200},
		{TimestampUTC: now.Add(-2 * time.Hour), Tokens: 300},
	}
	for _, e := range events {
		if err := st.AppendTokenUsage(e); err != nil {
			t.Fatalf("append token usage: %v", err)
		}
	}

	sum5h, err := st.SumTokenUsageSince(now.Add(-5 * time.Hour))
	if err != nil {
		t.Fatalf("sum5h: %v", err)
	}
	if sum5h != 500 {
		t.Fatalf("sum5h = %d, want 500", sum5h)
	}

	sum1w, err := st.SumTokenUsageSince(now.Add(-7 * 24 * time.Hour))
	if err != nil {
		t.Fatalf("sum1w: %v", err)
	}
	if sum1w != 600 {
		t.Fatalf("sum1w = %d, want 600", sum1w)
	}
}
