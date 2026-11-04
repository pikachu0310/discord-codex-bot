import type { RESTOptions } from "discord.js";

/** One-page Discord reads. Importing this module never starts the Bot. */
export type HistoryCommand = "messages" | "threads-active" | "threads-archived";
export interface HistoryOptions {
  command: HistoryCommand;
  guild: string;
  channel: string;
  limit: number;
  before?: string;
  visibility: "public" | "private" | "joined-private";
}
export interface ReadTransport {
  get(path: `/${string}`, query?: URLSearchParams): Promise<unknown>;
}
type ObjectValue = Record<string, unknown>;

class ReadError extends Error {
  constructor(readonly code: string, readonly retryAfterMs?: number) {
    super(code);
  }
}
// Reject SDK throttling instead of allowing its internal rate-limit sleep loop.
export const historyRestOptions = {
  version: "10",
  timeout: 15_000,
  retries: 0,
  rejectOnRateLimit: (data) => {
    const delay = Math.max(
      data.retryAfter,
      data.timeToReset,
      data.sublimitTimeout,
    );
    throw new ReadError(
      "RATE_LIMITED",
      Number.isFinite(delay) && delay >= 0 ? Math.ceil(delay) : undefined,
    );
  },
} satisfies Partial<RESTOptions>;

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReadError("INVALID_RESPONSE");
  }
  return value as ObjectValue;
}
function snowflake(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{17,20}$/.test(value);
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value));
}
export function parseHistoryOptions(args: string[]): HistoryOptions {
  const [command, ...flags] = args;
  if (!["messages", "threads-active", "threads-archived"].includes(command)) {
    throw new ReadError("USAGE");
  }
  const values = new Map<string, string>();
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i];
    const value = flags[i + 1];
    if (
      !["--guild", "--channel", "--limit", "--before", "--visibility"].includes(
        key,
      ) ||
      !value || value.startsWith("--") || values.has(key)
    ) throw new ReadError("USAGE");
    values.set(key, value);
  }
  const guild = values.get("--guild");
  const channel = values.get("--channel");
  const rawLimit = values.get("--limit") ?? "100";
  const limit = Number(rawLimit);
  const before = values.get("--before");
  const visibility = values.get("--visibility") ?? "public";
  if (
    !snowflake(guild) || !snowflake(channel) || !/^\d+$/.test(rawLimit) ||
    limit < 1 || limit > 100 ||
    !["public", "private", "joined-private"].includes(visibility)
  ) throw new ReadError("USAGE");
  if (command !== "threads-archived" && values.has("--visibility")) {
    throw new ReadError("USAGE");
  }
  if (command === "threads-active" && (before || values.has("--limit"))) {
    throw new ReadError("USAGE");
  }
  if (
    before &&
    !(command === "threads-archived" && visibility !== "joined-private"
      ? timestamp(before)
      : snowflake(before))
  ) throw new ReadError("USAGE");
  return {
    command: command as HistoryCommand,
    guild,
    channel,
    limit,
    before,
    visibility: visibility as HistoryOptions["visibility"],
  };
}

