package discord

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"
	"github.com/pikachu0310/discord-codex-bot/go-discord-bot/internal/session"
)

type Bot struct {
	dg               *discordgo.Session
	service          *session.Service
	messageChunkSize int
}

func New(token string, service *session.Service, messageChunkSize int) (*Bot, error) {
	dg, err := discordgo.New("Bot " + token)
	if err != nil {
		return nil, err
	}
	dg.Identify.Intents = discordgo.IntentsGuilds |
		discordgo.IntentsGuildMessages |
		discordgo.IntentsMessageContent |
		discordgo.IntentsGuildMessageReactions
	return &Bot{
		dg:               dg,
		service:          service,
		messageChunkSize: messageChunkSize,
	}, nil
}

func (b *Bot) Run(ctx context.Context) error {
	b.dg.AddHandler(b.onReady)
	b.dg.AddHandler(b.onInteractionCreate)
	b.dg.AddHandler(b.onMessageCreate)

	if err := b.dg.Open(); err != nil {
		return err
	}
	defer func() { _ = b.dg.Close() }()

	<-ctx.Done()
	return nil
}

func (b *Bot) onReady(s *discordgo.Session, r *discordgo.Ready) {
	commands := []*discordgo.ApplicationCommand{
		{
			Name:        "chat",
			Description: "新しいチャットスレッドを開始します",
		},
		{
			Name:        "start",
			Description: "リポジトリを指定して作業スレッドを開始します",
			Options: []*discordgo.ApplicationCommandOption{
				{
					Name:        "repository",
					Description: "owner/repo",
					Type:        discordgo.ApplicationCommandOptionString,
					Required:    true,
				},
			},
		},
		{
			Name:        "stop",
			Description: "実行中のCodexを中断します",
		},
		{
			Name:        "status",
			Description: "このスレッドの状態と残トークン割合を表示します",
		},
	}
	if _, err := s.ApplicationCommandBulkOverwrite(r.Application.ID, "", commands); err != nil {
		log.Printf("failed to register commands: %v", err)
	}
}

func (b *Bot) onInteractionCreate(s *discordgo.Session, i *discordgo.InteractionCreate) {
	if i.Type != discordgo.InteractionApplicationCommand {
		return
	}

	data := i.ApplicationCommandData()
	switch data.Name {
	case "chat":
		b.handleChatCommand(s, i)
	case "start":
		b.handleStartCommand(s, i)
	case "stop":
		b.handleStopCommand(s, i)
	case "status":
		b.handleStatusCommand(s, i)
	}
}

func (b *Bot) handleChatCommand(s *discordgo.Session, i *discordgo.InteractionCreate) {
	if err := b.deferResponse(s, i); err != nil {
		return
	}
	threadID, mention, err := b.ensureThread(s, i, "chat")
	if err != nil {
		b.editResponseText(s, i, "スレッド作成に失敗しました。")
		return
	}
	if _, err := b.service.StartChatSession(threadID); err != nil {
		b.editResponseText(s, i, "セッション作成に失敗しました。")
		return
	}
	b.editResponseText(s, i, fmt.Sprintf("✅ チャットセッションを開始しました: %s", mention))
	_, _ = s.ChannelMessageSend(threadID, "準備完了です。指示を送ってください。")
}

func (b *Bot) handleStartCommand(s *discordgo.Session, i *discordgo.InteractionCreate) {
	if err := b.deferResponse(s, i); err != nil {
		return
	}
	repo := optionString(i.ApplicationCommandData().Options, "repository")
	threadID, mention, err := b.ensureThread(s, i, repo)
	if err != nil {
		b.editResponseText(s, i, "スレッド作成に失敗しました。")
		return
	}
	if _, err := b.service.StartRepoSession(threadID, repo); err != nil {
		b.editResponseText(s, i, fmt.Sprintf("開始に失敗しました: %v", err))
		return
	}
	b.editResponseText(s, i, fmt.Sprintf("✅ リポジトリセッションを開始しました: %s", mention))
	_, _ = s.ChannelMessageSend(threadID, fmt.Sprintf("対象リポジトリ `%s` で準備完了です。", repo))
}

func (b *Bot) handleStopCommand(s *discordgo.Session, i *discordgo.InteractionCreate) {
	if err := b.deferResponse(s, i); err != nil {
		return
	}
	isThread, err := b.isThreadChannel(s, i.ChannelID)
	if err != nil {
		b.editResponseText(s, i, "チャンネル情報の取得に失敗しました。")
		return
	}
	if !isThread {
		b.editResponseText(s, i, "このコマンドはスレッド内でのみ使用できます。")
		return
	}
	stopped, err := b.service.Stop(i.ChannelID)
	if err != nil {
		b.editResponseText(s, i, "停止に失敗しました。")
		return
	}
	if stopped {
		b.editResponseText(s, i, "⛔ 実行中のCodexを中断しました。")
		return
	}
	b.editResponseText(s, i, "現在実行中のジョブはありません。")
}

func (b *Bot) handleStatusCommand(s *discordgo.Session, i *discordgo.InteractionCreate) {
	if err := b.deferResponse(s, i); err != nil {
		return
	}
	isThread, err := b.isThreadChannel(s, i.ChannelID)
	if err != nil {
		b.editResponseText(s, i, "チャンネル情報の取得に失敗しました。")
		return
	}
	if !isThread {
		b.editResponseText(s, i, "このコマンドはスレッド内でのみ使用できます。")
		return
	}
	st, err := b.service.Status(i.ChannelID)
	if err != nil {
		b.editResponseText(s, i, "このスレッドのセッションは見つかりません。")
		return
	}

	repo := st.Repository
	if repo == "" {
		repo = "-"
	}
	msg := fmt.Sprintf(
		"Mode: %s\nRepository: %s\nRun: %s\nSession: %s\nToken Remaining: 5h %d%% | 1w %d%%",
		st.Mode,
		repo,
		st.RunState,
		blankAsDash(st.CodexSessionID),
		st.Remaining5HRate,
		st.Remaining1WRate,
	)
	b.editResponseText(s, i, msg)
}

