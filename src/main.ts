import {
  AutocompleteInteraction,
  ButtonInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
  ThreadAutoArchiveDuration,
  ThreadChannel,
} from "discord.js";
import { Admin } from "./admin/admin.ts";
import { getEnv } from "./env.ts";
import { ensureRepository, parseRepository } from "./git-utils.ts";
import { createDevcontainerProgressHandler } from "./utils/devcontainer-progress.ts";
import { RepositoryPatInfo, WorkspaceManager } from "./workspace/workspace.ts";
import {
  checkSystemRequirements,
  type CommandStatus,
  formatSystemCheckResults,
} from "./system-check.ts";
import { generateThreadName, summarizeWithGemini } from "./gemini.ts";

// システム要件チェック
console.log("システム要件をチェックしています...");
const systemCheckResult = await checkSystemRequirements();

if (systemCheckResult.isErr()) {
  const error = systemCheckResult.error;

  if (error.type === "REQUIRED_COMMAND_MISSING") {
    // エラーの場合でも、各コマンドの状態を確認するために再度チェック（結果表示用）
    const allCommands = ["git", "codex", "gh", "devcontainer"];
    const displayResults: CommandStatus[] = [];

    for (const cmd of allCommands) {
      try {
        const process = new Deno.Command(cmd, {
          args: ["--version"],
          stdout: "piped",
          stderr: "piped",
        });
        const result = await process.output();

        if (result.success) {
          const version = new TextDecoder().decode(result.stdout).trim();
          displayResults.push({ command: cmd, available: true, version });
        } else {
          displayResults.push({
            command: cmd,
            available: false,
            error: "Command failed",
          });
        }
      } catch {
        displayResults.push({
          command: cmd,
          available: false,
          error: "Command not found",
        });
      }
    }

    const checkResults = formatSystemCheckResults(
      displayResults,
      error.missingCommands,
    );
    console.log(checkResults);
    console.error(
      "\n❌ 必須コマンドが不足しているため、アプリケーションを終了します。",
    );
  } else {
    console.error(
      `\n❌ システムチェック中にエラーが発生しました: ${JSON.stringify(error)}`,
    );
  }

  Deno.exit(1);
}

const systemCheck = systemCheckResult.value;
const checkResults = formatSystemCheckResults(
  systemCheck.results,
  systemCheck.missingRequired,
);
console.log(checkResults);

console.log("\n✅ システム要件チェック完了\n");

const envResult = getEnv();
if (envResult.isErr()) {
  console.error(`❌ ${envResult.error.message}`);
  console.error(`環境変数 ${envResult.error.variable} を設定してください。`);
  Deno.exit(1);
}

const env = envResult.value;
const workspaceManager = new WorkspaceManager(env.WORK_BASE_DIR);
await workspaceManager.initialize();
// Admin状態を読み込む
const adminState = await workspaceManager.loadAdminState();
const admin = Admin.fromState(
  adminState,
  workspaceManager,
  env.VERBOSE,
  env.CODEX_APPEND_SYSTEM_PROMPT,
  env.PLAMO_TRANSLATOR_URL,
);

if (env.VERBOSE) {
  console.log("🔍 VERBOSEモードが有効です - 詳細ログが出力されます");
}

// Discord Clientの初期化
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// スレッドクローズコールバックを設定
admin.setThreadCloseCallback(async (threadId: string) => {
  try {
    const thread = await client.channels.fetch(threadId);
    if (thread && thread.isThread()) {
      await thread.setArchived(true);
      console.log(`スレッド ${threadId} をアーカイブしました`);
    }
  } catch (error) {
    console.error(`スレッド ${threadId} のアーカイブに失敗:`, error);
  }
});

