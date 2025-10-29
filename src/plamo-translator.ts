/**
 * PLaMo-2-translate APIクライアント
 * mlx_lm.serverで立てたPLaMo-2-translateと通信して日本語から英語への翻訳を行う
 */

import { err, ok, Result } from "neverthrow";
import { PLAMO_TRANSLATOR } from "./constants.ts";

/**
 * PLaMoTranslatorエラーの型定義
 */
export type PLaMoTranslatorError =
  | { type: "URL_NOT_SET" }
  | { type: "API_REQUEST_FAILED"; status: number; statusText: string }
  | { type: "INVALID_RESPONSE"; details: string }
  | { type: "NETWORK_ERROR"; message: string }
  | { type: "SERVER_UNAVAILABLE" }
  | { type: "TRANSLATION_FAILED"; message: string };

export interface TranslationRequest {
  messages: Array<{
    role: "system" | "user";
    content: string;
  }>;
  temperature?: number;
  max_tokens?: number;
}

export interface TranslationResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

/**
 * TranslationResponseの型ガード
 */
function isTranslationResponse(data: unknown): data is TranslationResponse {
  if (!data || typeof data !== "object") {
    return false;
  }

  const obj = data as Record<string, unknown>;

  if (!Array.isArray(obj.choices)) {
    return false;
  }

  for (const choice of obj.choices) {
    if (!choice || typeof choice !== "object") {
      return false;
    }

    const choiceObj = choice as Record<string, unknown>;

    if (!choiceObj.message || typeof choiceObj.message !== "object") {
      return false;
    }

    const messageObj = choiceObj.message as Record<string, unknown>;

    if (typeof messageObj.content !== "string") {
      return false;
    }
  }

  return true;
}

export class PLaMoTranslator {
  private readonly baseUrl: string;
  private readonly systemPrompt: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

    // コーディング指示に特化したシステムプロンプト
    this.systemPrompt =
      `You are a Japanese to English translator specialized in software development instructions. Your task is to translate Japanese instructions into clear, technical English that is suitable for Codex Code (an AI coding assistant).

Rules for translation:
1. Preserve technical terms and programming keywords as-is (e.g., API, function, class names)
2. Keep code snippets, file paths, and URLs unchanged
3. Translate instructions to be direct and action-oriented
4. Use imperative mood for instructions (e.g., "Implement...", "Create...", "Fix...")
5. Maintain clarity and specificity for coding tasks
6. If the original text contains ambiguity, translate it to be more explicit
7. Preserve any formatting or structure in the original text

Examples:
- "認証機能を実装してください" → "Implement authentication functionality"
- "エラーハンドリングを追加して、適切なログを出力するようにしてください" → "Add error handling and ensure proper logging output"
- "src/main.tsファイルのbugを修正してください" → "Fix the bug in src/main.ts file"

Translate only the user's message. Do not add explanations or additional context.`;
  }

  /**
   * 日本語テキストを英語に翻訳
   * @param text 翻訳対象の日本語テキスト
   * @returns 翻訳された英語テキスト（エラー時は元のテキスト）
   */
  async translate(text: string): Promise<Result<string, PLaMoTranslatorError>> {
    const request: TranslationRequest = {
      messages: [
        {
          role: "system",
          content: this.systemPrompt,
        },
        {
          role: "user",
          content: text,
        },
      ],
      temperature: PLAMO_TRANSLATOR.TEMPERATURE,
      max_tokens: PLAMO_TRANSLATOR.MAX_TOKENS,
    };

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        return err({
          type: "API_REQUEST_FAILED",
          status: response.status,
          statusText: response.statusText,
        });
      }

      const responseText = await response.text();
      let data: unknown;

      try {
        data = JSON.parse(responseText);
      } catch (error) {
        return err({
          type: "INVALID_RESPONSE",
          details: `Invalid JSON: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        });
      }

      if (!isTranslationResponse(data)) {
        return err({
          type: "INVALID_RESPONSE",
          details: "Response does not match expected format",
        });
      }

      if (data.choices.length === 0) {
        return err({
          type: "TRANSLATION_FAILED",
          message: "No translation result received",
        });
      }

      return ok(data.choices[0].message.content.trim());
    } catch (error) {
      // ネットワークエラーなど
      return err({
        type: "NETWORK_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * APIサーバーへの接続を確認
   * @returns 接続可能な場合true、エラーの場合はエラー情報
   */
  async isAvailable(): Promise<Result<boolean, PLaMoTranslatorError>> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(PLAMO_TRANSLATOR.TIMEOUT_MS),
      });
      // レスポンスボディを消費してリークを防ぐ
      await response.text();

      if (response.ok) {
        return ok(true);
      } else {
        return err({ type: "SERVER_UNAVAILABLE" });
      }
    } catch (error) {
      return err({
        type: "NETWORK_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * 環境変数からPLaMoTranslatorインスタンスを作成
   * @param envUrl 環境変数のURL（例: env.PLAMO_TRANSLATOR_URL）
   * @returns PLaMoTranslatorインスタンス、またはURLが設定されていない場合はnull
   */
  static fromEnv(envUrl: string | undefined): PLaMoTranslator | null {
    if (!envUrl) {
      return null;
    }
    return new PLaMoTranslator(envUrl);
  }
}
