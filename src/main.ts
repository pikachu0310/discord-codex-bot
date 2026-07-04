import {
  ActivityType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  ThreadChannel,
} from "discord.js";
import type { Message } from "discord.js";
import type {
  AttachmentDownloadInput,
  SavedAttachment,
} from "./attachments.ts";
import { Admin } from "./admin/admin.ts";
import type { AdminError } from "./admin/types.ts";
import {
  type CodexStatusWithAutoUpdateError,
  getCodexStatusWithAutoUpdate,
} from "./codex-status-auto-update.ts";
import {
  CodexStatusProvider,
  type CodexUsageStatus,
  formatCodexStatus,
  formatCodexStatusDelta,
  formatCodexStatusPresence,
  stripTerminalControlSequences,
} from "./codex-status.ts";
import { type CodexUpdateError, updateCodexCli } from "./codex-update.ts";
import { MESSAGES } from "./constants.ts";
import { getEnv } from "./env.ts";
import { ensureRepository, parseRepository } from "./git-utils.ts";
import {
  checkSystemRequirements,
  formatSystemCheckResults,
} from "./system-check.ts";
import { generateThreadNameWithCodex } from "./thread-namer.ts";
import { formatDiscordSendLog } from "./utils/discord-log.ts";
import { splitIntoDiscordChunks } from "./utils/discord-message.ts";
import {
  CodexAppServerClient,
  type CodexAppServerError,
} from "./worker/codex-app-server-client.ts";
import { WorkspaceManager } from "./workspace/workspace.ts";

function chunkDiscordContent(content: string): string[] {
  return splitIntoDiscordChunks(content).filter((chunk) =>
    chunk.trim().length > 0
  );
}

const MAX_ERROR_DETAIL_LENGTH = 6000;

function formatErrorDetail(detail: string): string {
  const normalized = detail.trim() || "(詳細なし)";
  if (normalized.length <= MAX_ERROR_DETAIL_LENGTH) {
    return normalized;
  }
  return `${
    normalized.slice(0, MAX_ERROR_DETAIL_LENGTH)
  }\n...詳細が長すぎるため省略しました`;
}

function formatAdminErrorForDiscord(error: AdminError): string {
  switch (error.type) {
    case "WORKER_NOT_FOUND":
      return [
        "エラー: WORKER_NOT_FOUND",
        `スレッドID: ${error.threadId}`,
      ].join("\n");
    case "WORKER_CREATE_FAILED":
      return [
        "エラー: WORKER_CREATE_FAILED",
        `スレッドID: ${error.threadId}`,
        `詳細: ${formatErrorDetail(error.reason)}`,
      ].join("\n");
    case "CODEX_EXECUTION_FAILED":
      return [
        "エラー: CODEX_EXECUTION_FAILED",
        `スレッドID: ${error.threadId}`,
        "詳細:",
        formatErrorDetail(error.error),
      ].join("\n");
    case "WORKSPACE_ERROR":
      return [
        "エラー: WORKSPACE_ERROR",
        `操作: ${error.operation}`,
        "詳細:",
        formatErrorDetail(error.error),
      ].join("\n");
    case "RATE_LIMIT":
      return [
        "エラー: RATE_LIMIT",
        `詳細: ${formatErrorDetail(error.message)}`,
      ].join("\n");
  }
}

function getAttachmentDownloadInputs(
  message: Message,
): AttachmentDownloadInput[] {
  return Array.from(message.attachments.values()).map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    url: attachment.url,
    contentType: attachment.contentType,
    size: attachment.size,
  }));
}

function getThreadSendContent(payload: Parameters<ThreadChannel["send"]>[0]) {
  if (typeof payload === "string") {
    return payload;
  }
  if (
    payload && typeof payload === "object" && "content" in payload &&
    typeof payload.content === "string"
  ) {
    return payload.content;
  }
  return "";
}

function logThreadSend(thread: ThreadChannel, content: string) {
  const channelName = thread.parent?.name ?? "-";
  console.log(formatDiscordSendLog(
    thread.guild.name,
    channelName,
    thread.name,
    content,
  ));
}

async function sendThreadMessage(
  thread: ThreadChannel,
  payload: Parameters<ThreadChannel["send"]>[0],
) {
  const sent = await thread.send(payload);
  logThreadSend(thread, getThreadSendContent(payload));
  return sent;
}