// スラッシュコマンドの定義
const commands = [
  new SlashCommandBuilder()
    .setName("start")
    .setDescription("新しいチャットスレッドを開始します")
    .addStringOption((option) =>
      option.setName("repository")
        .setDescription("対象のGitHubリポジトリ（例: owner/repo）")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("set-pat")
    .setDescription("リポジトリ用のGitHub Fine-Grained PATを設定します")
    .addStringOption((option) =>
      option.setName("repository")
        .setDescription("対象のGitHubリポジトリ（例: owner/repo）")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option.setName("token")
        .setDescription("GitHub Fine-Grained PAT")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("description")
        .setDescription("トークンの説明（省略可）")
        .setRequired(false)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("list-pats")
    .setDescription("登録済みのGitHub PATの一覧を表示します")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("delete-pat")
    .setDescription("登録済みのGitHub PATを削除します")
    .addStringOption((option) =>
      option.setName("repository")
        .setDescription("対象のGitHubリポジトリ（例: owner/repo）")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("実行中のCodex Codeを中断します")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("plan")
    .setDescription("Codex Codeをプランモードに設定します")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("close")
    .setDescription("現在のスレッドをクローズします")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads)
    .toJSON(),
];

// Bot起動時の処理
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`ログイン完了: ${readyClient.user.tag}`);

  // DiscordクライアントをAdminに設定
  admin.setDiscordClient(readyClient);

  // 初期プレゼンス設定をトークン使用量付きで行う
  await admin.updateDiscordStatusWithTokenUsage();

  // 定期的なステータス更新を設定（10分ごと）
  setInterval(async () => {
    try {
      await admin.updateDiscordStatusWithTokenUsage();
    } catch (error) {
      console.error("定期ステータス更新エラー:", error);
    }
  }, 10 * 60 * 1000); // 10分ごと

  // 自動再開コールバックを設定
  admin.setAutoResumeCallback(async (threadId: string, message: string) => {
    try {
      const channel = await readyClient.channels.fetch(threadId);
      if (channel && channel.isTextBased() && "send" in channel) {
        // スレッドから最新のメッセージを取得（リアクション用）
        const messages = await channel.messages.fetch({ limit: 10 });
        const userMessages = messages.filter((msg) => !msg.author.bot);
        const lastUserMessage = userMessages.first();

        // 進捗コールバック
        const onProgress = async (content: string) => {
          try {
            await channel.send({
              content: content,
              flags: 4096, // SUPPRESS_NOTIFICATIONS flag
            });
          } catch (sendError) {
            console.error("自動再開メッセージ送信エラー:", sendError);
          }
        };

        // リアクションコールバック
        const onReaction = async (emoji: string) => {
          if (lastUserMessage) {
            try {
              await lastUserMessage.react(emoji);
            } catch (error) {
              console.error("自動再開リアクション追加エラー:", error);
            }
          }
        };

        const replyResult = await admin.routeMessage(
          threadId,
          message,
          onProgress,
          onReaction,
        );

        if (replyResult.isErr()) {
          console.error("自動再開メッセージ処理エラー:", replyResult.error);
          return;
        }

        const reply = replyResult.value;

        if (typeof reply === "string") {
          await (channel as TextChannel).send(reply);
        } else {
          await (channel as TextChannel).send({
            content: reply.content,
            components: reply.components,
          });
        }
      }
    } catch (error) {
      console.error("自動再開メッセージ送信エラー:", error);
    }
  });

  // スレッドクローズコールバックを設定
  admin.setThreadCloseCallback(async (threadId: string) => {
    try {
      const channel = await readyClient.channels.fetch(threadId);
      if (channel && channel.type === ChannelType.PublicThread) {
        await (channel as ThreadChannel).setArchived(true);
        console.log(`スレッドをアーカイブしました: ${threadId}`);
      }
    } catch (error) {
      console.error(`スレッドのアーカイブに失敗しました (${threadId}):`, error);
    }
  });

  // アクティブなスレッドを復旧
  console.log("アクティブなスレッドを復旧しています...");
  const restoreResult = await admin.restoreActiveThreads();
  if (restoreResult.isOk()) {
    console.log("スレッドの復旧が完了しました。");
  } else {
    console.error("スレッドの復旧でエラーが発生しました:", restoreResult.error);
  }

  // スラッシュコマンドを登録
  const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);

  try {
    console.log("スラッシュコマンドの登録を開始します...");

    await rest.put(
      Routes.applicationCommands(readyClient.user.id),
      { body: commands },
    );

    console.log("スラッシュコマンドの登録が完了しました！");
  } catch (error) {
    console.error("スラッシュコマンドの登録に失敗しました:", error);
  }
});

// インタラクションの処理
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction);
  } else if (interaction.isButton()) {
    await handleButtonInteraction(interaction);
  } else if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction);
  }
});

