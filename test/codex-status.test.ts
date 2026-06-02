import { assertEquals } from "std/assert/mod.ts";
import {
  convertCodexStatusTimeZone,
  formatCodexStatus,
  formatCodexStatusDelta,
  formatCodexStatusPresence,
  isCodexUpdatePrompt,
  normalizeTimeZone,
  parseCodexStatus,
  stripTerminalControlSequences,
} from "../src/codex-status.ts";

Deno.test("parseCodexStatus: Codex TUIのstatus表示から利用制限を抽出する", () => {
  const output = [
    "\x1b[2m│  5h limit:             \x1b[22m[███████████████░░░░░] 73% left\x1b[2m (resets 23:57)            │\x1b[m",
    "\x1b[2m│  Weekly limit:         \x1b[22m[█████████████████░░░] 83% left\x1b[2m                │\x1b[m",
    "\x1b[2m│                        (resets 18:06 on 17 May)                       │\x1b[m",
  ].join("\n");

  const result = parseCodexStatus(output);

  assertEquals(result.isOk(), true);
  const status = result._unsafeUnwrap();
  assertEquals(status.fiveHour, { percentLeft: 73, resets: "23:57" });
  assertEquals(status.weekly, {
    percentLeft: 83,
    resets: "18:06 on 17 May",
  });
});

Deno.test("formatCodexStatusDelta: 投稿前後の差分をkotlinブロック用の1行にする", () => {
  const before = {
    fiveHour: { percentLeft: 80, resets: "23:57" },
    weekly: { percentLeft: 54, resets: "18:06 on 17 May" },
    capturedAt: "2026-05-13T00:00:00.000Z",
  };
  const after = {
    fiveHour: { percentLeft: 68, resets: "23:57" },
    weekly: { percentLeft: 52, resets: "18:06 on 17 May" },
    capturedAt: "2026-05-13T00:01:00.000Z",
  };

  assertEquals(
    formatCodexStatusDelta(before, after),
    "5h limit 80% → 68% (resets 23:57)\nWeekly limit 54% → 52% (resets 18:06 on 17 May)",
  );
});

Deno.test("formatCodexStatus: /status向けにkotlinブロック用の2行にする", () => {
  assertEquals(
    formatCodexStatus({
      fiveHour: { percentLeft: 51, resets: "23:57" },
      weekly: { percentLeft: 80, resets: "18:06 on 17 May" },
      capturedAt: "2026-05-13T00:00:00.000Z",
    }),
    "5h limit: 51% left (resets 23:57)\nWeekly limit: 80% left (resets 18:06 on 17 May)",
  );
});

Deno.test("formatCodexStatusPresence: Discord status向けに短く整形する", () => {
  assertEquals(
    formatCodexStatusPresence({
      fiveHour: { percentLeft: 73, resets: "23:57" },
      weekly: { percentLeft: 83, resets: "18:06 on 17 May" },
      capturedAt: "2026-05-13T00:00:00.000Z",
    }),
    "5h 73% (23:57) / W 83% (18:06 on 17 May)",
  );
});

Deno.test("convertCodexStatusTimeZone: UTCのreset時刻を指定タイムゾーンへ変換する", () => {
  const status = convertCodexStatusTimeZone({
    fiveHour: { percentLeft: 73, resets: "23:57" },
    weekly: { percentLeft: 83, resets: "18:06 on 17 May" },
    capturedAt: "2026-05-17T18:00:00.000Z",
  }, "Asia/Tokyo");

  assertEquals(status.fiveHour.resets, "08:57");
  assertEquals(status.weekly.resets, "03:06 on 18 May");
});

Deno.test("normalizeTimeZone: JST/JTCをAsia/Tokyoとして扱う", () => {
  assertEquals(normalizeTimeZone("JST"), "Asia/Tokyo");
  assertEquals(normalizeTimeZone("JTC"), "Asia/Tokyo");
});

Deno.test("isCodexUpdatePrompt: Codexのupdate通知を検出する", () => {
  const output = [
    "✨ Update available! 0.134.0 -> 0.135.0",
    "› 1. Update now (runs `npm install -g @openai/codex`)",
    "2. Skip",
  ].join("\n");

  assertEquals(isCodexUpdatePrompt(output), true);
});

Deno.test("stripTerminalControlSequences: ANSI制御シーケンスを除去する", () => {
  assertEquals(
    stripTerminalControlSequences("\x1b[2m5h limit\x1b[m\x1b]0;title\x07"),
    "5h limit",
  );
});
