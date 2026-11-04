import type { ResponseLike } from "discord.js";
import { assertEquals, assertRejects, assertThrows } from "std/assert/mod.ts";
import {
  historyRestOptions,
  parseHistoryOptions,
  readHistory,
  type ReadTransport,
  safeHistoryError,
} from "../src/read-history.ts";
const guild = "100000000000000001";
const channel = "100000000000000002";
const older = "100000000000000003";
const last = "100000000000000004";
function transport(responses: unknown[]) {
  const calls: Array<{ path: string; query: string }> = [];
  const api: ReadTransport = {
    get(path, query) {
      calls.push({ path, query: query?.toString() ?? "" });
      if (!responses.length) throw new Error("unexpected GET");
      return Promise.resolve(responses.shift());
    },
  };
  return { api, calls };
}
function options(command = "messages", ...extra: string[]) {
  return parseHistoryOptions([
    command,
    "--guild",
    guild,
    "--channel",
    channel,
    ...extra,
  ]);
}
function thread(id = last, parent = channel) {
  return {
    id,
    parent_id: parent,
    guild_id: guild,
    name: "sample",
    type: 11,
    thread_metadata: {
      archived: true,
      archive_timestamp: "2026-01-01T00:00:00.000Z",
      locked: false,
    },
  };
}
Deno.test("history arguments require explicit scope and bounded cursors", () => {
  assertThrows(() => parseHistoryOptions(["messages"]));
  assertThrows(() => options("messages", "--limit", "101"));
  assertThrows(() => options("threads-active", "--before", older));
  assertThrows(() => options("threads-archived", "--before", older));
  assertThrows(() => options("messages", "--token", "never-accepted"));
  assertEquals(options("messages", "--limit", "1").limit, 1);
});
Deno.test("history checks guild before requesting body", async () => {
  const { api, calls } = transport([{ id: channel, guild_id: older }]);
  await assertRejects(() => readHistory(options(), api));
  assertEquals(calls.length, 1);
});
Deno.test("messages use one bounded GET and preserve uncertain coverage", async () => {
  const { api, calls } = transport([{ id: channel, guild_id: guild }, [{
    id: last,
    channel_id: channel,
    content: "synthetic",
    author: { id: older, username: "sample" },
    attachments: [],
  }]]);
  const result = await readHistory(
    options("messages", "--limit", "1", "--before", older),
    api,
  );
  assertEquals(calls, [{ path: `/channels/${channel}`, query: "" }, {
    path: `/channels/${channel}/messages`,
    query: `limit=1&before=${older}`,
  }]);
  assertEquals(result.has_more, null);
  assertEquals(result.next_cursor, last);
  assertEquals(result.complete, false);
});
Deno.test("active threads filter the requested parent", async () => {
  const { api, calls } = transport([
    { id: channel, guild_id: guild, type: 15 },
    { threads: [thread(), thread(older, older)] },
  ]);
  const result = await readHistory(options("threads-active"), api);
  assertEquals(result.count, 1);
  assertEquals(calls[1].path, `/guilds/${guild}/threads/active`);
});
Deno.test("archive preserves API has_more and timestamp cursor", async () => {
  const { api, calls } = transport([{ id: channel, guild_id: guild, type: 0 }, {
    threads: [thread()],
    has_more: true,
  }]);
  const result = await readHistory(
    options("threads-archived", "--limit", "1"),
    api,
  );
  assertEquals(result.has_more, true);
  assertEquals(result.next_cursor, "2026-01-01T00:00:00.000Z");
  assertEquals(calls[1].path, `/channels/${channel}/threads/archived/public`);
});
Deno.test("joined archive uses a snowflake cursor without joining", async () => {
  const { api, calls } = transport([{ id: channel, guild_id: guild, type: 0 }, {
    threads: [thread()],
    has_more: false,
  }]);
  const result = await readHistory(
    options(
      "threads-archived",
      "--visibility",
      "joined-private",
      "--before",
      older,
    ),
    api,
  );
  assertEquals(
    calls[1].path,
    `/channels/${channel}/users/@me/threads/archived/private`,
  );
  assertEquals(calls[1].query, `limit=100&before=${older}`);
  assertEquals(result.has_more, false);
  assertEquals(result.next_cursor, null);
});
Deno.test("errors never expose upstream authorization or exception text", () => {
  assertEquals(
    safeHistoryError({
      status: 403,
      message: "Authorization: Bot synthetic-secret",
    }),
    { code: "ACCESS_DENIED", status: 403 },
  );
  assertEquals(safeHistoryError(new Error("synthetic-secret")), {
    code: "REQUEST_FAILED",
  });
});

Deno.test("REST options reject throttling without sleeping and report Retry-After", () => {
  assertEquals(historyRestOptions.retries, 0);
  assertEquals(historyRestOptions.timeout, 15_000);
  try {
    historyRestOptions.rejectOnRateLimit({
      retryAfter: 2000,
      timeToReset: 1500,
      sublimitTimeout: 0,
      global: false,
      limit: 1,
      majorParameter: "synthetic",
      method: "GET",
      hash: "synthetic",
      route: "/channels/:id/messages",
      url: "https://discord.com/api/v10/channels/synthetic/messages",
      scope: "shared",
    });
    throw new Error("throttling was not rejected");
  } catch (error) {
    assertEquals(safeHistoryError(error), {
      code: "RATE_LIMITED",
      status: 429,
      retry_after_ms: 2000,
    });
  }
});

Deno.test("SDK transport sends GET once and rejects synthetic 429 without HTTP", async () => {
  const { REST } = await import("discord.js");
  let requests = 0;
  const rest = new REST({
    ...historyRestOptions,
    makeRequest: (_url, init) => {
      requests++;
      assertEquals(init.method, "GET");
      return Promise.resolve(
        new Response(JSON.stringify({ retry_after: 60, global: false }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "60" },
        }) as unknown as ResponseLike,
      );
    },
  }).setToken("synthetic-test-token");
  try {
    const error = await assertRejects(() => rest.get(`/channels/${channel}`));
    const safe = safeHistoryError(error);
    assertEquals(safe.code, "RATE_LIMITED");
    assertEquals(safe.status, 429);
    assertEquals(typeof safe.retry_after_ms, "number");
    assertEquals(requests, 1);
  } finally {
    rest.clearHashSweeper();
    rest.clearHandlerSweeper();
  }
});