async function handleButtonInteraction(interaction: ButtonInteraction) {
  try {
    const threadId = interaction.channel?.id;
    if (!threadId) {
      await interaction.reply("スレッドIDが取得できませんでした。");
      return;
    }

    // /close コマンドの確認ボタン処理
    if (interaction.customId.startsWith("close_thread_confirm_")) {
      await interaction.deferReply();

      const closeResult = await admin.closeThread(threadId);
      if (closeResult.isErr()) {
        await interaction.editReply(
          `❌ スレッドのクローズに失敗しました: ${closeResult.error.type}`,
        );
        return;
      }

      await interaction.editReply(
        "✅ スレッドがクローズされました。作業内容が保存され、スレッドがアーカイブされます。",
      );
      return;
    }

    if (interaction.customId.startsWith("close_thread_cancel_")) {
      await interaction.deferReply();
      await interaction.editReply(
        "❌ スレッドのクローズをキャンセルしました。",
      );
      return;
    }

    await interaction.deferReply();

    const resultOrError = await admin.handleButtonInteraction(
      threadId,
      interaction.customId,
    );

    if (resultOrError.isErr()) {
      await interaction.editReply(`エラー: ${resultOrError.error.type}`);
      return;
    }

    const result = resultOrError.value;

    // devcontainerの起動処理を特別扱い
    if (result === "devcontainer_start_with_progress") {
      // 初期メッセージを送信してメッセージIDを保持
      let progressMessage: Message | undefined;
      if (interaction.channel && "send" in interaction.channel) {
        progressMessage = await interaction.channel.send({
          content: "🐳 devcontainerを起動しています...",
          // @ts-ignore - Discord.js v14では flags: 4096 が正しいが型定義が不完全
          flags: 4096, // SUPPRESS_NOTIFICATIONS flag
        });
      }

      await interaction.editReply(
        "devcontainerの起動を開始しました。進捗は下のメッセージで確認できます。",
      );

      // 共通の進捗ハンドラーを作成
      const progressHandler = createDevcontainerProgressHandler(
        interaction,
        progressMessage,
        {
          initialMessage: "🐳 devcontainerを起動しています...",
          progressPrefix: "🐳 **devcontainer起動中...**",
          successMessage:
            "✅ **devcontainer起動完了！**\n\n準備完了です！何かご質問をどうぞ。",
          failurePrefix: "❌ **devcontainer起動失敗**\n\n",
        },
      );

      try {
        // devcontainerを起動
        const startResult = await admin.startDevcontainerForWorker(
          threadId,
          progressHandler.onProgress,
        );

        const workerResult = admin.getWorker(threadId);

        if (startResult.success) {
          // 成功時の処理
          await progressHandler.onSuccess([]);

          // 成功メッセージに追加情報を付与
          if (progressMessage && startResult.message) {
            try {
              const currentContent = progressMessage.content;
              await progressMessage.edit({
                content: currentContent.replace(
                  "準備完了です！何かご質問をどうぞ。",
                  `${startResult.message}\n\n準備完了です！何かご質問をどうぞ。`,
                ),
              });
            } catch (editError) {
              console.error("追加情報編集エラー:", editError);
            }
          }

          // ユーザーに通知
          if (interaction.channel && "send" in interaction.channel) {
            await interaction.channel.send(
              "devcontainerの準備が完了しました！",
            );
          }
        } else {
          if (workerResult.isOk()) {
            workerResult.value.setUseDevcontainer(false);
          }

          // 失敗時の処理
          await progressHandler.onFailure(
            `${startResult.message}\n\n通常環境でCodex実行を継続します。`,
            [],
          );

          // ユーザーに通知
          if (interaction.channel && "send" in interaction.channel) {
            await interaction.channel.send(
              "devcontainerの起動に失敗しました。通常環境でCodex実行を継続します。",
            );
          }
        }
      } catch (error) {
        progressHandler.cleanup();
        throw error;
      }
    } else if (result === "fallback_devcontainer_start_with_progress") {
      // fallback devcontainerの起動処理
      await interaction.editReply(
        "📦 fallback devcontainerを起動しています...",
      );

      // 共通の進捗ハンドラーを作成
      const progressHandler = createDevcontainerProgressHandler(
        interaction,
        undefined, // fallbackはeditReplyを使用するのでprogressMessageは不要
        {
          initialMessage: "📦 fallback devcontainerを起動しています...",
          progressPrefix: "📦 fallback devcontainerを起動しています...",
          successMessage:
            "✅ fallback devcontainerが正常に起動しました！\n\n準備完了です！何かご質問をどうぞ。",
          failurePrefix:
            "❌ fallback devcontainerの起動に失敗しました。\n\nエラー: ",
          showFirstTimeWarning: true,
        },
      );

      try {
        // fallback devcontainerを起動
        const startResult = await admin.startFallbackDevcontainerForWorker(
          threadId,
          progressHandler.onProgress,
        );

        if (startResult.success) {
          // fallback devcontainer起動成功後、WorkerにDevcontainerCodexExecutorへの切り替えを指示
          const workerResult = admin.getWorker(threadId);
          if (workerResult.isOk()) {
            // WorkerのdevcontainerConfigを更新してDevcontainerCodexExecutorに切り替える
            await workerResult.value.updateCodexExecutorForDevcontainer();
          }

          // 成功メッセージとログの表示
          await progressHandler.onSuccess([]);

          // ユーザーに通知
          if (interaction.channel && "send" in interaction.channel) {
            await interaction.channel.send(
              "fallback devcontainerの起動が完了しました！Codex実行環境が準備完了です。",
            );
          }
        } else {
          // 失敗時の処理
          await progressHandler.onFailure(
            startResult.message || "不明なエラー",
            [],
          );

          // ユーザーに通知
          if (interaction.channel && "send" in interaction.channel) {
            await interaction.channel.send(
              "fallback devcontainerの起動に失敗しました。通常環境でCodex実行を継続します。",
            );
          }
        }
      } catch (error) {
        progressHandler.cleanup();
        console.error("fallback devcontainer起動エラー:", error);
        await interaction.editReply({
          content: `❌ fallback devcontainerの起動中にエラーが発生しました: ${
            (error as Error).message
          }`,
        });
      }
    } else {
      await interaction.editReply(result);
    }
  } catch (error) {
    console.error("ボタンインタラクションエラー:", error);
    try {
      await interaction.editReply("エラーが発生しました。");
    } catch {
      await interaction.reply("エラーが発生しました。");
    }
  }
}

