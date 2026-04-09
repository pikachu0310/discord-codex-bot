package store

import "time"

type SessionMode string

const (
	SessionModeChat SessionMode = "chat"
	SessionModeRepo SessionMode = "repo"
)

type SessionStatus string

const (
	SessionStatusActive SessionStatus = "active"
	SessionStatusClosed SessionStatus = "closed"
)

type SessionState struct {
	ThreadID       string        `json:"thread_id"`
	Mode           SessionMode   `json:"mode"`
	Repository     string        `json:"repository,omitempty"`
	WorkspacePath  string        `json:"workspace_path"`
	CodexSessionID string        `json:"codex_session_id,omitempty"`
	Status         SessionStatus `json:"status"`
	CreatedAt      time.Time     `json:"created_at"`
	UpdatedAt      time.Time     `json:"updated_at"`
}

type RunStatus string

const (
	RunStatusIdle      RunStatus = "idle"
	RunStatusRunning   RunStatus = "running"
	RunStatusSucceeded RunStatus = "succeeded"
	RunStatusFailed    RunStatus = "failed"
	RunStatusStopped   RunStatus = "stopped"
)

type RunState struct {
	ThreadID      string    `json:"thread_id"`
	LastRunID     string    `json:"last_run_id,omitempty"`
	Status        RunStatus `json:"status"`
	Prompt        string    `json:"prompt,omitempty"`
	ExitCode      int       `json:"exit_code,omitempty"`
	ErrorSummary  string    `json:"error_summary,omitempty"`
	StartedAt     time.Time `json:"started_at,omitempty"`
	EndedAt       time.Time `json:"ended_at,omitempty"`
	LastUpdatedAt time.Time `json:"last_updated_at"`
}

type TokenUsageEvent struct {
	TimestampUTC time.Time `json:"timestamp_utc"`
	Tokens       int       `json:"tokens"`
}
