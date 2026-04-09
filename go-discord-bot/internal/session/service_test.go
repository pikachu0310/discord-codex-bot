package session

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pikachu0310/discord-codex-bot/go-discord-bot/internal/codex"
	"github.com/pikachu0310/discord-codex-bot/go-discord-bot/internal/store"
	"github.com/pikachu0310/discord-codex-bot/go-discord-bot/internal/workspace"
)

type fakeRunner struct {
	mu               sync.Mutex
	result           codex.RunResult
	err              error
	delay            time.Duration
	progressMessages []string
	seenSessionIDs   []string
}

func (f *fakeRunner) Run(
	ctx context.Context,
	_ string,
	_ string,
	sessionID string,
	onProgress func(string),
	_ func(string),
) (codex.RunResult, error) {
	f.mu.Lock()
	f.seenSessionIDs = append(f.seenSessionIDs, sessionID)
	progressMessages := append([]string{}, f.progressMessages...)
	result := f.result
	runErr := f.err
	f.mu.Unlock()

	if onProgress != nil {
		if len(progressMessages) == 0 {
			onProgress("progress")
		} else {
			for _, msg := range progressMessages {
				onProgress(msg)
			}
		}
	}
	if f.delay > 0 {
		select {
		case <-ctx.Done():
			return codex.RunResult{}, codex.ErrRunStopped
		case <-time.After(f.delay):
		}
	}
	return result, runErr
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

	svc := NewService(st, wm, &fakeRunner{}, 1000, 10000, 0)
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

	runner := &fakeRunner{
		result: codex.RunResult{
			FinalText:  "done",
			SessionID:  "sess-1",
			TokenUsage: 120,
		},
	}
	svc := NewService(
		st,
		wm,
		runner,
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
		&fakeRunner{
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

func TestHandleUserMessageUsesSameSessionForNextRun(t *testing.T) {
	base := t.TempDir()
	st := store.New(base)
	_ = st.Init()
	wm := workspace.New(base)
	_ = wm.Init()

	runner := &fakeRunner{
		result: codex.RunResult{
			FinalText: "first",
			SessionID: "sess-shared",
		},
	}
	svc := NewService(st, wm, runner, 1000, 1000, 0)
	_, _ = svc.StartChatSession("thread-same-session")

	if _, err := svc.HandleUserMessage(context.Background(), "thread-same-session", "1st", nil); err != nil {
		t.Fatalf("first run err: %v", err)
	}

	runner.mu.Lock()
	runner.result = codex.RunResult{FinalText: "second"}
	runner.mu.Unlock()

	if _, err := svc.HandleUserMessage(context.Background(), "thread-same-session", "2nd", nil); err != nil {
		t.Fatalf("second run err: %v", err)
	}

	runner.mu.Lock()
	defer runner.mu.Unlock()
	if len(runner.seenSessionIDs) != 2 {
		t.Fatalf("session id calls = %d, want 2", len(runner.seenSessionIDs))
	}
	if runner.seenSessionIDs[0] != "" {
		t.Fatalf("first session id = %q, want empty", runner.seenSessionIDs[0])
	}
	if runner.seenSessionIDs[1] != "sess-shared" {
		t.Fatalf("second session id = %q, want sess-shared", runner.seenSessionIDs[1])
	}
}

func TestHandleUserMessageFlushesAllProgressLogs(t *testing.T) {
	base := t.TempDir()
	st := store.New(base)
	_ = st.Init()
	wm := workspace.New(base)
	_ = wm.Init()

	runner := &fakeRunner{
		result: codex.RunResult{FinalText: "done"},
		progressMessages: []string{
			"log-1",
			"log-2",
			"log-3",
		},
	}
	svc := NewService(st, wm, runner, 1000, 1000, 2*time.Second)
	_, _ = svc.StartChatSession("thread-logs")

	received := make([]string, 0, 4)
	_, err := svc.HandleUserMessage(
		context.Background(),
		"thread-logs",
		"hello",
		func(msg string) {
			received = append(received, msg)
		},
	)
	if err != nil {
		t.Fatalf("handle err: %v", err)
	}

	joined := strings.Join(received, "\n")
	for _, want := range []string{"🤖 Codexが考えています...", "log-1", "log-2", "log-3"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("progress missing %q: %q", want, joined)
		}
	}
}