async function handleAutocomplete(interaction: AutocompleteInteraction) {
  try {
    const supportedCommands = ["start", "set-pat", "delete-pat"];
    if (supportedCommands.includes(interaction.commandName)) {
      const focusedOption = interaction.options.getFocused(true);

      if (focusedOption.name === "repository") {
        const localRepositories = await workspaceManager.getLocalRepositories();
        const input = focusedOption.value.toLowerCase();

        // 入力文字列でフィルタリング
        const filtered = localRepositories.filter((repo) =>
          repo.toLowerCase().includes(input)
        );

        // Discord.jsの制限により最大25件まで
        const choices = filtered.slice(0, 25).map((repo) => ({
          name: repo,
          value: repo,
        }));

        await interaction.respond(choices);
      }
    }
  } catch (error) {
    console.error("オートコンプリートエラー:", error);
    // エラー時は空の選択肢を返す
    await interaction.respond([]);
  }
}

async function handleSlashCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === "set-pat") {
    try {
      await interaction.deferReply({ ephemeral: true });

      const repositorySpec = interaction.options.getString("repository", true);
      const token = interaction.options.getString("token", true);
      const description = interaction.options.getString("description");

      // リポジトリ名をパース
      const repositoryResult = parseRepository(repositorySpec);
      if (repositoryResult.isErr()) {
        const errorMessage =
          repositoryResult.error.type === "INVALID_REPOSITORY_NAME"
            ? repositoryResult.error.message
            : "リポジトリ名の解析に失敗しました";
        await interaction.editReply(`エラー: ${errorMessage}`);
        return;
      }
      const repository = repositoryResult.value;

      // PAT情報を保存
      const patInfo: RepositoryPatInfo = {
        repositoryFullName: repository.fullName,
        token,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        description: description || undefined,
      };

      await workspaceManager.saveRepositoryPat(patInfo);

      await interaction.editReply(
        `✅ ${repository.fullName}のGitHub PATを設定しました。${
          description ? `\n説明: ${description}` : ""
        }\n\n今後このリポジトリでdevcontainerを使用する際に、このPATが自動的に環境変数として設定されます。`,
      );
    } catch (error) {
      console.error("PAT設定エラー:", error);
      await interaction.editReply("エラーが発生しました。");
    }
  } else if (commandName === "list-pats") {
    try {
      await interaction.deferReply({ ephemeral: true });

      const pats = await workspaceManager.listRepositoryPats();

      if (pats.length === 0) {
        await interaction.editReply("登録済みのGitHub PATはありません。");
        return;
      }

      const patList = pats
        .map((pat) => {
          const maskedToken = `${pat.token.substring(0, 7)}...${
            pat.token.substring(pat.token.length - 4)
          }`;
          return `• **${pat.repositoryFullName}**\n  トークン: \`${maskedToken}\`${
            pat.description ? `\n  説明: ${pat.description}` : ""
          }\n  登録日: ${new Date(pat.createdAt).toLocaleString("ja-JP")}`;
        })
        .join("\n\n");

      await interaction.editReply(
        `📋 **登録済みのGitHub PAT一覧**\n\n${patList}`,
      );
    } catch (error) {
      console.error("PAT一覧取得エラー:", error);
      await interaction.editReply("エラーが発生しました。");
    }
  } else if (commandName === "delete-pat") {
    try {
      await interaction.deferReply({ ephemeral: true });

      const repositorySpec = interaction.options.getString("repository", true);

      // リポジトリ名をパース
      const repositoryResult = parseRepository(repositorySpec);
      if (repositoryResult.isErr()) {
        const errorMessage =
          repositoryResult.error.type === "INVALID_REPOSITORY_NAME"
            ? repositoryResult.error.message
            : "リポジトリ名の解析に失敗しました";
        await interaction.editReply(`エラー: ${errorMessage}`);
        return;
      }
      const repository = repositoryResult.value;

      await workspaceManager.deleteRepositoryPat(repository.fullName);

      await interaction.editReply(
        `✅ ${repository.fullName}のGitHub PATを削除しました。`,
      );
    } catch (error) {
      console.error("PAT削除エラー:", error);
      await interaction.editReply("エラーが発生しました。");
    }
  } else if (commandName === "start") {
    try {
      if (!interaction.channel || !("threads" in interaction.channel)) {
        await interaction.reply("このチャンネルではスレッドを作成できません。");
        return;
      }

      // リポジトリ引数を取得
      const repositorySpec = interaction.options.getString("repository", true);

      // リポジトリ名をパース
      const repositoryParseResult = parseRepository(repositorySpec);
      if (repositoryParseResult.isErr()) {
        const errorMessage =
          repositoryParseResult.error.type === "INVALID_REPOSITORY_NAME"
            ? repositoryParseResult.error.message
            : "リポジトリ名の解析に失敗しました";
        await interaction.reply(`エラー: ${errorMessage}`);
        return;
      }
      const repository = repositoryParseResult.value;

      // インタラクションを遅延レスポンスで処理（clone処理が時間がかかる可能性があるため）
      await interaction.deferReply();

      // リポジトリをclone/更新
      const repositoryResult = await ensureRepository(
        repository,
        workspaceManager,
      );
      if (repositoryResult.isErr()) {
        const errorMessage = repositoryResult.error.type === "GH_CLI_ERROR"
          ? repositoryResult.error.error
          : `リポジトリの取得に失敗しました: ${repositoryResult.error.type}`;
        await interaction.editReply(errorMessage);
        return;
      }

      // スレッドを作成
      const thread = await interaction.channel.threads.create({
        name: `${repository.fullName}-${Date.now()}`,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        reason: `${repository.fullName}のチャットセッション`,
      });

      if (!thread) {
        await interaction.editReply("スレッドの作成に失敗しました。");
        return;
      }

      // Workerを作成してリポジトリ情報を設定
      const workerResult = await admin.createWorker(thread.id);
      if (workerResult.isErr()) {
        await interaction.editReply(`エラー: ${workerResult.error.type}`);
        return;
      }
      const worker = workerResult.value;
      await worker.setRepository(repository, repositoryResult.value.path);

      // 更新状況に応じたメッセージを作成
      let statusMessage = repositoryResult.value.wasUpdated
        ? `${repository.fullName}の既存リポジトリをデフォルトブランチの最新に更新しました。`
        : `${repository.fullName}を新規取得しました。`;

      // メタデータがある場合は追加情報を表示
      if (repositoryResult.value.metadata) {
        const metadata = repositoryResult.value.metadata;
        const repoInfo = [
          metadata.description ? `説明: ${metadata.description}` : "",
          metadata.language ? `言語: ${metadata.language}` : "",
          `デフォルトブランチ: ${metadata.defaultBranch}`,
          metadata.isPrivate
            ? "🔒 プライベートリポジトリ"
            : "🌐 パブリックリポジトリ",
        ].filter(Boolean).join(" | ");

        statusMessage += `\n📋 ${repoInfo}`;
      }

      await interaction.editReply(
        `${statusMessage}\nチャットスレッドを作成しました: ${thread.toString()}`,
      );

      // devcontainer.jsonの存在確認と設定
      const devcontainerInfo = await admin.checkAndSetupDevcontainer(
        thread.id,
        repositoryResult.value.path,
      );

      // シンプルな初期メッセージを送信
      const greeting =
        `こんにちは！ 準備バッチリだよ！ ${repository.fullName} について何でも聞いてね～！`;

      // devcontainerの設定ボタンがある場合のみ表示
      const components = devcontainerInfo.components || [];

      await thread.send({
        content: greeting,
        components: components,
      });
    } catch (error) {
      console.error("スレッド作成エラー:", error);
      try {
        await interaction.editReply("エラーが発生しました。");
      } catch {
        await interaction.reply("エラーが発生しました。");
      }
    }
  } else if (commandName === "stop") {
    try {
      // スレッド内でのみ使用可能
      if (!interaction.channel || !interaction.channel.isThread()) {
        await interaction.reply("このコマンドはスレッド内でのみ使用できます。");
        return;
      }

      await interaction.deferReply();

      const threadId = interaction.channel.id;
      const stopResult = await admin.stopExecution(threadId);

      if (stopResult.isErr()) {
        const error = stopResult.error;
        if (error.type === "WORKER_NOT_FOUND") {
          await interaction.editReply(
            "❌ 中断に失敗しました。既に実行が完了している可能性があります。",
          );
        } else {
          await interaction.editReply(
            `❌ 中断処理中にエラーが発生しました: ${error.type}\n\n🔄 もう一度お試しください。`,
          );
        }
        return;
      }

      await interaction.editReply(
        "✅ Codex Codeの実行を中断しました。\n\n💡 新しい指示を送信して作業を続けることができます。",
      );
    } catch (error) {
      console.error("/stopコマンドエラー:", error);
      try {
        await interaction.editReply("エラーが発生しました。");
      } catch {
        await interaction.reply("エラーが発生しました。");
      }
    }
  } else if (commandName === "plan") {
    try {
      // スレッド内でのみ使用可能
      if (!interaction.channel || !interaction.channel.isThread()) {
        await interaction.reply("このコマンドはスレッド内でのみ使用できます。");
        return;
      }

      await interaction.deferReply();

      const threadId = interaction.channel.id;
      const planResult = await admin.setPlanMode(threadId, true);

      if (planResult.isErr()) {
        const error = planResult.error;
        if (error.type === "WORKER_NOT_FOUND") {
          await interaction.editReply(
            "❌ プランモードの設定に失敗しました。このスレッドはアクティブではありません。",
          );
        } else {
          await interaction.editReply(
            `❌ プランモードの設定中にエラーが発生しました: ${error.type}`,
          );
        }
        return;
      }

      await interaction.editReply(
        "✅ プランモードを有効にしました。\n\n💡 今後の指示に対して、実装前に詳細な計画を立てて提案します。",
      );
    } catch (error) {
      console.error("/planコマンドエラー:", error);
      try {
        await interaction.editReply("エラーが発生しました。");
      } catch {
        await interaction.reply("エラーが発生しました。");
      }
    }
  } else if (commandName === "close") {
    try {
      // スレッド内でのみ使用可能
      if (!interaction.channel || !interaction.channel.isThread()) {
        await interaction.reply("このコマンドはスレッド内でのみ使用できます。");
        return;
      }

      await interaction.deferReply();

      const threadId = interaction.channel.id;

      // 確認メッセージを送信
      await interaction.editReply(
        "🔄 本当にこのスレッドをクローズしますか？\n\n⚠️ スレッドをクローズすると、作業内容が保存され、スレッドがアーカイブされます。この操作は取り消すことができません。",
      );

      // 確認ボタンを含むフォローアップメッセージを送信
      await interaction.followUp({
        content: "確認してください:",
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 4, // 危険なアクション用のスタイル
                label: "スレッドをクローズする",
                custom_id: `close_thread_confirm_${threadId}`,
              },
              {
                type: 2,
                style: 2, // セカンダリスタイル
                label: "キャンセル",
                custom_id: `close_thread_cancel_${threadId}`,
              },
            ],
          },
        ],
      });
    } catch (error) {
      console.error("/closeコマンドエラー:", error);
      try {
        await interaction.editReply("エラーが発生しました。");
      } catch {
        await interaction.reply("エラーが発生しました。");
      }
    }
  }
}