async function replyToThreadMessage(message: Message, content: string) {
  const sent = await message.reply(content);
  if (message.channel.isThread()) {
    logThreadSend(message.channel as ThreadChannel, content);
  }
  return sent;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function logUnexpectedError(context: string, error: unknown): void {
  console.error(`[${context}] unexpected error`, formatUnknownError(error));
}

async function runSafely(
  context: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    logUnexpectedError(context, error);
  }
}

globalThis.addEventListener("unhandledrejection", (event) => {
  logUnexpectedError("UnhandledRejection", event.reason);
  event.preventDefault();
});

globalThis.addEventListener("error", (event) => {
  logUnexpectedError("UncaughtError", event.error ?? event.message);
  event.preventDefault();
});

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
const codexStatusProvider = new CodexStatusProvider({
  timeZone: env.CODEX_STATUS_TIME_ZONE,
});
const codexAppServerClient = new CodexAppServerClient();

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
    .setName("fork")
    .setDescription("現在のCodexセッションを新しいスレッドへ分岐します")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Codexの利用制限を確認します")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("active-threads")
    .setDescription("現在アクティブな作業スレッドを確認します")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("close")
    .setDescription("現在のスレッドをクローズします")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads)
    .toJSON(),
];

client.on("error", (error) => {
  logUnexpectedError("DiscordClient", error);
});

