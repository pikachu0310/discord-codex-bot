package session

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/pikachu0310/discord-codex-bot/go-discord-bot/internal/codex"
	"github.com/pikachu0310/discord-codex-bot/go-discord-bot/internal/store"
	"github.com/pikachu0310/discord-codex-bot/go-discord-bot/internal/workspace"
)

var (
	ErrSessionNotFound = errors.New("session not found")
	ErrRunInProgress   = errors.New("run already in progress")
)

type Service struct {
	store            *store.Store
	workspaceManager *workspace.Manager
	runner           codex.Runner
	limit5h          int
	limit1w          int
	progressInterval time.Duration

	mu     sync.Mutex
	active map[string]context.CancelFunc
}

type Status struct {
	Mode             store.SessionMode
	Repository       string
	RunState         store.RunStatus
	CodexSessionID   string
	Remaining5HRate  int
	Remaining1WRate  int
	Usage5H          int
	Usage1W          int
	TokenLimit5H     int
	TokenLimit1W     int
	WorkspacePath    string
	SessionUpdatedAt time.Time
}

func NewService(
	st *store.Store,
	wm *workspace.Manager,
	runner codex.Runner,
	limit5h int,
	limit1w int,
	progressInterval time.Duration,
) *Service {
	return &Service{
		store:            st,
		workspaceManager: wm,
		runner:           runner,
		limit5h:          limit5h,
		limit1w:          limit1w,
		progressInterval: progressInterval,
		active:           map[string]context.CancelFunc{},
	}
}

func (s *Service) StartChatSession(threadID string) (*store.SessionState, error) {
	existing, err := s.store.LoadSession(threadID)
	if err != nil {
		return nil, err
	}
	if existing != nil && existing.Status == store.SessionStatusActive {
		return existing, nil
	}

	workspacePath, err := s.workspaceManager.EnsureChatWorkspace(threadID)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	session := store.SessionState{
		ThreadID:      threadID,
		Mode:          store.SessionModeChat,
		WorkspacePath: workspacePath,
		Status:        store.SessionStatusActive,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := s.store.SaveSession(session); err != nil {
		return nil, err
	}
	if err := s.store.SaveRun(store.RunState{
		ThreadID:      threadID,
		Status:        store.RunStatusIdle,
		LastUpdatedAt: now,
	}); err != nil {
		return nil, err
	}
	return &session, nil
}

func (s *Service) StartRepoSession(threadID, repoSpec string) (*store.SessionState, error) {
	repo, err := workspace.ParseRepository(repoSpec)
	if err != nil {
		return nil, err
	}
	cachePath, _, err := s.workspaceManager.EnsureRepositoryCache(repo)
	if err != nil {
		return nil, err
	}
	workspacePath, err := s.workspaceManager.EnsureRepoWorkspace(threadID, cachePath)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	session := store.SessionState{
		ThreadID:      threadID,
		Mode:          store.SessionModeRepo,
		Repository:    repo.FullName,
		WorkspacePath: workspacePath,
		Status:        store.SessionStatusActive,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := s.store.SaveSession(session); err != nil {
		return nil, err
	}
	if err := s.store.SaveRun(store.RunState{
		ThreadID:      threadID,
		Status:        store.RunStatusIdle,
		LastUpdatedAt: now,
	}); err != nil {
		return nil, err
	}
	return &session, nil
}

func (s *Service) HandleUserMessage(
	ctx context.Context,
	threadID string,
	prompt string,
	onProgress func(string),
) (string, error) {
	session, err := s.store.LoadSession(threadID)
	if err != nil {
		return "", err
	}
	if session == nil || session.Status != store.SessionStatusActive {
		return "", ErrSessionNotFound
	}

	if strings.TrimSpace(prompt) == "" {
		return "", errors.New("empty prompt")
	}

	s.mu.Lock()
	if _, exists := s.active[threadID]; exists {
		s.mu.Unlock()
		return "", ErrRunInProgress
	}
	runCtx, cancel := context.WithCancel(ctx)
	s.active[threadID] = cancel
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.active, threadID)
		s.mu.Unlock()
	}()

	runID := fmt.Sprintf("%d", time.Now().UnixNano())
	started := time.Now().UTC()
	runState := store.RunState{
		ThreadID:      threadID,
		LastRunID:     runID,
		Status:        store.RunStatusRunning,
		Prompt:        prompt,
		StartedAt:     started,
		LastUpdatedAt: started,
	}
	if err := s.store.SaveRun(runState); err != nil {
		return "", err
	}

	if onProgress != nil {
		onProgress("🤖 Codexが考えています...")
	}

	lastSent := time.Time{}
	sendProgress := func(msg string) {
		if onProgress == nil {
			return
		}
		now := time.Now()
		if lastSent.IsZero() || now.Sub(lastSent) >= s.progressInterval {
			onProgress(msg)
			lastSent = now
		}
	}

	sessionKey := session.CodexSessionID
	if sessionKey == "" {
		sessionKey = threadID
	}

	result, runErr := s.runner.Run(
		runCtx,
		session.WorkspacePath,
		prompt,
		session.CodexSessionID,
		sendProgress,
		func(line string) {
			_ = s.store.AppendRawLog(sessionKey, runID, line)
		},
	)

	ended := time.Now().UTC()
	runState.EndedAt = ended
	runState.LastUpdatedAt = ended

	if runErr != nil {
		if errors.Is(runErr, codex.ErrRunStopped) {
			runState.Status = store.RunStatusStopped
			runState.ErrorSummary = runErr.Error()
			_ = s.store.SaveRun(runState)
			return "⛔ Codex Codeの実行を中断しました\n\n💡 新しい指示を送信して作業を続けることができます", nil
		}
		runState.Status = store.RunStatusFailed
		runState.ErrorSummary = runErr.Error()
		_ = s.store.SaveRun(runState)
		return "", runErr
	}

	runState.Status = store.RunStatusSucceeded
	runState.ExitCode = 0
	if err := s.store.SaveRun(runState); err != nil {
		return "", err
	}

	if result.SessionID != "" && result.SessionID != session.CodexSessionID {
		session.CodexSessionID = result.SessionID
		session.UpdatedAt = time.Now().UTC()
		if err := s.store.SaveSession(*session); err != nil {
			return "", err
		}
	}

	if result.TokenUsage > 0 {
		_ = s.store.AppendTokenUsage(store.TokenUsageEvent{
			TimestampUTC: time.Now().UTC(),
			Tokens:       result.TokenUsage,
		})
	}
	return result.FinalText, nil
}

