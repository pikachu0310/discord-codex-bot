#!/usr/bin/env -S deno run --allow-run --allow-env

/**
 * deno fmt のラッパースクリプト
 * 成功時の出力を最小限に抑えてトークン数を節約する
 */

const args = Deno.args;
const quietArgs = [...args];

// -q/--quiet オプションがなければ追加
if (!args.includes("-q") && !args.includes("--quiet")) {
  quietArgs.push("-q");
}

// deno fmt コマンドを実行
const command = new Deno.Command("deno", {
  args: ["fmt", ...quietArgs],
  stdout: "piped",
  stderr: "piped",
});

const { code, stdout, stderr } = await command.output();

const decoder = new TextDecoder();
const stdoutText = decoder.decode(stdout);
const stderrText = decoder.decode(stderr);

// エラー時は全ての出力を表示
if (code !== 0) {
  if (stdoutText) console.log(stdoutText);
  if (stderrText) console.error(stderrText);
  Deno.exit(code);
}

// 成功時は簡潔なメッセージのみ
const isCheckMode = args.includes("--check");
if (isCheckMode) {
  console.log("✅ Format check passed");
} else {
  console.log("✅ Code formatted");
}

Deno.exit(code);
