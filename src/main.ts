import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  ThreadChannel,
} from "discord.js";
import { Admin } from "./admin/admin.ts";
import { MESSAGES } from "./constants.ts";
import { getEnv } from "./env.ts";
import { ensureRepository, parseRepository } from "./git-utils.ts";
import {
  checkSystemRequirements,
  formatSystemCheckResults,
} from "./system-check.ts";
import { generateThreadNameWithCodex } from "./thread-namer.ts";
import { splitIntoDiscordChunks } from "./utils/discord-message.ts";
import { WorkspaceManager } from "./workspace/workspace.ts";

function chunkDiscordContent(content: string): string[] {
  return splitIntoDiscordChunks(content).filter((chunk) => chunk.length > 0);
}

const DEFAULT_THREAD_NAME_PATTERN = /^[\w.-]+\/[\w.-]+-\d+$/;

console.log("システム要件をチェックしています...");
const systemCheckResult = await checkSystemRequirements();
if (systemCheckResult.isErr()) {
  console.error(systemCheckResult.error);
  Deno.exit(1);
}
console.log(formatSystemCheckResults(
  systemCheckResult.value.results,
  systemCheckResult.value.missingRequired,
));

const envResult = getEnv();
if (envResult.isErr()) {
  console.error(`❌ ${envResult.error.message}`);
  Deno.exit(1);
}
const env = envResult.value;

const workspaceManager = new WorkspaceManager(env.WORK_BASE_DIR);
await workspaceManager.initialize();

const adminState = await workspaceManager.loadAdminState();
const admin = Admin.fromState(
  adminState,
  workspaceManager,
  env.CODEX_APPEND_SYSTEM_PROMPT,
);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

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
    .setName("stop")
    .setDescription("実行中のCodexを中断します")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("plan")
    .setDescription("プランモードを有効にします")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("close")
    .setDescription("現在のスレッドをクローズします")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads)
    .toJSON(),
];

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`ログイン完了: ${readyClient.user.tag}`);

  const restoreResult = await admin.restoreActiveThreads();
  if (restoreResult.isErr()) {
    console.error("スレッド復旧中にエラー:", restoreResult.error);
  }

  const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(readyClient.user.id), {
    body: commands,
  });
  console.log("スラッシュコマンド登録完了");
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction);
    return;
  }
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction);
  }
});

async function handleAutocomplete(interaction: AutocompleteInteraction) {
  if (interaction.commandName !== "start") {
    await interaction.respond([]);
    return;
  }

  const focusedOption = interaction.options.getFocused(true);
  if (focusedOption.name !== "repository") {
    await interaction.respond([]);
    return;
  }

  const localRepositories = await workspaceManager.getLocalRepositories();
  const input = focusedOption.value.toLowerCase();
  const filtered = localRepositories.filter((repo) =>
    repo.toLowerCase().includes(input)
  );
  const choices = filtered.slice(0, 25).map((repo) => ({
    name: repo,
    value: repo,
  }));
  await interaction.respond(choices);
}

async function handleSlashCommand(interaction: ChatInputCommandInteraction) {
  const { commandName } = interaction;

  if (commandName === "start") {
    await handleStart(interaction);
    return;
  }

  if (commandName === "stop") {
    if (!interaction.channel || !interaction.channel.isThread()) {
      await interaction.reply("このコマンドはスレッド内でのみ使用できます。");
      return;
    }
    await interaction.deferReply();
    const result = await admin.stopExecution(interaction.channel.id);
    if (result.isErr()) {
      await interaction.editReply("中断対象が見つかりませんでした。");
      return;
    }
    await interaction.editReply("⛔ 実行を中断しました。");
    return;
  }

  if (commandName === "plan") {
    if (!interaction.channel || !interaction.channel.isThread()) {
      await interaction.reply("このコマンドはスレッド内でのみ使用できます。");
      return;
    }
    await interaction.deferReply();
    const result = await admin.setPlanMode(interaction.channel.id, true);
    if (result.isErr()) {
      await interaction.editReply("プランモード設定に失敗しました。");
      return;
    }
    await interaction.editReply("✅ プランモードを有効化しました。");
    return;
  }

  if (commandName === "close") {
    if (!interaction.channel || !interaction.channel.isThread()) {
      await interaction.reply("このコマンドはスレッド内でのみ使用できます。");
      return;
    }
    await interaction.deferReply();
    const result = await admin.closeThread(interaction.channel.id);
    if (result.isErr()) {
      await interaction.editReply("クローズに失敗しました。");
      return;
    }
    await interaction.editReply("✅ スレッドをクローズしました。");
    return;
  }
}

