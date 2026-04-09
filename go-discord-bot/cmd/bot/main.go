package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"

	"github.com/pikachu0310/discord-codex-bot/go-discord-bot/internal/codex"
	"github.com/pikachu0310/discord-codex-bot/go-discord-bot/internal/config"
	"github.com/pikachu0310/discord-codex-bot/go-discord-bot/internal/discord"
	"github.com/pikachu0310/discord-codex-bot/go-discord-bot/internal/session"
	"github.com/pikachu0310/discord-codex-bot/go-discord-bot/internal/store"
	"github.com/pikachu0310/discord-codex-bot/go-discord-bot/internal/workspace"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	st := store.New(cfg.WorkBaseDir)
	if err := st.Init(); err != nil {
		log.Fatalf("failed to init store: %v", err)
	}

	wm := workspace.New(cfg.WorkBaseDir)
	if err := wm.Init(); err != nil {
		log.Fatalf("failed to init workspace: %v", err)
	}

	runner := codex.NewCommandRunner()
	runner.TerminationGrace = cfg.StopTimeout

	svc := session.NewService(
		st,
		wm,
		runner,
		cfg.CodexLimit5H,
		cfg.CodexLimit1W,
		cfg.ProgressInterval,
	)

	bot, err := discord.New(cfg.DiscordToken, svc, cfg.MessageChunkLength)
	if err != nil {
		log.Fatalf("failed to create discord bot: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log.Println("go-discord-bot starting...")
	if err := bot.Run(ctx); err != nil {
		log.Fatalf("discord bot stopped with error: %v", err)
	}
	log.Println("go-discord-bot stopped")
}