client.once(Events.ClientReady, (readyClient) => {
  void runSafely("ClientReady", async () => {
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
});

client.on(Events.InteractionCreate, (interaction) => {
  void runSafely("InteractionCreate", async () => {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    }
  });
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

  if (commandName === "fork") {
    await handleFork(interaction);
    return;
  }

  if (commandName === "status") {
    await handleStatus(interaction);
    return;
  }

  if (commandName === "active-threads") {
    await handleActiveThreads(interaction);
    return;
  }

  if (commandName === "close") {
    if (!interaction.channel || !interaction.channel.isThread()) {
      await interaction.reply("このコマンドはスレッド内でのみ使用できます。");
      return;
    }
    const thread = interaction.channel;
    await interaction.deferReply();
    const result = await admin.closeThread(thread.id);
    if (result.isErr()) {
      await interaction.editReply("クローズに失敗しました。");
      return;
    }
    try {
      if (!thread.archived) {
        await thread.setArchived(true, "/close command");
      }
    } catch (error) {
      await interaction.editReply(
        `内部クローズは完了しましたが、Discordスレッドのクローズに失敗しました: ${
          (error as Error).message
        }`,
      );
      return;
    }
    await interaction.editReply("✅ スレッドをクローズしました。");
    return;
  }
}

async function handleStatus(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await getAndApplyCodexStatus(Deno.cwd());
  if (result.isErr()) {
    await interaction.editReply(formatCodexStatusError(result.error));
    return;
  }
  await interaction.editReply(
    `\`\`\`kotlin\n${formatCodexStatus(result.value)}\n\`\`\``,
  );
}

async function getAndApplyCodexStatus(cwd: string) {
  const result = await getCodexStatusWithAutoUpdate(
    cwd,
    codexStatusProvider,
    updateCodexCli,
  );
  if (result.isErr()) {
    console.error(
      "[CodexStatus] failed",
      formatCodexStatusErrorForLog(result.error),
    );
    return result;
  }
  updateDiscordPresence(result.value);
  return result;
}

function formatCodexStatusErrorForLog(
  error: CodexStatusWithAutoUpdateError,
): CodexStatusWithAutoUpdateError {
  if (error.type === "AUTO_UPDATE_FAILED") {
    return {
      ...error,
      statusError: formatCodexStatusErrorForLog(
        error.statusError,
      ) as typeof error.statusError,
      updateError: formatCodexUpdateErrorForLog(error.updateError),
    };
  }
  if (!("output" in error)) {
    return error;
  }
  return {
    ...error,
    output: truncateLogOutput(error.output),
  };
}

function formatCodexUpdateErrorForLog(
  error: CodexUpdateError,
): CodexUpdateError {
  if (!("output" in error)) {
    return error;
  }
  return {
    ...error,
    output: truncateLogOutput(error.output),
  };
}

function truncateLogOutput(output: string): string {
  const cleaned = stripTerminalControlSequences(output)
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= 10) return cleaned;
  return `${cleaned.slice(0, 10)}...`;
}

function formatCodexStatusError(
  error: CodexStatusWithAutoUpdateError,
): string {
  if (error.type === "AUTO_UPDATE_FAILED") {
    return "Codex status の取得に失敗しました。Codex CLI の自動更新も失敗しました。";
  }
  if (error.type === "UPDATE_REQUIRED") {
    return [
      "Codex CLI の update 通知で status を取得できませんでした。",
      "Codex CLI の自動更新を試しましたが、再取得できませんでした。",
    ].join("\n");
  }
  return "Codex status の取得に失敗しました。";
}

function formatCodexStatusUnavailableNote(
  error?: CodexStatusWithAutoUpdateError,
): string {
  if (
    error?.type !== "UPDATE_REQUIRED" &&
    error?.type !== "AUTO_UPDATE_FAILED"
  ) {
    return "";
  }
  return error.type === "AUTO_UPDATE_FAILED"
    ? "Codex limit の取得に失敗し、Codex CLI の自動更新も失敗しました。"
    : "Codex limit の取得に失敗しました。Codex CLI の自動更新後も再取得できませんでした。";
}

function updateDiscordPresence(status: CodexUsageStatus): void {
  client.user?.setPresence({
    status: "online",
    activities: [{
      type: ActivityType.Watching,
      name: formatCodexStatusPresence(status),
    }],
  });
}

async function handleActiveThreads(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const threadIds = admin.getActiveThreadIds();
  if (threadIds.length === 0) {
    await interaction.editReply("アクティブな作業スレッドはありません。");
    return;
  }

  const sentThreads: string[] = [];
  const failedThreads: string[] = [];
  const mention = interaction.user.toString();

  for (const threadId of threadIds) {
    try {
      const channel = await interaction.client.channels.fetch(threadId);
      if (!channel || !channel.isThread()) {
        failedThreads.push(`${threadId}: スレッドを取得できませんでした`);
        continue;
      }
      if (channel.archived) {
        failedThreads.push(`${channel.name}: アーカイブ済みです`);
        continue;
      }

      await sendThreadMessage(channel, {
        content: `${mention} active thread check`,
        allowedMentions: { users: [interaction.user.id] },
        flags: MessageFlags.SuppressNotifications,
      });
      sentThreads.push(channel.name);
    } catch (error) {
      failedThreads.push(`${threadId}: ${(error as Error).message}`);
    }
  }

  const lines = [
    `アクティブな作業スレッド: ${threadIds.length} 件`,
    `silent mention 送信済み: ${sentThreads.length} 件`,
  ];
  if (failedThreads.length > 0) {
    lines.push(`送信失敗: ${failedThreads.length} 件`);
    lines.push(...failedThreads.slice(0, 10));
    if (failedThreads.length > 10) {
      lines.push(`...他 ${failedThreads.length - 10} 件`);
    }
  }

  await interaction.editReply(lines.join("\n"));
}

const DISCORD_THREAD_NAME_MAX_LENGTH = 100;

interface ThreadCreatableChannel {
  threads: {
    create(options: {
      name: string;
      autoArchiveDuration: ThreadAutoArchiveDuration;
      reason: string;
    }): Promise<ThreadChannel>;
  };
}

function canCreateThreads(channel: unknown): channel is ThreadCreatableChannel {
  return !!channel && typeof channel === "object" && "threads" in channel;
}

function createForkThreadName(sourceName: string): string {
  const suffix = `-fork-${Date.now()}`;
  const baseName = sourceName.trim() || "codex-thread";
  const maxBaseLength = Math.max(
    1,
    DISCORD_THREAD_NAME_MAX_LENGTH - suffix.length,
  );
  return `${baseName.slice(0, maxBaseLength)}${suffix}`;
}

function formatCodexAppServerError(error: CodexAppServerError): string {
  switch (error.type) {
    case "APP_SERVER_START_FAILED":
      return `codex app-server の起動に失敗しました: ${
        formatErrorDetail(error.error)
      }`;
    case "APP_SERVER_PROTOCOL_ERROR":
      return `codex app-server の応答を解釈できませんでした: ${
        formatErrorDetail(error.error)
      }`;
    case "APP_SERVER_ERROR":
      return `codex app-server がエラーを返しました: ${
        formatErrorDetail(error.message)
      }${error.code === undefined ? "" : ` (code: ${error.code})`}`;
    case "APP_SERVER_TIMEOUT":
      return `codex app-server の ${error.operation} がタイムアウトしました。`;
  }
}

async function cleanupFailedForkThread(
  thread: ThreadChannel,
  threadId: string,
): Promise<void> {
  await workspaceManager.removeWorktree(threadId).catch((error) => {
    console.error("[Fork] failed to remove fork worktree", error);
  });
  if (!thread.archived) {
    await thread.setArchived(true, "fork failed").catch((error) => {
      console.error("[Fork] failed to archive failed fork thread", error);
    });
  }
}

async function handleFork(interaction: ChatInputCommandInteraction) {
  if (!interaction.channel || !interaction.channel.isThread()) {
    await interaction.reply("このコマンドはスレッド内でのみ使用できます。");
    return;
  }

  const sourceThread = interaction.channel as ThreadChannel;
  const parent = sourceThread.parent;
  if (!canCreateThreads(parent)) {
    await interaction.reply(
      "このスレッドの親チャンネルではforkを作成できません。",
    );
    return;
  }

  await interaction.deferReply();

  const sourceState = await workspaceManager.loadWorkerState(sourceThread.id);
  if (!sourceState || sourceState.status === "archived") {
    await interaction.editReply(
      "このスレッドの作業状態が見つかりません。/start で新規に開始してください。",
    );
    return;
  }

  if (
    !sourceState.repository ||
    !sourceState.repositoryLocalPath ||
    !sourceState.worktreePath
  ) {
    await interaction.editReply(
      "このスレッドにはリポジトリが設定されていないためforkできません。",
    );
    return;
  }

  const sourceCodexThreadId = sourceState.sessionId?.trim();
  if (!sourceCodexThreadId) {
    await interaction.editReply(
      "まだCodexセッションがありません。先に通常メッセージでCodexを一度実行してください。",
    );
    return;
  }

  let forkThread: ThreadChannel | null = null;
  try {
    forkThread = await parent.threads.create({
      name: createForkThreadName(sourceThread.name),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `${sourceThread.name}からのCodex fork`,
    });

    const worktreePath = await workspaceManager.forkWorktreeCopy(
      sourceState.worktreePath,
      forkThread.id,
      `fork-${forkThread.id}`,
    );

    const forkResult = await codexAppServerClient.forkThread({
      threadId: sourceCodexThreadId,
      cwd: worktreePath,
      runtimeWorkspaceRoots: [worktreePath],
    });
    if (forkResult.isErr()) {
      await cleanupFailedForkThread(forkThread, forkThread.id);
      await interaction.editReply(formatCodexAppServerError(forkResult.error));
      return;
    }

    const workerResult = await admin.createForkedWorker(
      sourceThread.id,
      forkThread.id,
      forkResult.value.threadId,
      worktreePath,
    );
    if (workerResult.isErr()) {
      await cleanupFailedForkThread(forkThread, forkThread.id);
      await interaction.editReply(
        formatAdminErrorForDiscord(workerResult.error),
      );
      return;
    }

    await interaction.editReply(
      [
        `✅ forkを作成しました: ${forkThread.toString()}`,
        `Codex thread: ${forkResult.value.threadId}`,
      ].join("\n"),
    );
    await sendThreadMessage(
      forkThread,
      [
        `${sourceThread.toString()} から分岐しました。`,
        "次のメッセージからforkしたCodexコンテキストで再開します。",
      ].join("\n"),
    );
  } catch (error) {
    if (forkThread) {
      await cleanupFailedForkThread(forkThread, forkThread.id);
    }
    await interaction.editReply(
      `forkの作成に失敗しました: ${
        formatErrorDetail(formatUnknownError(error))
      }`,
    );
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
  await sendThreadMessage(
    thread,
    `こんにちは！ 準備バッチリだよ！ ${repository.fullName} について何でも聞いてね～！`,
  );
}

client.on(Events.ThreadUpdate, (oldThread, newThread) => {
  void runSafely("ThreadUpdate", async () => {
    if (!oldThread.archived && newThread.archived) {
      const threadInfo = await workspaceManager.loadThreadInfo(newThread.id);
      if (threadInfo?.status === "archived") return;
      await admin.terminateThread(newThread.id);
    }
  });
});

client.on(Events.MessageCreate, (message) => {
  void runSafely("MessageCreate", async () => {
    if (message.author.bot) return;
    if (!message.channel.isThread()) return;
    if (message.content.startsWith("!")) return;

    const thread = message.channel as ThreadChannel;
    const threadId = thread.id;
    const workerResult = admin.getWorker(threadId);
    if (workerResult.isErr()) {
      const threadInfo = await workspaceManager.loadThreadInfo(threadId);
      if (threadInfo) {
        await sendThreadMessage(
          thread,
          "このスレッドはアクティブではありません。/start で新規に開始してください。",
        );
      }
      return;
    }

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
        const sent = await sendThreadMessage(thread, {
          content: chunk,
          flags: MessageFlags.SuppressNotifications,
        });
        lastProgressMessageUrl = sent.url;
      }
    };

    const onReaction = async (emoji: string) => {
      await message.react(emoji).catch(() => {});
    };

    const startStatusResult = await getAndApplyCodexStatus(Deno.cwd());
    const startStatus = startStatusResult.isOk()
      ? startStatusResult.value
      : null;

    const attachmentInputs = getAttachmentDownloadInputs(message);
    let savedAttachments: SavedAttachment[] = [];
    if (attachmentInputs.length > 0) {
      await onProgress(
        `📎 添付ファイル ${attachmentInputs.length} 件を保存しています...`,
      );
      try {
        savedAttachments = await workspaceManager.saveMessageAttachments(
          threadId,
          message.id,
          attachmentInputs,
        );
        await onReaction("📎");
      } catch (error) {
        await sendThreadMessage(
          thread,
          `添付ファイルの保存に失敗しました: ${(error as Error).message}`,
        );
        return;
      }
    }

    const result = await admin.routeMessage(
      threadId,
      message.content,
      savedAttachments,
      onProgress,
      onReaction,
    );

    if (result.isErr()) {
      if (result.error.type === "WORKER_NOT_FOUND") {
        const threadInfo = await workspaceManager.loadThreadInfo(threadId);
        if (threadInfo) {
          await sendThreadMessage(
            thread,
            "このスレッドはアクティブではありません。/start で新規に開始してください。",
          );
        }
        return;
      }
      if (result.error.type === "RATE_LIMIT") {
        await sendThreadMessage(thread, admin.createRateLimitMessage());
        return;
      }
      for (
        const chunk of chunkDiscordContent(
          formatAdminErrorForDiscord(result.error),
        )
      ) {
        await sendThreadMessage(thread, {
          content: chunk,
          flags: MessageFlags.SuppressNotifications,
        });
      }
      return;
    }

    const reply = result.value;
    const replyContent = typeof reply === "string" ? reply : reply.content;
    const endStatusResult = await getAndApplyCodexStatus(Deno.cwd());
    const endStatus = endStatusResult.isOk() ? endStatusResult.value : null;
    const finalReply = replyContent.trim() === MESSAGES.NO_FINAL_RESPONSE &&
        lastProgressMessageUrl
      ? `Codexの最終テキストを取得できなかったため、直近の出力を参照してください。\n> ${lastProgressMessageUrl}`
      : replyContent;
    const statusUnavailableNote = formatCodexStatusUnavailableNote(
      endStatusResult.isErr()
        ? endStatusResult.error
        : startStatusResult.isErr()
        ? startStatusResult.error
        : undefined,
    );
    const replyWithStatus = startStatus && endStatus
      ? `${finalReply}\n\`\`\`kotlin\n${
        formatCodexStatusDelta(startStatus, endStatus)
      }\n\`\`\``
      : statusUnavailableNote
      ? `${finalReply}\n${statusUnavailableNote}`
      : finalReply;
    const chunks = chunkDiscordContent(replyWithStatus);
    if (chunks.length === 0) return;
    await replyToThreadMessage(message, chunks[0]);
    for (const chunk of chunks.slice(1)) {
      await sendThreadMessage(thread, chunk);
    }
  });
});

void client.login(env.DISCORD_TOKEN).catch((error) => {
  logUnexpectedError("DiscordLogin", error);
  Deno.exit(1);
});
