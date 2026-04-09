package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/pikachu0310/discord-codex-bot/go-discord-bot/internal/codex"
	"github.com/pikachu0310/discord-codex-bot/go-discord-bot/internal/store"
	"github.com/pikachu0310/discord-codex-bot/go-discord-bot/internal/workspace"
)

type fakeRunner struct {
	result codex.RunResult
	err    error
	delay  time.Duration
}

func (f fakeRunner) Run(
	ctx context.Context,
	_ string,
	_ string,
	_ string,
	onProgress func(string),
	_ func(string),
) (codex.RunResult, error) {
	if onProgress != nil {
		onProgress("progress")
	}
	if f.delay > 0 {
		select {
		case <-ctx.Done():
			return codex.RunResult{}, codex.ErrRunStopped
		case <-time.After(f.delay):
		}
	}
	return f.result, f.err
}

func TestStartChatAndStatus(t *testing.T) {
	base := t.TempDir()
	st := store.New(base)
	if err := st.Init(); err != nil {
		t.Fatalf("store init: %v", err)
	}
	wm := workspace.New(base)
	if err := wm.Init(); err != nil {
		t.Fatalf("workspace init: %v", err)
	}

	svc := NewService(st, wm, fakeRunner{}, 1000, 10000, 0)
	if _, err := svc.StartChatSession("thread-1"); err != nil {
		t.Fatalf("start chat: %v", err)
	}

	_ = st.AppendTokenUsage(store.TokenUsageEvent{
		TimestampUTC: time.Now().UTC().Add(-2 * time.Hour),
		Tokens:       250,
	})
	_ = st.AppendTokenUsage(store.TokenUsageEvent{
		TimestampUTC: time.Now().UTC().Add(-12 * time.Hour),
		Tokens:       500,
	})

	status, err := svc.Status("thread-1")
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if status.Mode != store.SessionModeChat {
		t.Fatalf("mode = %s", status.Mode)
	}
	if status.Remaining5HRate != 75 {
		t.Fatalf("remaining5h = %d, want 75", status.Remaining5HRate)
	}
	if status.Remaining1WRate != 92 {
		t.Fatalf("remaining1w = %d, want 92", status.Remaining1WRate)
	}
}

func TestHandleUserMessageUpdatesSessionAndUsage(t *testing.T) {
	base := t.TempDir()
	st := store.New(base)
	_ = st.Init()
	wm := workspace.New(base)
	_ = wm.Init()

	svc := NewService(
		st,
		wm,
		fakeRunner{
			result: codex.RunResult{
				FinalText:  "done",
				SessionID:  "sess-1",
				TokenUsage: 120,
			},
		},
		1000,
		2000,
		0,
	)

	if _, err := svc.StartChatSession("thread-2"); err != nil {
		t.Fatalf("start chat: %v", err)
	}

	out, err := svc.HandleUserMessage(context.Background(), "thread-2", "hello", nil)
	if err != nil {
		t.Fatalf("handle message: %v", err)
	}
	if out != "done" {
		t.Fatalf("final = %q", out)
	}

	sess, err := st.LoadSession("thread-2")
	if err != nil || sess == nil {
		t.Fatalf("load session err: %v", err)
	}
	if sess.CodexSessionID != "sess-1" {
		t.Fatalf("session id = %q", sess.CodexSessionID)
	}

	sum, err := st.SumTokenUsageSince(time.Now().UTC().Add(-1 * time.Hour))
	if err != nil {
		t.Fatalf("sum usage: %v", err)
	}
	if sum != 120 {
		t.Fatalf("sum = %d, want 120", sum)
	}
}

func TestStopCancelsRunning(t *testing.T) {
	base := t.TempDir()
	st := store.New(base)
	_ = st.Init()
	wm := workspace.New(base)
	_ = wm.Init()

	svc := NewService(
		st,
		wm,
		fakeRunner{
			delay: 500 * time.Millisecond,
		},
		1000,
		1000,
		0,
	)
	_, _ = svc.StartChatSession("thread-3")

	done := make(chan error, 1)
	go func() {
		_, err := svc.HandleUserMessage(context.Background(), "thread-3", "long", nil)
		if err != nil && !errors.Is(err, codex.ErrRunStopped) {
			done <- err
			return
		}
		done <- nil
	}()

	time.Sleep(50 * time.Millisecond)
	stopped, err := svc.Stop("thread-3")
	if err != nil {
		t.Fatalf("stop err: %v", err)
	}
	if !stopped {
		t.Fatal("expected stopped=true")
	}
	if err := <-done; err != nil {
		t.Fatalf("handle goroutine err: %v", err)
	}
}
