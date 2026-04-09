package codex

import "testing"

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
