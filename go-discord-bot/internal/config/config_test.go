package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadUsesDotEnvWhenRequiredEnvIsEmpty(t *testing.T) {
	t.Setenv("DISCORD_TOKEN", "")
	t.Setenv("WORK_BASE_DIR", "")
	t.Setenv("CODEX_LIMIT_5H_TOKENS", "")
	t.Setenv("CODEX_LIMIT_1W_TOKENS", "")

	tmp := t.TempDir()
	content := "" +
		"DISCORD_TOKEN=token_from_env_file\n" +
		"WORK_BASE_DIR=./work\n" +
		"CODEX_LIMIT_5H_TOKENS=100000\n" +
		"CODEX_LIMIT_1W_TOKENS=700000\n"
	if err := os.WriteFile(filepath.Join(tmp, ".env"), []byte(content), 0o644); err != nil {
		t.Fatalf("write .env: %v", err)
	}

	restore := withWorkingDir(t, tmp)
	defer restore()

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if cfg.DiscordToken != "token_from_env_file" {
		t.Fatalf("discord token = %q", cfg.DiscordToken)
	}
	if cfg.CodexLimit5H != 100000 {
		t.Fatalf("limit5h = %d", cfg.CodexLimit5H)
	}
	if cfg.CodexLimit1W != 700000 {
		t.Fatalf("limit1w = %d", cfg.CodexLimit1W)
	}
}

func TestLoadDoesNotOverrideExplicitEnv(t *testing.T) {
	t.Setenv("DISCORD_TOKEN", "token_from_env")
	t.Setenv("WORK_BASE_DIR", "/tmp/work-dir")
	t.Setenv("CODEX_LIMIT_5H_TOKENS", "5000")
	t.Setenv("CODEX_LIMIT_1W_TOKENS", "20000")

	tmp := t.TempDir()
	content := "" +
		"DISCORD_TOKEN=token_from_file\n" +
		"WORK_BASE_DIR=./other\n" +
		"CODEX_LIMIT_5H_TOKENS=1\n" +
		"CODEX_LIMIT_1W_TOKENS=1\n"
	if err := os.WriteFile(filepath.Join(tmp, ".env"), []byte(content), 0o644); err != nil {
		t.Fatalf("write .env: %v", err)
	}

	restore := withWorkingDir(t, tmp)
	defer restore()

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if cfg.DiscordToken != "token_from_env" {
		t.Fatalf("discord token = %q", cfg.DiscordToken)
	}
	if cfg.CodexLimit5H != 5000 {
		t.Fatalf("limit5h = %d", cfg.CodexLimit5H)
	}
	if cfg.CodexLimit1W != 20000 {
		t.Fatalf("limit1w = %d", cfg.CodexLimit1W)
	}
}

func withWorkingDir(t *testing.T, dir string) func() {
	t.Helper()
	prev, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	return func() {
		_ = os.Chdir(prev)
	}
}
