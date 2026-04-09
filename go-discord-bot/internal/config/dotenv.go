package config

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

func loadDotEnvIfNeeded(required []string) error {
	needsDotEnv := false
	for _, key := range required {
		if strings.TrimSpace(os.Getenv(key)) == "" {
			needsDotEnv = true
			break
		}
	}
	if !needsDotEnv {
		return nil
	}

	pairs, err := parseDotEnvFile(".env")
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for k, v := range pairs {
		if strings.TrimSpace(os.Getenv(k)) == "" {
			_ = os.Setenv(k, v)
		}
	}
	return nil
}

func parseDotEnvFile(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	out := make(map[string]string)
	scanner := bufio.NewScanner(f)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}

		idx := strings.IndexRune(line, '=')
		if idx <= 0 {
			return nil, fmt.Errorf(".env parse error at line %d", lineNo)
		}

		key := strings.TrimSpace(line[:idx])
		value := strings.TrimSpace(line[idx+1:])
		value = trimQuotes(value)
		out[key] = value
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func trimQuotes(v string) string {
	if len(v) < 2 {
		return v
	}
	if (strings.HasPrefix(v, "\"") && strings.HasSuffix(v, "\"")) ||
		(strings.HasPrefix(v, "'") && strings.HasSuffix(v, "'")) {
		return v[1 : len(v)-1]
	}
	return v
}
