package store

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Store struct {
	baseDir string
	mu      sync.Mutex
}

func New(baseDir string) *Store {
	return &Store{baseDir: baseDir}
}

func (s *Store) Init() error {
	dirs := []string{
		filepath.Join(s.baseDir, "sessions"),
		filepath.Join(s.baseDir, "runs"),
		filepath.Join(s.baseDir, "token_usage"),
		filepath.Join(s.baseDir, "logs", "sessions"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("create dir %s: %w", d, err)
		}
	}
	return nil
}

func (s *Store) SaveSession(session SessionState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	path := s.sessionPath(session.ThreadID)
	return writeJSON(path, session)
}

func (s *Store) LoadSession(threadID string) (*SessionState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	path := s.sessionPath(threadID)
	var out SessionState
	ok, err := readJSON(path, &out)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}
	return &out, nil
}

func (s *Store) SaveRun(run RunState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	path := s.runPath(run.ThreadID)
	return writeJSON(path, run)
}

func (s *Store) LoadRun(threadID string) (*RunState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	path := s.runPath(threadID)
	var out RunState
	ok, err := readJSON(path, &out)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}
	return &out, nil
}

func (s *Store) AppendTokenUsage(event TokenUsageEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	path := filepath.Join(s.baseDir, "token_usage", "usage.jsonl")
	line, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal token usage: %w", err)
	}
	return appendLine(path, string(line))
}

func (s *Store) SumTokenUsageSince(since time.Time) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	path := filepath.Join(s.baseDir, "token_usage", "usage.jsonl")
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, fmt.Errorf("open token usage file: %w", err)
	}
	defer func() { _ = file.Close() }()

	sum := 0
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		raw := strings.TrimSpace(scanner.Text())
		if raw == "" {
			continue
		}
		var e TokenUsageEvent
		if err := json.Unmarshal([]byte(raw), &e); err != nil {
			// 壊れた1行は無視して継続する
			continue
		}
		if !e.TimestampUTC.Before(since) {
			sum += e.Tokens
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, fmt.Errorf("scan token usage file: %w", err)
	}
	return sum, nil
}

func (s *Store) AppendRawLog(sessionKey, runID, line string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	safeSession := sanitizePathSegment(sessionKey)
	safeRun := sanitizePathSegment(runID)
	dir := filepath.Join(s.baseDir, "logs", "sessions", safeSession)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create session log dir: %w", err)
	}
	path := filepath.Join(dir, safeRun+".jsonl")
	return appendLine(path, line)
}

func (s *Store) sessionPath(threadID string) string {
	return filepath.Join(s.baseDir, "sessions", sanitizePathSegment(threadID)+".json")
}

func (s *Store) runPath(threadID string) string {
	return filepath.Join(s.baseDir, "runs", sanitizePathSegment(threadID)+".json")
}

func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal json: %w", err)
	}
	return os.WriteFile(path, data, 0o644)
}

func readJSON(path string, out any) (bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("read file %s: %w", path, err)
	}
	if err := json.Unmarshal(data, out); err != nil {
		return false, fmt.Errorf("unmarshal file %s: %w", path, err)
	}
	return true, nil
}

func appendLine(path, line string) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open append file %s: %w", path, err)
	}
	defer func() { _ = file.Close() }()
	if _, err := file.WriteString(line + "\n"); err != nil {
		return fmt.Errorf("append line: %w", err)
	}
	return nil
}

func sanitizePathSegment(v string) string {
	var b strings.Builder
	for _, r := range v {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_' || r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	out := b.String()
	if out == "" {
		return "unknown"
	}
	return out
}
