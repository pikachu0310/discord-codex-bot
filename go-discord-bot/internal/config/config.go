package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

type Config struct {
	DiscordToken       string
	WorkBaseDir        string
	CodexLimit5H       int
	CodexLimit1W       int
	ProgressInterval   time.Duration
	MessageChunkLength int
	StopTimeout        time.Duration
}

func Load() (Config, error) {
	token := os.Getenv("DISCORD_TOKEN")
	if token == "" {
		return Config{}, errors.New("DISCORD_TOKEN is required")
	}

	base := os.Getenv("WORK_BASE_DIR")
	if base == "" {
		return Config{}, errors.New("WORK_BASE_DIR is required")
	}
	base = filepath.Clean(base)

	limit5h, err := requirePositiveInt("CODEX_LIMIT_5H_TOKENS")
	if err != nil {
		return Config{}, err
	}
	limit1w, err := requirePositiveInt("CODEX_LIMIT_1W_TOKENS")
	if err != nil {
		return Config{}, err
	}

	return Config{
		DiscordToken:       token,
		WorkBaseDir:        base,
		CodexLimit5H:       limit5h,
		CodexLimit1W:       limit1w,
		ProgressInterval:   2 * time.Second,
		MessageChunkLength: 1500,
		StopTimeout:        5 * time.Second,
	}, nil
}

func requirePositiveInt(name string) (int, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return 0, fmt.Errorf("%s is required", name)
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v <= 0 {
		return 0, fmt.Errorf("%s must be positive integer", name)
	}
	return v, nil
}
