# Discord.js オートコンプリート機能調査

## 概要

Discord.js v14 でのオートコンプリート機能の実装方法と、GitHub API
を使ったリポジトリ候補取得の調査結果。

## 現在のプロジェクト環境

- **Discord.js バージョン**: v14.16.3 (deno.json で確認)
- **実行環境**: Deno
- **インポート方法**: `npm:discord.js@^14.16.3`

## Discord.js オートコンプリート実装方法

### 1. スラッシュコマンドでオートコンプリートを有効化

```typescript
import { SlashCommandBuilder } from "discord.js";

const data = new SlashCommandBuilder()
  .setName("start")
  .setDescription("リポジトリを指定してセッションを開始")
  .addStringOption((option) =>
    option.setName("repository")
      .setDescription("GitHub リポジトリ (例: owner/repo)")
      .setAutocomplete(true) // オートコンプリートを有効化
      .setRequired(true)
  );
```

### 2. オートコンプリートハンドラーの実装

```typescript
// インタラクションハンドラー内で
if (interaction.isAutocomplete()) {
  const focusedValue = interaction.options.getFocused();

  // GitHub API でリポジトリ検索
  const suggestions = await searchRepositories(focusedValue);

  // 最大25件の候補を返す
  await interaction.respond(
    suggestions.slice(0, 25).map((repo) => ({
      name: `${repo.full_name} - ${repo.description?.slice(0, 50) || ""}`,
      value: repo.full_name,
    })),
  );
}
```

### 3. 複数オプションでのオートコンプリート

```typescript
async autocomplete(interaction) {
  const focusedOption = interaction.options.getFocused(true);
  
  if (focusedOption.name === 'repository') {
    // リポジトリ候補の処理
    const suggestions = await searchRepositories(focusedOption.value);
    // ...
  }
  
  if (focusedOption.name === 'branch') {
    // ブランチ候補の処理（選択されたリポジトリを基に）
    const repository = interaction.options.getString('repository');
    const branches = await getBranches(repository, focusedOption.value);
    // ...
  }
}
```

## GitHub API でのリポジトリ検索

### 1. 検索エンドポイント

```
GET https://api.github.com/search/repositories
```

### 2. 検索パラメータ

- `q`: 検索クエリ
- `sort`: ソート方法 (stars, forks, updated)
- `order`: ソート順 (asc, desc)
- `per_page`: 1ページあたりの結果数 (最大100)

### 3. 実装例

```typescript
interface GitHubRepository {
  id: number;
  full_name: string;
  description: string | null;
  html_url: string;
  language: string | null;
  stargazers_count: number;
}

interface GitHubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubRepository[];
}

async function searchRepositories(query: string): Promise<GitHubRepository[]> {
  if (!query || query.length < 2) {
    return [];
  }

  try {
    const response = await fetch(
      `https://api.github.com/search/repositories?q=${
        encodeURIComponent(query)
      }&sort=stars&order=desc&per_page=10`,
      {
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "discord-codex-code-bot",
          // 認証トークンがある場合
          // 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`
        },
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data: GitHubSearchResponse = await response.json();
    return data.items;
  } catch (error) {
    console.error("GitHub API search failed:", error);
    return [];
  }
}
```

### 4. 部分一致検索の改善

```typescript
function buildSearchQuery(input: string): string {
  // owner/repo 形式の検索を優先
  if (input.includes("/")) {
    const [owner, repo] = input.split("/");
    if (repo) {
      return `${input} in:name`;
    } else {
      return `user:${owner}`;
    }
  }

  // 一般的な検索
  return `${input} in:name,description`;
}
```

## レート制限とベストプラクティス

### 1. GitHub API レート制限

- **未認証**: 60リクエスト/時間
- **認証済み**: 5,000リクエスト/時間

### 2. キャッシュ実装

```typescript
class RepositorySearchCache {
  private cache = new Map<
    string,
    { data: GitHubRepository[]; timestamp: number }
  >();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5分

  get(query: string): GitHubRepository[] | null {
    const cached = this.cache.get(query);
    if (!cached) return null;

    if (Date.now() - cached.timestamp > this.CACHE_TTL) {
      this.cache.delete(query);
      return null;
    }

    return cached.data;
  }

  set(query: string, data: GitHubRepository[]): void {
    this.cache.set(query, { data, timestamp: Date.now() });
  }
}
```

### 3. デバウンス処理

オートコンプリートは連続して呼ばれるため、適切なデバウンス処理を実装することを推奨。

## 実装上の制約と注意点

### Discord.js 制約

1. **応答時間**: オートコンプリートには3秒以内に応答する必要がある
2. **候補数制限**: 最大25件の候補まで
3. **Defer不可**: オートコンプリートインタラクションはdeferできない

### セキュリティ考慮事項

1. **入力検証**: ユーザー入力を適切にエスケープ
2. **認証情報**: GitHub トークンを環境変数で管理
3. **エラーハンドリング**: API エラー時の適切な処理

## 実装優先度

1. **Phase 1**: 基本的なリポジトリ名検索
2. **Phase 2**: キャッシュ機能の追加
3. **Phase 3**: ブランチやタグの候補追加

この調査結果を基に、discord-codex-code
プロジェクトにオートコンプリート機能を段階的に実装することが可能です。
