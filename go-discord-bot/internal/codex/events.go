package codex

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

var sessionIDPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bcodex\b(?:\s+\S+)*\s+resume\s+([0-9a-z][0-9a-z-]{8,})\b`),
	regexp.MustCompile(`(?i)\bsession(?:[_\s-]*id)?\s*[:=]\s*([0-9a-z][0-9a-z-]{8,})\b`),
	regexp.MustCompile(`(?i)\bthread(?:[_\s-]*id)?\s*[:=]\s*([0-9a-z][0-9a-z-]{8,})\b`),
}

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
		return ParseOutcome{
			Progress:  line,
			SessionID: extractSessionIDFromText(line),
		}
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

	out.Progress = extractProgress(root, evType)
	return out
}

func extractProgress(root map[string]any, evType string) string {
	item := asMap(root["item"])
	itemType := extractItemType(evType, item)

	if cmd := extractCommandString(root); cmd != "" {
		if txt := extractCommandOutputText(root, itemType); txt == "" {
			return formatCommandMessage(cmd, extractShellName(root))
		}
	}

	if txt := extractCommandOutputText(root, itemType); txt != "" {
		icon := "✅"
		if itemIsError(item) {
			icon = "❌"
		}
		return fmt.Sprintf("%s **ツール実行結果:**\n%s", icon, fenceText("", txt))
	}

	text := extractGeneralProgressText(root)
	if text == "" {
		return ""
	}
	if itemType == "reasoning" {
		return "🤔 " + text
	}
	return text
}

func extractGeneralProgressText(root map[string]any) string {
	candidates := []any{
		root["item"],
		root["delta"],
		root["content"],
		root["message"],
		root["command_output"],
	}
	for _, candidate := range candidates {
		if txt := renderUnknownText(candidate); txt != "" {
			return txt
		}
	}
	return ""
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
	if sid := normalizeSessionID(asString(root["session_id"])); sid != "" {
		return sid
	}
	if session := asMap(root["session"]); session != nil {
		if sid := normalizeSessionID(asString(session["id"])); sid != "" {
			return sid
		}
	}
	if item := asMap(root["item"]); item != nil {
		if sid := normalizeSessionID(asString(item["session_id"])); sid != "" {
			return sid
		}
	}

	if sid := findSessionIDRecursive(root, 0); sid != "" {
		return sid
	}

	if sid := extractSessionIDFromText(renderUnknownText(root)); sid != "" {
		return sid
	}
	return ""
}

func findSessionIDRecursive(v any, depth int) string {
	if v == nil || depth > 8 {
		return ""
	}

	switch t := v.(type) {
	case map[string]any:
		if sid := normalizeSessionID(asString(t["session_id"])); sid != "" {
			return sid
		}
		if session := asMap(t["session"]); session != nil {
			if sid := normalizeSessionID(asString(session["id"])); sid != "" {
				return sid
			}
		}
		for _, value := range t {
			if sid := findSessionIDRecursive(value, depth+1); sid != "" {
				return sid
			}
		}
	case []any:
		for _, value := range t {
			if sid := findSessionIDRecursive(value, depth+1); sid != "" {
				return sid
			}
		}
	case string:
		if sid := extractSessionIDFromText(t); sid != "" {
			return sid
		}
	}
	return ""
}

func extractSessionIDFromText(text string) string {
	if strings.TrimSpace(text) == "" {
		return ""
	}
	for _, p := range sessionIDPatterns {
		matches := p.FindAllStringSubmatch(text, -1)
		for _, m := range matches {
			if len(m) < 2 {
				continue
			}
			if sid := normalizeSessionID(m[1]); sid != "" {
				return sid
			}
		}
	}
	return ""
}

func normalizeSessionID(v string) string {
	v = strings.TrimSpace(v)
	v = strings.Trim(v, ",.\"'`()[]{}")
	if len(v) < 8 {
		return ""
	}
	return v
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

func extractItemType(evType string, item map[string]any) string {
	if item != nil {
		if t := asString(item["type"]); t != "" {
			return t
		}
	}
	if strings.HasPrefix(evType, "item.") {
		remainder := strings.TrimPrefix(evType, "item.")
		if remainder == "" {
			return ""
		}
		parts := strings.Split(remainder, ".")
		if len(parts) > 0 {
			return parts[0]
		}
	}
	return ""
}

