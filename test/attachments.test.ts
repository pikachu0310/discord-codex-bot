import { assertEquals } from "std/assert/mod.ts";
import {
  formatPromptWithAttachments,
  getCodexImagePaths,
  isCodexImageAttachment,
  sanitizeAttachmentFileName,
  type SavedAttachment,
} from "../src/attachments.ts";

Deno.test("attachments: ファイル名を保存用に安全化する", () => {
  assertEquals(
    sanitizeAttachmentFileName("../hello world.png"),
    "hello_world.png",
  );
  assertEquals(sanitizeAttachmentFileName("..//"), "attachment");
});

Deno.test("attachments: Codex に画像として渡せる形式を判定する", () => {
  assertEquals(isCodexImageAttachment("photo.png", null), true);
  assertEquals(isCodexImageAttachment("photo", "image/jpeg"), true);
  assertEquals(isCodexImageAttachment("diagram.svg", "image/svg+xml"), false);
  assertEquals(isCodexImageAttachment("notes.txt", "text/plain"), false);
});

Deno.test("attachments: プロンプトへ保存済み添付情報を追記する", () => {
  const attachments: SavedAttachment[] = [
    {
      id: "1",
      originalName: "photo.png",
      savedName: "001_1_photo.png",
      path: "/work/attachments/t/m/001_1_photo.png",
      contentType: "image/png",
      size: 123,
      url: "https://cdn.example/photo.png",
      isImage: true,
    },
    {
      id: "2",
      originalName: "notes.txt",
      savedName: "002_2_notes.txt",
      path: "/work/attachments/t/m/002_2_notes.txt",
      contentType: "text/plain",
      size: 456,
      url: "https://cdn.example/notes.txt",
      isImage: false,
    },
  ];

  const prompt = formatPromptWithAttachments("見てください", attachments);

  assertEquals(prompt.includes("見てください"), true);
  assertEquals(prompt.includes("photo.png"), true);
  assertEquals(
    prompt.includes("saved_path: /work/attachments/t/m/002_2_notes.txt"),
    true,
  );
  assertEquals(getCodexImagePaths(attachments), [
    "/work/attachments/t/m/001_1_photo.png",
  ]);
});