func (s *Service) Stop(threadID string) (bool, error) {
	s.mu.Lock()
	cancel, ok := s.active[threadID]
	s.mu.Unlock()
	if !ok {
		return false, nil
	}
	cancel()
	return true, nil
}

func (s *Service) Status(threadID string) (Status, error) {
	session, err := s.store.LoadSession(threadID)
	if err != nil {
		return Status{}, err
	}
	if session == nil {
		return Status{}, ErrSessionNotFound
	}

	run, err := s.store.LoadRun(threadID)
	if err != nil {
		return Status{}, err
	}
	runState := store.RunStatusIdle
	if run != nil {
		runState = run.Status
	}

	now := time.Now().UTC()
	usage5h, err := s.store.SumTokenUsageSince(now.Add(-5 * time.Hour))
	if err != nil {
		return Status{}, err
	}
	usage1w, err := s.store.SumTokenUsageSince(now.Add(-7 * 24 * time.Hour))
	if err != nil {
		return Status{}, err
	}

	return Status{
		Mode:             session.Mode,
		Repository:       session.Repository,
		RunState:         runState,
		CodexSessionID:   session.CodexSessionID,
		Remaining5HRate:  remainingRate(usage5h, s.limit5h),
		Remaining1WRate:  remainingRate(usage1w, s.limit1w),
		Usage5H:          usage5h,
		Usage1W:          usage1w,
		TokenLimit5H:     s.limit5h,
		TokenLimit1W:     s.limit1w,
		WorkspacePath:    session.WorkspacePath,
		SessionUpdatedAt: session.UpdatedAt,
	}, nil
}

func remainingRate(used, limit int) int {
	if limit <= 0 {
		return 0
	}
	remaining := ((limit - used) * 100) / limit
	if remaining < 0 {
		return 0
	}
	if remaining > 100 {
		return 100
	}
	return remaining
}