func extractCommandOutputText(root map[string]any, itemType string) string {
	candidates := []any{
		root["command_output"],
		nestedValue(root, "delta", "command_output"),
		nestedValue(root, "item", "command_output"),
	}
	if isCommandLikeItem(itemType) {
		candidates = append(candidates, root["delta"], root["item"])
	}

	for _, candidate := range candidates {
		if txt := renderUnknownText(candidate); txt != "" {
			return txt
		}
	}
	return ""
}

func extractCommandString(root map[string]any) string {
	candidates := []any{
		nestedValue(root, "delta", "command"),
		nestedValue(root, "delta", "command_line"),
		nestedValue(root, "delta", "commandLine"),
		nestedValue(root, "delta", "command_args"),
		nestedValue(root, "delta", "command_output", "command"),
		nestedValue(root, "command_output", "command"),
		nestedValue(root, "item", "command"),
		nestedValue(root, "item", "command_line"),
		nestedValue(root, "item", "commandLine"),
		nestedValue(root, "item", "command_args"),
		root["command"],
		root["command_line"],
		root["commandLine"],
	}

	for _, candidate := range candidates {
		if cmd := normalizeCommandCandidate(candidate); cmd != "" {
			return cmd
		}
	}
	return ""
}

func normalizeCommandCandidate(value any) string {
	switch t := value.(type) {
	case string:
		return strings.TrimSpace(t)
	case []any:
		parts := make([]string, 0, len(t))
		for _, token := range t {
			part := normalizeCommandCandidate(token)
			if part != "" {
				parts = append(parts, part)
			}
		}
		return strings.TrimSpace(strings.Join(parts, " "))
	case map[string]any:
		keys := []string{"command", "command_line", "commandLine", "command_args", "argv"}
		for _, key := range keys {
			if v, ok := t[key]; ok {
				if cmd := normalizeCommandCandidate(v); cmd != "" {
					return cmd
				}
			}
		}
	}
	return ""
}

func extractShellName(root map[string]any) string {
	candidates := []any{
		nestedValue(root, "delta", "shell"),
		nestedValue(root, "delta", "command_output", "shell"),
		nestedValue(root, "command_output", "shell"),
		nestedValue(root, "item", "shell"),
	}
	for _, c := range candidates {
		if shell := strings.TrimSpace(asString(c)); shell != "" {
			return shell
		}
	}
	return ""
}

func formatCommandMessage(command, shell string) string {
	language := "bash"
	if strings.EqualFold(shell, "fish") {
		language = "fish"
	}
	label := ""
	if strings.TrimSpace(shell) != "" {
		label = " (" + strings.TrimSpace(shell) + ")"
	}
	return fmt.Sprintf("💻 **Command%s:**\n%s", label, fenceText(language, command))
}

func fenceText(language, content string) string {
	content = strings.ReplaceAll(content, "```", "``\\u200b`")
	if strings.TrimSpace(content) == "" {
		content = "(空の結果)"
	}
	if language == "" {
		return "```\n" + content + "\n```"
	}
	return "```" + language + "\n" + content + "\n```"
}

func itemIsError(item map[string]any) bool {
	if item == nil {
		return false
	}
	v, ok := item["is_error"]
	if !ok {
		return false
	}
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return strings.EqualFold(strings.TrimSpace(t), "true")
	default:
		return false
	}
}

func isCommandLikeItem(itemType string) bool {
	normalized := strings.ToLower(strings.TrimSpace(itemType))
	return strings.Contains(normalized, "command_output") ||
		strings.Contains(normalized, "command_result") ||
		normalized == "tool_result" ||
		normalized == "tool_response"
}

func nestedValue(root map[string]any, path ...string) any {
	var current any = root
	for _, p := range path {
		m, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		v, ok := m[p]
		if !ok {
			return nil
		}
		current = v
	}
	return current
}

func asMap(v any) map[string]any {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	return m
}

func asString(v any) string {
	s, _ := v.(string)
	return s
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
