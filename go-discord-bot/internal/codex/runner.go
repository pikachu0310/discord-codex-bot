package codex

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

var ErrRunStopped = errors.New("codex run stopped")

type Runner interface {
	Run(
		ctx context.Context,
		cwd string,
		prompt string,
		sessionID string,
		onProgress func(string),
		onRawLine func(string),
	) (RunResult, error)
}

type CommandRunner struct {
	Binary           string
	TerminationGrace time.Duration
}

type RunResult struct {
	FinalText  string
	SessionID  string
	TokenUsage int
}

func NewCommandRunner() *CommandRunner {
	return &CommandRunner{
		Binary:           "codex",
		TerminationGrace: 5 * time.Second,
	}
}

func BuildArgs(prompt, sessionID string) []string {
	args := []string{
		"--search",
		"exec",
		"--json",
		"--color",
		"never",
		"--dangerously-bypass-approvals-and-sandbox",
	}
	if sessionID != "" {
		args = append(args, "resume", sessionID, prompt)
		return args
	}
	args = append(args, prompt)
	return args
}

func (r *CommandRunner) Run(
	ctx context.Context,
	cwd string,
	prompt string,
	sessionID string,
	onProgress func(string),
	onRawLine func(string),
) (RunResult, error) {
	args := BuildArgs(prompt, sessionID)
	cmd := exec.Command(r.Binary, args...)
	cmd.Dir = cwd

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return RunResult{}, fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return RunResult{}, fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return RunResult{}, fmt.Errorf("start codex: %w", err)
	}

	var (
		res      RunResult
		errMu    sync.Mutex
		stderrSB strings.Builder
		wg       sync.WaitGroup
	)

	wg.Add(2)
	go func() {
		defer wg.Done()
		scanLines(stdout, func(line string) {
			if onRawLine != nil {
				onRawLine(line)
			}
			out := ParseEventLine(line)
			if out.Tokens > 0 {
				res.TokenUsage += out.Tokens
			}
			if out.SessionID != "" {
				res.SessionID = out.SessionID
			}
			if out.Final != "" {
				res.FinalText = out.Final
			}
			if out.Progress != "" && onProgress != nil {
				onProgress(out.Progress)
			}
		})
	}()

	go func() {
		defer wg.Done()
		scanLines(stderr, func(line string) {
			errMu.Lock()
			if stderrSB.Len() < 64*1024 {
				stderrSB.WriteString(line)
				stderrSB.WriteRune('\n')
			}
			errMu.Unlock()
		})
	}()

	waitCh := make(chan error, 1)
	go func() {
		waitCh <- cmd.Wait()
	}()

	select {
	case err := <-waitCh:
		wg.Wait()
		if err != nil {
			errMu.Lock()
			errText := strings.TrimSpace(stderrSB.String())
			errMu.Unlock()
			if errText != "" {
				return RunResult{}, fmt.Errorf("codex failed: %w: %s", err, errText)
			}
			return RunResult{}, fmt.Errorf("codex failed: %w", err)
		}
	case <-ctx.Done():
		_ = signalTerminate(cmd.Process)
		select {
		case <-time.After(r.TerminationGrace):
			_ = cmd.Process.Kill()
		case <-waitCh:
		}
		wg.Wait()
		return RunResult{}, ErrRunStopped
	}

	if strings.TrimSpace(res.FinalText) == "" {
		res.FinalText = "完了しました。"
	}
	return res, nil
}

func signalTerminate(p *os.Process) error {
	if p == nil {
		return nil
	}
	return p.Signal(syscall.SIGTERM)
}

func scanLines(r io.Reader, fn func(string)) {
	scanner := bufio.NewScanner(r)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)
	for scanner.Scan() {
		fn(scanner.Text())
	}
}
