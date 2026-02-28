import { assertEquals } from "std/assert/mod.ts";
import { CodexRateLimitStatusProvider } from "./codex-rate-limit-status.ts";

function formatLocalTime(date: Date, includeDate: boolean): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");

  if (includeDate) {
    return `${month}/${day} ${hour}:${minute}`;
  }

  return `${hour}:${minute}`;
}

Deno.test("CodexRateLimitStatusProvider - Discord表示用の文字列を整形する", async () => {
  const now = Date.UTC(2026, 1, 28, 3, 4, 0);
  const provider = new CodexRateLimitStatusProvider({
    now: () => now,
    pythonCommands: ["python3"],
    commandRunner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        limit_5h: {
          used_percent: 84.7,
          seconds_until_reset: 90 * 60,
          outdated: false,
        },
        limit_weekly: {
          used_percent: 22.0,
          seconds_until_reset: 26 * 60 * 60,
          outdated: false,
        },
      }),
      stderr: "",
    }),
  });

  const expected = [
    `5h残り15.3%(${formatLocalTime(new Date(now + 90 * 60 * 1000), false)})`,
    `1w残り78.0%(${
      formatLocalTime(new Date(now + 26 * 60 * 60 * 1000), true)
    })`,
  ].join(" ");

  assertEquals(await provider.getStatusText(), expected);
});

Deno.test("CodexRateLimitStatusProvider - リセット済みの窓は済表示にする", async () => {
  const provider = new CodexRateLimitStatusProvider({
    pythonCommands: ["python3"],
    commandRunner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        limit_5h: {
          used_percent: 100,
          seconds_until_reset: 0,
          outdated: true,
        },
      }),
      stderr: "",
    }),
  });

  assertEquals(
    await provider.getStatusText(),
    "5h残り100.0%(済) 1w残り--.-%(--)",
  );
});

Deno.test("CodexRateLimitStatusProvider - 取得失敗時は短いフォールバックを返す", async () => {
  const provider = new CodexRateLimitStatusProvider({
    pythonCommands: ["python3"],
    commandRunner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        error: "No token_count events found in session files",
      }),
      stderr: "",
    }),
  });

  assertEquals(await provider.getStatusText(), "RL取得不可");
});