// スレッドアーカイブイベントの処理
client.on(Events.ThreadUpdate, async (oldThread, newThread) => {
  // アーカイブ状態が変更された場合のみ処理
  if (!oldThread.archived && newThread.archived) {
    console.log(`スレッド ${newThread.id} がアーカイブされました`);

    try {
      // Workerの終了処理
      const terminateResult = await admin.terminateThread(newThread.id);
      if (terminateResult.isOk()) {
        console.log(
          `スレッド ${newThread.id} のWorkerとworktreeを削除しました`,
        );
      } else {
        console.error(
          `スレッド ${newThread.id} の終了処理でエラー:`,
          terminateResult.error,
        );
      }
    } catch (error) {
      console.error(`スレッド ${newThread.id} の終了処理でエラー:`, error);
    }
  }
});

// メッセージの処理
client.on(Events.MessageCreate, async (message) => {
  // Bot自身のメッセージは無視
  if (message.author.bot) return;

  // スレッド内のメッセージのみ処理
  if (!message.channel.isThread()) return;

  const threadId = message.channel.id;
  const thread = message.channel as ThreadChannel;

  // GEMINI_API_KEYが設定されていて、スレッド名が一時的なものの場合、最初のメッセージで名前を更新（非同期）
  if (env.GEMINI_API_KEY && thread.name.match(/^[\w-]+\/[\w-]+-\d+$/)) {
    console.log(
      `[ThreadRename] 開始: スレッドID=${threadId}, 現在の名前="${thread.name}"`,
    );

    // スレッド名生成を非同期で実行（メッセージ処理をブロックしない）
    (async () => {
      try {
        // スレッド情報を取得
        console.log(`[ThreadRename] スレッド情報を取得中...`);
        const threadInfo = await workspaceManager.loadThreadInfo(threadId);

        if (!threadInfo) {
          console.log(
            `[ThreadRename] スレッド情報が見つかりません: threadId=${threadId}`,
          );
          // スレッド情報がなくても続行（リポジトリ名なしで要約のみ使用）
        } else if (threadInfo.repositoryFullName) {
          console.log(
            `[ThreadRename] リポジトリ名: ${threadInfo.repositoryFullName}`,
          );
        } else {
          console.log(
            `[ThreadRename] リポジトリ名が設定されていません。要約のみでスレッド名を生成します`,
          );
        }

        // Gemini APIで要約
        console.log(
          `[ThreadRename] Gemini APIで要約を生成中... メッセージ長=${message.content.length}`,
        );
        const summarizeResult = await summarizeWithGemini(
          env.GEMINI_API_KEY!, // 既にif文でチェック済み
          message.content,
          30, // 最大30文字
        );

        if (summarizeResult.isErr()) {
          console.log(
            `[ThreadRename] Gemini API失敗: ${
              JSON.stringify(summarizeResult.error)
            }`,
          );
          return;
        }

        const summary = summarizeResult.value;
        console.log(
          `[ThreadRename] 要約生成成功: "${summary}"`,
        );

        // スレッド名を生成
        const threadNameResult = generateThreadName(
          summary,
          threadInfo?.repositoryFullName ?? undefined,
        );

        if (threadNameResult.isErr()) {
          console.log(
            `[ThreadRename] スレッド名生成失敗: ${
              JSON.stringify(threadNameResult.error)
            }`,
          );
          return;
        }

        const newThreadName = threadNameResult.value;

        console.log(`[ThreadRename] 新しいスレッド名: "${newThreadName}"`);

        // スレッド名を更新
        console.log(`[ThreadRename] Discord APIでスレッド名を更新中...`);
        await thread.setName(newThreadName);

        console.log(
          `[ThreadRename] 成功: "${thread.name}" -> "${newThreadName}"`,
        );
      } catch (error) {
        console.error("[ThreadRename] エラー:", error);
        console.error("[ThreadRename] エラースタック:", (error as Error).stack);
        // エラーが発生してもメッセージ処理には影響しない
      }
    })(); // 即時実行してawaitしない
  }

  // /configコマンドの処理
  if (message.content.startsWith("/config devcontainer ")) {
    const parts = message.content.split(" ");
    if (parts.length >= 3) {
      const setting = parts[2].toLowerCase();
      const workerResult = admin.getWorker(threadId);

      if (workerResult.isErr()) {
        // botが作成したスレッドかどうかをThreadInfoの存在で判断
        const threadInfo = await workspaceManager.loadThreadInfo(threadId);
        if (threadInfo) {
          // botが作成したスレッドの場合のみメッセージを表示
          await message.channel.send(
            "このスレッドはアクティブではありません。/start コマンドで新しいスレッドを開始してください。",
          );
        }
        // botが作成していないスレッドの場合は何も返信しない
        return;
      }

      const worker = workerResult.value;

      if (setting === "on") {
        worker.setUseDevcontainer(true);
        await message.reply(
          "devcontainer環境での実行を設定しました。\n\n準備完了です！何かご質問をどうぞ。",
        );
      } else if (setting === "off") {
        worker.setUseDevcontainer(false);
        await message.reply(
          "ホスト環境での実行を設定しました。\n\n準備完了です！何かご質問をどうぞ。",
        );
      } else {
        await message.reply(
          "不正な設定値です。'/config devcontainer on' または '/config devcontainer off' を使用してください。",
        );
      }
      return;
    }
  }

  try {
    let lastUpdateTime = Date.now();
    const UPDATE_INTERVAL = 2000; // 2秒ごとに更新

    // 進捗更新用のコールバック（新規メッセージ投稿、通知なし）
    const onProgress = async (content: string) => {
      const now = Date.now();
      if (now - lastUpdateTime >= UPDATE_INTERVAL) {
        try {
          await message.channel.send({
            content: content,
            flags: 4096, // SUPPRESS_NOTIFICATIONS flag
          });
          lastUpdateTime = now;
        } catch (sendError) {
          console.error("メッセージ送信エラー:", sendError);
        }
      }
    };

    // リアクション追加用のコールバック
    const onReaction = async (emoji: string) => {
      try {
        await message.react(emoji);
      } catch (error) {
        console.error("リアクション追加エラー:", error);
      }
    };

    // AdminにメッセージをルーティングしてWorkerからの返信を取得
    const replyResult = await admin.routeMessage(
      threadId,
      message.content,
      onProgress,
      onReaction,
      message.id,
      message.author.id,
    );

    if (replyResult.isErr()) {
      const error = replyResult.error;
      if (error.type === "WORKER_NOT_FOUND") {
        // botが作成したスレッドかどうかをThreadInfoの存在で判断
        const threadInfo = await workspaceManager.loadThreadInfo(threadId);
        if (threadInfo) {
          // botが作成したスレッドの場合のみメッセージを表示
          await message.channel.send(
            "このスレッドはアクティブではありません。/start コマンドで新しいスレッドを開始してください。",
          );
        }
        // botが作成していないスレッドの場合は何も返信しない
      } else {
        console.error("メッセージ処理エラー:", error);
        await message.channel.send("エラーが発生しました。");
      }
      return;
    }

    const reply = replyResult.value;

    // 最終的な返信を送信
    if (typeof reply === "string") {
      // 通常のテキストレスポンス（リプライ機能使用）
      await message.reply(reply);
    } else {
      // DiscordMessage形式（ボタン付きメッセージなど）
      await message.reply({
        content: reply.content,
        components: reply.components,
      });
    }
  } catch (error) {
    console.error("メッセージ処理エラー:", error);
    await message.channel.send("エラーが発生しました。");
  }
});

// Botを起動
client.login(env.DISCORD_TOKEN);