function thread(value: unknown, options: HistoryOptions): ObjectValue {
  const row = object(value);
  if (
    !snowflake(row.id) || row.parent_id !== options.channel ||
    (row.guild_id !== undefined && row.guild_id !== options.guild)
  ) throw new ReadError("INVALID_RESPONSE");
  const metadata = object(row.thread_metadata);
  return {
    id: row.id,
    guild_id: options.guild,
    parent_id: row.parent_id,
    name: row.name,
    type: row.type,
    archived: metadata.archived,
    archive_timestamp: metadata.archive_timestamp,
    locked: metadata.locked,
  };
}
function message(value: unknown, channel: string): ObjectValue {
  const row = object(value);
  if (!snowflake(row.id) || row.channel_id !== channel) {
    throw new ReadError("INVALID_RESPONSE");
  }
  const author = object(row.author);
  const attachments = row.attachments === undefined ? [] : row.attachments;
  if (!Array.isArray(attachments)) throw new ReadError("INVALID_RESPONSE");
  const embeds = row.embeds === undefined ? [] : row.embeds;
  if (!Array.isArray(embeds)) throw new ReadError("INVALID_RESPONSE");
  return {
    id: row.id,
    channel_id: row.channel_id,
    timestamp: row.timestamp,
    edited_timestamp: row.edited_timestamp,
    content: row.content,
    type: row.type,
    message_reference: select(row.message_reference, [
      "message_id",
      "channel_id",
      "guild_id",
      "type",
      "fail_if_not_exists",
    ]),
    // Preserve absent vs null vs supplied; never fetch or recurse into replies.
    referenced_message: select(row.referenced_message, [
      "id",
      "channel_id",
      "guild_id",
      "type",
      "timestamp",
      "edited_timestamp",
    ]),
    thread: select(row.thread, [
      "id",
      "guild_id",
      "parent_id",
      "name",
      "type",
      "owner_id",
      "message_count",
      "member_count",
      "thread_metadata",
    ]),
    embeds: embeds.map((value) =>
      select(value, [
        "type",
        "title",
        "description",
        "url",
        "timestamp",
        "color",
        "fields",
        "image",
        "thumbnail",
        "video",
        "provider",
        "author",
        "footer",
      ])
    ),
    author: {
      id: author.id,
      username: author.username,
      bot: author.bot === true,
    },
    attachments: attachments.map((value) => {
      const file = object(value);
      return {
        id: file.id,
        filename: file.filename,
        url: file.url,
        content_type: file.content_type,
        size: file.size,
      };
    }),
  };
}

function select(
  value: unknown,
  keys: string[],
): ObjectValue | null | undefined {
  if (value === undefined || value === null) return value;
  const row = object(value);
  return Object.fromEntries(
    keys.filter((key) => key in row).map((key) => [key, row[key]]),
  );
}

export async function readHistory(options: HistoryOptions, api: ReadTransport) {
  // Check membership before requesting any messages or thread lists.
  const channel = object(await api.get(`/channels/${options.channel}`));
  if (channel.id !== options.channel || channel.guild_id !== options.guild) {
    throw new ReadError("CHANNEL_GUILD_MISMATCH");
  }
  const scope = {
    guild_id: options.guild,
    channel_id: options.channel,
    command: options.command,
    coverage: "one_request_in_bot_visible_scope",
  };
  if (options.command === "messages") {
    const query = new URLSearchParams({ limit: String(options.limit) });
    if (options.before) query.set("before", options.before);
    const result = await api.get(
      `/channels/${options.channel}/messages`,
      query,
    );
    if (!Array.isArray(result) || result.length > options.limit) {
      throw new ReadError("INVALID_RESPONSE");
    }
    const messages = result.map((row) => message(row, options.channel));
    return {
      ...scope,
      messages,
      count: messages.length,
      page_full: messages.length === options.limit,
      has_more: null,
      next_cursor: messages.at(-1)?.id ?? null,
      complete: false,
      note:
        "No end-of-history marker is supplied. An empty page does not prove that history is absent or permitted; message content may be restricted.",
    };
  }
  if (![0, 5, 15, 16].includes(channel.type as number)) {
    throw new ReadError("NOT_A_THREAD_PARENT");
  }
  if (options.command === "threads-active") {
    const result = object(
      await api.get(`/guilds/${options.guild}/threads/active`),
    );
    if (!Array.isArray(result.threads)) throw new ReadError("INVALID_RESPONSE");
    const threads = result.threads.map(object).filter((row) =>
      row.parent_id === options.channel
    )
      .map((row) => thread(row, options));
    return {
      ...scope,
      threads,
      count: threads.length,
      has_more: false,
      next_cursor: null,
      complete: false,
      note:
        "Active threads visible to this Bot under this parent only; archived and inaccessible threads are excluded.",
    };
  }
  const path = options.visibility === "joined-private"
    ? `/channels/${options.channel}/users/@me/threads/archived/private` as const
    : `/channels/${options.channel}/threads/archived/${options.visibility}` as const;
  const query = new URLSearchParams({ limit: String(options.limit) });
  if (options.before) query.set("before", options.before);
  const result = object(await api.get(path, query));
  if (
    !Array.isArray(result.threads) || typeof result.has_more !== "boolean" ||
    result.threads.length > options.limit
  ) throw new ReadError("INVALID_RESPONSE");
  const threads = result.threads.map((row) => thread(row, options));
  const last = threads.at(-1);
  const cursor = options.visibility === "joined-private"
    ? last?.id
    : last?.archive_timestamp;
  if (
    cursor !== undefined &&
    !(options.visibility === "joined-private"
      ? snowflake(cursor)
      : timestamp(cursor))
  ) {
    throw new ReadError("INVALID_RESPONSE");
  }
  return {
    ...scope,
    visibility: options.visibility,
    threads,
    count: threads.length,
    has_more: result.has_more,
    next_cursor: result.has_more ? cursor ?? null : null,
    complete: false,
    note:
      "One archived-thread page only. has_more is the API value; a null cursor with has_more=true requires investigation, not an automatic retry.",
  };
}