func (b *Bot) onMessageCreate(s *discordgo.Session, m *discordgo.MessageCreate) {
	if m.Author == nil || m.Author.Bot {
		return
	}

	ch, err := s.Channel(m.ChannelID)
	if err != nil || !isThreadType(ch.Type) {
		return
	}

	_ = s.MessageReactionAdd(m.ChannelID, m.ID, "👀")
	_ = s.MessageReactionAdd(m.ChannelID, m.ID, "⚙️")

	final, err := b.service.HandleUserMessage(
		context.Background(),
		m.ChannelID,
		m.Content,
		func(content string) {
			for _, chunk := range splitChunks(content, b.messageChunkSize) {
				if strings.TrimSpace(chunk) == "" {
					continue
				}
				_, _ = s.ChannelMessageSendComplex(m.ChannelID, &discordgo.MessageSend{
					Content: chunk,
					Flags:   discordgo.MessageFlagsSuppressNotifications,
				})
			}
		},
	)
	if err != nil {
		if errors.Is(err, session.ErrRunInProgress) {
			_, _ = s.ChannelMessageSendReply(m.ChannelID, "実行中です。/stop で中断してください。", messageRef(m))
			return
		}
		if errors.Is(err, session.ErrSessionNotFound) {
			return
		}
		_, _ = s.ChannelMessageSendReply(m.ChannelID, "Codex実行に失敗しました。", messageRef(m))
		return
	}

	replyChunks := splitChunks(final, b.messageChunkSize)
	if len(replyChunks) == 0 {
		return
	}
	_, _ = s.ChannelMessageSendReply(m.ChannelID, replyChunks[0], messageRef(m))
	for _, chunk := range replyChunks[1:] {
		_, _ = s.ChannelMessageSend(m.ChannelID, chunk)
	}
}

func (b *Bot) deferResponse(s *discordgo.Session, i *discordgo.InteractionCreate) error {
	return s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseDeferredChannelMessageWithSource,
	})
}

func (b *Bot) editResponseText(s *discordgo.Session, i *discordgo.InteractionCreate, text string) {
	_, _ = s.InteractionResponseEdit(i.Interaction, &discordgo.WebhookEdit{
		Content: &text,
	})
}

func (b *Bot) ensureThread(
	s *discordgo.Session,
	i *discordgo.InteractionCreate,
	nameSeed string,
) (threadID string, mention string, err error) {
	isThread, err := b.isThreadChannel(s, i.ChannelID)
	if err != nil {
		return "", "", err
	}
	if isThread {
		return i.ChannelID, "<#" + i.ChannelID + ">", nil
	}

	msg, err := s.ChannelMessageSend(i.ChannelID, "スレッドを作成しています...")
	if err != nil {
		return "", "", err
	}
	name := fmt.Sprintf("%s-%d", sanitizeThreadName(nameSeed), time.Now().Unix())
	thread, err := s.MessageThreadStartComplex(i.ChannelID, msg.ID, &discordgo.ThreadStart{
		Name:                name,
		AutoArchiveDuration: 10080,
		Type:                discordgo.ChannelTypeGuildPublicThread,
	})
	if err != nil {
		return "", "", err
	}
	return thread.ID, thread.Mention(), nil
}

func (b *Bot) isThreadChannel(s *discordgo.Session, channelID string) (bool, error) {
	ch, err := s.Channel(channelID)
	if err != nil {
		return false, err
	}
	return isThreadType(ch.Type), nil
}

func optionString(options []*discordgo.ApplicationCommandInteractionDataOption, name string) string {
	for _, option := range options {
		if option.Name == name {
			return option.StringValue()
		}
	}
	return ""
}

func blankAsDash(v string) string {
	if strings.TrimSpace(v) == "" {
		return "-"
	}
	return v
}

func isThreadType(t discordgo.ChannelType) bool {
	return t == discordgo.ChannelTypeGuildPublicThread ||
		t == discordgo.ChannelTypeGuildPrivateThread ||
		t == discordgo.ChannelTypeGuildNewsThread
}

func sanitizeThreadName(seed string) string {
	seed = strings.TrimSpace(seed)
	if seed == "" {
		return "session"
	}
	replacer := strings.NewReplacer("/", "-", "\\", "-", " ", "-")
	seed = replacer.Replace(seed)
	if len(seed) > 80 {
		return seed[:80]
	}
	return seed
}

func splitChunks(content string, max int) []string {
	if max <= 0 {
		max = 1500
	}
	if len(content) <= max {
		if strings.TrimSpace(content) == "" {
			return nil
		}
		return []string{content}
	}
	chunks := make([]string, 0, len(content)/max+1)
	remaining := content
	for len(remaining) > max {
		cut := strings.LastIndexAny(remaining[:max], "\n ")
		if cut < max/2 {
			cut = max
		} else {
			cut++
		}
		chunk := remaining[:cut]
		remaining = remaining[cut:]
		if strings.TrimSpace(chunk) != "" {
			chunks = append(chunks, chunk)
		}
	}
	if strings.TrimSpace(remaining) != "" {
		chunks = append(chunks, remaining)
	}
	return chunks
}

func messageRef(m *discordgo.MessageCreate) *discordgo.MessageReference {
	return &discordgo.MessageReference{
		MessageID: m.ID,
		ChannelID: m.ChannelID,
		GuildID:   m.GuildID,
	}
}
