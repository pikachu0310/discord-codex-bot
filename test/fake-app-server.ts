// Offline app-server fixture. Executed as a child process by executor tests.
import { TextLineStream } from "std/streams/text_line_stream.ts";

const scenario = Deno.args[0];
// Reproduce the npm launcher: its child inherits the RPC pipes and survives
// SIGKILL of the launcher. SIGTERM must be forwarded to release both pipes.
if (scenario === "wrapper") {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--quiet", new URL(import.meta.url).pathname, "complete"],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const forward = () => {
    try {
      child.kill("SIGTERM");
    } catch { /* exited */ }
  };
  Deno.addSignalListener("SIGTERM", forward);
  const status = await child.status;
  Deno.removeSignalListener("SIGTERM", forward);
  Deno.exit(status.code);
}
const encoder = new TextEncoder();
const send = (packet: unknown) =>
  Deno.stdout.write(encoder.encode(JSON.stringify(packet) + "\n"));
const notify = (method: string, params: unknown) => send({ method, params });
const complete = async (status = "completed") => {
  await notify("item/completed", {
    threadId: "thread-1",
    item: {
      type: "agentMessage",
      phase: "final_answer",
      text: "最終返信です。",
    },
  });
  await notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status, error: { message: "turn failed" } },
  });
};
let initialized = false;
for await (
  const line of Deno.stdin.readable.pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream())
) {
  const packet = JSON.parse(line);
  if (packet.method === "initialize") {
    if (scenario === "exit") Deno.exit(1);
    await send({ id: packet.id, result: {} });
  } else if (packet.method === "account/rateLimits/read") {
    await send({
      id: packet.id,
      result: {
        rateLimitsByLimitId: {
          codex: {
            primary: {
              usedPercent: 20,
              windowDurationMins: 300,
              resetsAt: 1793318400,
            },
            secondary: {
              usedPercent: 35,
              windowDurationMins: 10080,
              resetsAt: 1793404800,
            },
          },
        },
      },
    });
  } else if (packet.method === "initialized") {
    initialized = true;
  } else if (["thread/start", "thread/resume"].includes(packet.method)) {
    if (!initialized) throw new Error("Missing initialized handshake");
    await notify("test/thread", packet.params);
    await send({ id: packet.id, result: { thread: { id: "thread-1" } } });
  } else if (packet.method === "turn/start") {
    await notify("test/input", packet.params);
    await notify("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-1" },
    });
    await send({ id: packet.id, result: { turn: { id: "turn-1" } } });
    if (scenario === "async-questions" || scenario === "async-idle") {
      const text = packet.params.input[0].text;
      if (text.startsWith("質問「")) {
        await notify("test/answer-input", { text });
        await complete();
      } else {
        await notify("item/completed", {
          threadId: "thread-1",
          item: {
            id: "async-question-1",
            type: "agentMessage",
            phase: "final_answer",
            delivery: "async",
            text: "確認用の色は？\n- 青\n- 緑",
            questions: [{ title: "確認用の色は？", options: ["青", "緑"] }],
          },
        });
        if (scenario === "async-idle") {
          await notify("turn/completed", {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed" },
          });
        }
      }
    } else if (scenario === "questions" || scenario === "resolved") {
      await send({
        id: "question-request",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "language",
              header: "言語",
              question: "どちらにしますか？",
              options: [
                { label: "日本語", description: "日本語で回答" },
                { label: "英語", description: "英語で回答" },
              ],
            },
            {
              id: "details",
              header: "詳細",
              question: "補足を教えてください",
              options: null,
            },
          ],
        },
      });
      if (scenario === "resolved") {
        await notify("serverRequest/resolved", {
          threadId: "thread-1",
          requestId: "question-request",
        });
        await notify("test/resolved", {});
      }
    } else if (scenario === "complete") {
      await complete();
    } else if (scenario === "failed") {
      await complete("failed");
    } else if (scenario === "disconnect") {
      Deno.exit(1);
    } else if (scenario === "early-input") {
      // Turn/start replies may arrive before the first ready notification.
      await notify("test/ready", {});
    } else {
      await notify("test/ready", {});
    }
  } else if (packet.method === "turn/steer") {
    await notify("test/steer", packet.params);
    if (scenario === "race") {
      await complete();
      await send({
        id: packet.id,
        error: { code: -32600, message: "No active turn" },
      });
    } else if (scenario === "steer-error") {
      await send({
        id: packet.id,
        error: { code: -32600, message: "Rejected input" },
      });
    } else {
      await send({ id: packet.id, result: { turnId: "turn-1" } });
      await complete();
    }
  } else if (packet.method === "turn/interrupt") {
    await notify("test/interrupted", {});
    await send({ id: packet.id, result: {} });
    await complete("interrupted");
  } else if (packet.id === "question-request") {
    if (packet.error) throw new Error("Question was not handled");
    await notify("test/answer", packet.result);
    await notify("serverRequest/resolved", {
      threadId: "thread-1",
      requestId: packet.id,
    });
    await complete();
  } else {
    throw new Error(
      `Unexpected packet: ${JSON.stringify(packet)}`,
    );
  }
}