export function safeHistoryError(
  error: unknown,
): { code: string; status?: number; retry_after_ms?: number } {
  if (error instanceof ReadError) {
    return {
      code: error.code,
      ...(error.code === "RATE_LIMITED" ? { status: 429 } : {}),
      ...(error.retryAfterMs === undefined
        ? {}
        : { retry_after_ms: error.retryAfterMs }),
    };
  }
  if (
    error instanceof DOMException &&
    ["AbortError", "TimeoutError"].includes(error.name)
  ) {
    return { code: "TIMEOUT" };
  }
  let status: unknown;
  try {
    status = (error as { status?: unknown })?.status;
  } catch { /* no raw exception output */ }
  if (typeof status !== "number" || !Number.isInteger(status)) {
    return { code: "REQUEST_FAILED" };
  }
  const code = status === 401
    ? "AUTH_REQUIRED"
    : status === 403
    ? "ACCESS_DENIED"
    : status === 404
    ? "NOT_FOUND"
    : status === 429
    ? "RATE_LIMITED"
    : "REQUEST_FAILED";
  return { code, status };
}

if (import.meta.main && Deno.args.length === 1 && Deno.args[0] === "--help") {
  console.log(
    JSON.stringify({
      ok: true,
      read_only: true,
      commands: ["messages", "threads-active", "threads-archived"],
      required: ["--guild GUILD_ID", "--channel CHANNEL_ID"],
      paging:
        "messages: --limit 1..100 --before MESSAGE_ID; archives: --visibility public|private|joined-private --limit 1..100 --before CURSOR",
      auth:
        "Existing DISCORD_TOKEN via --env-file; never pass credentials as arguments.",
      help_accesses_credentials_or_network: false,
    }),
  );
} else if (import.meta.main) {
  let exitCode = 0;
  try {
    const options = parseHistoryOptions(Deno.args);
    const token = Deno.env.get("DISCORD_TOKEN");
    if (!token) throw new ReadError("AUTH_REQUIRED");
    const { REST } = await import("discord.js");
    const rest = new REST(historyRestOptions)
      .setToken(token);
    const signal = AbortSignal.timeout(30_000);
    const result = await readHistory(options, {
      get: (path, query) => rest.get(path, { query, signal }),
    });
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    const safe = safeHistoryError(error);
    console.log(JSON.stringify({ ok: false, error: safe }));
    exitCode = safe.code === "USAGE" ? 2 : 1;
  }
  Deno.exitCode = exitCode;
}