async function handleStart(interaction: ChatInputCommandInteraction) {
  if (!interaction.channel || !("threads" in interaction.channel)) {
    await interaction.reply("このチャンネルではスレッドを作成できません。");
    return;
  }

  const repositorySpec = interaction.options.getString("repository", true);
  const parsed = parseRepository(repositorySpec);
  if (parsed.isErr()) {
    const message = parsed.error.type === "INVALID_REPOSITORY_NAME"
      ? parsed.error.message
      : parsed.error.type;
    await interaction.reply(message);
    return;
  }
  const repository = parsed.value;

  await interaction.deferReply();
  const ensured = await ensureRepository(repository, workspaceManager);
  if (ensured.isErr()) {
    await interaction.editReply(
      `リポジトリ準備に失敗しました: ${ensured.error.type}`,
    );
    return;
  }

  const thread = await interaction.channel.threads.create({
    name: `${repository.fullName}-${Date.now()}`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: `${repository.fullName}の作業スレッド`,
  });

  const workerResult = await admin.createWorker(thread.id);
  if (workerResult.isErr()) {
    await interaction.editReply("Workerの初期化に失敗しました。");
    return;
  }

  const setRepoResult = await workerResult.value.setRepository(
    repository,
    ensured.value.path,
  );
  if (setRepoResult.isErr()) {
    await interaction.editReply("リポジトリ設定に失敗しました。");
    return;
  }

  const message = ensured.value.wasUpdated
    ? `${repository.fullName}を最新化しました。`
    : `${repository.fullName}を新規取得しました。`;

  await interaction.editReply(`${message}\nスレッド: ${thread.toString()}`);
  await thread.send(
    `こんにちは！ 準備バッチリだよ！ ${repository.fullName} について何でも聞いてね～！`,
  );
}

client.on(Events.ThreadUpdate, async (oldThread, newThread) => {
  if (!oldThread.archived && newThread.archived) {
    await admin.terminateThread(newThread.id);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;

  const thread = message.channel as ThreadChannel;
  const threadId = thread.id;

  try {
    const threadInfo = await workspaceManager.loadThreadInfo(threadId);
    if (threadInfo && !threadInfo.firstUserMessageReceivedAt) {
      threadInfo.firstUserMessageReceivedAt = new Date().toISOString();
      threadInfo.autoRenamedByFirstMessage = false;

      if (
        message.content.trim().length > 0 &&
        DEFAULT_THREAD_NAME_PATTERN.test(thread.name)
      ) {
        const workerState = await workspaceManager.loadWorkerState(threadId);
        const renameResult = await generateThreadNameWithCodex(
          message.content,
          threadInfo.repositoryFullName ?? undefined,
          workerState?.worktreePath ?? undefined,
        );
        if (renameResult.isOk()) {
          await thread.setName(renameResult.value).catch(() => {});
          threadInfo.autoRenamedByFirstMessage = true;
        }
      }

      await workspaceManager.saveThreadInfo(threadInfo);
    }
  } catch (error) {
    console.error("[ThreadRename] first-message rename failed", error);
  }

  let lastProgressMessageUrl: string | null = null;
  const onProgress = async (content: string) => {
    for (const chunk of chunkDiscordContent(content)) {
      const sent = await message.channel.send({
        content: chunk,
        flags: 4096,
      });
      lastProgressMessageUrl = sent.url;
    }
  };

  const onReaction = async (emoji: string) => {
    await message.react(emoji).catch(() => {});
  };

  const result = await admin.routeMessage(
    threadId,
    message.content,
    onProgress,
    onReaction,
  );

  if (result.isErr()) {
    if (result.error.type === "WORKER_NOT_FOUND") {
      const threadInfo = await workspaceManager.loadThreadInfo(threadId);
      if (threadInfo) {
        await message.channel.send(
          "このスレッドはアクティブではありません。/start で新規に開始してください。",
        );
      }
      return;
    }
    if (result.error.type === "RATE_LIMIT") {
      await message.channel.send(admin.createRateLimitMessage());
      return;
    }
    await message.channel.send(`エラー: ${result.error.type}`);
    return;
  }

  const reply = result.value;
  if (typeof reply === "string") {
    const finalReply = reply.trim() === MESSAGES.NO_FINAL_RESPONSE &&
        lastProgressMessageUrl
      ? `Codexの最終テキストを取得できなかったため、直近の出力を参照してください。\n> ${lastProgressMessageUrl}`
      : reply;
    const chunks = chunkDiscordContent(finalReply);
    if (chunks.length === 0) return;
    await message.reply(chunks[0]);
    for (const chunk of chunks.slice(1)) {
      await message.channel.send(chunk);
    }
  } else {
    await message.reply(reply.content);
  }
});

client.login(env.DISCORD_TOKEN);
