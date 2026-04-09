package codex

import (
	"strings"
	"testing"
)

func TestBuildArgs(t *testing.T) {
	args := BuildArgs("hello", "")
	got := joinArgs(args)
	want := "--search exec --json --color never --dangerously-bypass-approvals-and-sandbox hello"
	if got != want {
		t.Fatalf("args mismatch\n got: %s\nwant: %s", got, want)
	}

	argsResume := BuildArgs("next", "sess-1")
	gotResume := joinArgs(argsResume)
	wantResume := "--search exec --json --color never --dangerously-bypass-approvals-and-sandbox resume sess-1 next"
	if gotResume != wantResume {
		t.Fatalf("resume args mismatch\n got: %s\nwant: %s", gotResume, wantResume)
	}
}

func TestParseEventLineFinalAndUsage(t *testing.T) {
	line := `{"type":"response.completed","session_id":"sess-123","response":{"output_text":"done"},"usage":{"input_tokens":10,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":5}}`
	out := ParseEventLine(line)
	if out.Final != "done" {
		t.Fatalf("final = %q, want done", out.Final)
	}
	if out.SessionID != "sess-123" {
		t.Fatalf("session id = %q", out.SessionID)
	}
	if out.Tokens != 20 {
		t.Fatalf("tokens = %d, want 20", out.Tokens)
	}
}

func TestParseEventLineNonJSON(t *testing.T) {
	out := ParseEventLine("plain text output")
	if out.Progress == "" {
		t.Fatal("expected plain text progress")
	}
}

func TestParseEventLineCommandMetadata(t *testing.T) {
	line := `{"type":"item.command_output.started","item":{"type":"command_output","command":["bash","-lc","ls -la"],"shell":"bash"},"session_id":"sess-123"}`
	out := ParseEventLine(line)
	if out.Progress == "" {
		t.Fatal("expected command progress")
	}
	if !containsAll(out.Progress, []string{"💻 **Command", "```bash", "ls -la"}) {
		t.Fatalf("unexpected progress: %q", out.Progress)
	}
}

func TestParseEventLineCommandOutput(t *testing.T) {
	line := `{"type":"item.command_output.delta","item":{"type":"command_output","is_error":false},"delta":{"command_output":{"stdout_delta":"Running tests..."}},"session_id":"sess-123"}`
	out := ParseEventLine(line)
	if !containsAll(out.Progress, []string{"✅ **ツール実行結果:**", "Running tests..."}) {
		t.Fatalf("unexpected progress: %q", out.Progress)
	}
}

func TestParseEventLineSessionFromText(t *testing.T) {
	line := `codex --search exec --json --color never --dangerously-bypass-approvals-and-sandbox resume session-abc12345 prompt`
	out := ParseEventLine(line)
	if out.SessionID != "session-abc12345" {
		t.Fatalf("session id = %q, want session-abc12345", out.SessionID)
	}
}

func joinArgs(v []string) string {
	out := ""
	for i, p := range v {
		if i > 0 {
			out += " "
		}
		out += p
	}
	return out
}

func containsAll(text string, parts []string) bool {
	for _, p := range parts {
		if !strings.Contains(text, p) {
			return false
		}
	}
	return true
}
