package codex

import (
	"encoding/json"
	"fmt"
	"strings"
)

type ParseOutcome struct {
	Progress  string
	Final     string
	SessionID string
	Tokens    int
}

func ParseEventLine(line string) ParseOutcome {
	line = strings.TrimSpace(line)
	if line == "" {
		return ParseOutcome{}
	}

	var root map[string]any
	if err := json.Unmarshal([]byte(line), &root); err != nil {
		return ParseOutcome{Progress: line}
	}

	out := ParseOutcome{
		SessionID: extractSessionID(root),
		Tokens:    extractTokens(root),
	}

	evType, _ := root["type"].(string)

	if evType == "response.error" {
		if msg := extractErrorMessage(root); msg != "" {
			out.Progress = "❌ Codexエラー: " + msg
			return out
		}
	}

	if evType == "turn.completed" || evType == "response.completed" {
		out.Final = extractFinalText(root)
		return out
	}

	if evType == "result" {
		if result, ok := root["result"].(string); ok && strings.TrimSpace(result) != "" {
			out.Final = result
			return out
		}
	}

	progress := extractProgressText(root)
	if evType == "item.completed" {
		if item, ok := root["item"].(map[string]any); ok {
			if t, _ := item["type"].(string); t == "reasoning" && progress != "" {
				progress = "🤔 " + progress
			}
		}
	}
	out.Progress = progress
	return out
}

func extractErrorMessage(root map[string]any) string {
	if errObj, ok := root["error"].(map[string]any); ok {
		if msg, _ := errObj["message"].(string); msg != "" {
			return msg
		}
	}
	return ""
}

func extractFinalText(root map[string]any) string {
	if result, _ := root["result"].(string); strings.TrimSpace(result) != "" {
		return result
	}

	if resp, ok := root["response"].(map[string]any); ok {
		if txt := renderUnknownText(resp["output_text"]); txt != "" {
			return txt
		}
	}
	return renderUnknownText(root)
}

func extractProgressText(root map[string]any) string {
	if item, ok := root["item"].(map[string]any); ok {
		if txt := renderUnknownText(item); txt != "" {
			return txt
		}
	}
	if cmdOut, ok := root["command_output"].(map[string]any); ok {
		if txt := renderUnknownText(cmdOut); txt != "" {
			return txt
		}
	}
	return renderUnknownText(root)
}

func renderUnknownText(v any) string {
	parts := make([]string, 0, 8)
	visit(v, &parts, 0)
	if len(parts) == 0 {
		return ""
	}
	out := strings.TrimSpace(strings.Join(parts, ""))
	return out
}

func visit(v any, parts *[]string, depth int) {
	if depth > 6 || v == nil {
		return
	}

	switch t := v.(type) {
	case string:
		if strings.TrimSpace(t) != "" {
			*parts = append(*parts, t)
		}
	case float64:
		*parts = append(*parts, fmt.Sprintf("%.0f", t))
	case []any:
		for _, x := range t {
			visit(x, parts, depth+1)
		}
	case map[string]any:
		keys := []string{
			"text",
			"text_delta",
			"stdout",
			"stdout_delta",
			"stderr",
			"stderr_delta",
			"message",
			"result",
			"data",
			"output_text",
			"content",
			"delta",
		}
		for _, key := range keys {
			if value, ok := t[key]; ok {
				visit(value, parts, depth+1)
			}
		}
	}
}

func extractSessionID(root map[string]any) string {
	if sid, _ := root["session_id"].(string); sid != "" {
		return sid
	}
	if session, ok := root["session"].(map[string]any); ok {
		if sid, _ := session["id"].(string); sid != "" {
			return sid
		}
	}
	if item, ok := root["item"].(map[string]any); ok {
		if sid, _ := item["session_id"].(string); sid != "" {
			return sid
		}
	}
	return ""
}

func extractTokens(root map[string]any) int {
	var usage map[string]any
	if u, ok := root["usage"].(map[string]any); ok {
		usage = u
	}
	if usage == nil {
		if message, ok := root["message"].(map[string]any); ok {
			if u, ok := message["usage"].(map[string]any); ok {
				usage = u
			}
		}
	}
	if usage == nil {
		return 0
	}

	return toInt(usage["input_tokens"]) +
		toInt(usage["cache_creation_input_tokens"]) +
		toInt(usage["cache_read_input_tokens"]) +
		toInt(usage["output_tokens"])
}

func toInt(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case int64:
		return int(t)
	default:
		return 0
	}
}
