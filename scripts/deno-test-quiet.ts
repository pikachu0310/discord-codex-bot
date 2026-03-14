#!/usr/bin/env -S deno run --allow-run --allow-env

/**
 * deno test のラッパースクリプト
 * 成功時の出力を最小限に抑えてトークン数を節約する
 */

const args = Deno.args;
const quietArgs = [...args];

// -q/--quiet オプションがなければ追加
if (!args.includes("-q") && !args.includes("--quiet")) {
  quietArgs.push("-q");
}

// deno test コマンドを実行
const command = new Deno.Command("deno", {
  args: ["test", ...quietArgs],
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
// stdoutから実行したテスト数を抽出
const passedMatch = stdoutText.match(/(\d+) passed/);
const failedMatch = stdoutText.match(/(\d+) failed/);
const stepsMatch = stdoutText.match(/\((\d+) steps?\)/);

if (passedMatch) {
  const passed = passedMatch[1];
  const failed = failedMatch ? failedMatch[1] : "0";
  const steps = stepsMatch ? ` (${stepsMatch[1]} steps)` : "";
  const total = parseInt(passed) + parseInt(failed);
  console.log(`✅ Tests passed: ${passed}/${total}${steps}`);
} else {
  // パターンにマッチしない場合は通常の出力
  if (stdoutText) console.log(stdoutText);
}

if (stderrText) console.error(stderrText);
Deno.exit(code);
