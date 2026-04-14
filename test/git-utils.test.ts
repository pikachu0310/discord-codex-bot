import { assertEquals } from "std/assert/mod.ts";
import { generateBranchName, parseRepository } from "../src/git-utils.ts";

Deno.test("parseRepository: owner/repo を解析できる", () => {
  const parsed = parseRepository("octocat/hello-world");
  if (parsed.isErr()) {
    throw new Error("parse failed");
  }
  assertEquals(parsed.value.org, "octocat");
  assertEquals(parsed.value.repo, "hello-world");
});

Deno.test("generateBranchName: workerプレフィックスを含む", () => {
  const name = generateBranchName("test-bot");
  assertEquals(name.startsWith("worker/"), true);
  assertEquals(name.includes("test-bot"), true);
});
