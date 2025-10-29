const decoder = new TextDecoder();

let cachedHelpText: string | null = null;
let helpDetectionAttempted = false;
let cachedOutputFormatSupport: boolean | null = null;
let cachedVerboseSupport: boolean | null = null;
let cachedDangerouslySkipPermissionsSupport: boolean | null = null;

function getEnvOverride(): boolean | null {
  const override = Deno.env.get("CODEX_CLI_OUTPUT_FORMAT_MODE");
  if (!override) {
    return null;
  }
  switch (override.trim().toLowerCase()) {
    case "always":
    case "enable":
    case "true":
    case "1":
      return true;
    case "never":
    case "disable":
    case "false":
    case "0":
      return false;
    case "auto":
    default:
      return null;
  }
}

function getCodexCliHelpText(): string | null {
  if (helpDetectionAttempted) {
    return cachedHelpText;
  }

  helpDetectionAttempted = true;

  try {
    const command = new Deno.Command("codex", {
      args: ["--help"],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = command.outputSync();
    if (code === 0) {
      cachedHelpText = decoder.decode(stdout);
      return cachedHelpText;
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      cachedHelpText = null;
      return null;
    }
  }

  // ヘルプテキストが取得できない場合はnullとする
  cachedHelpText = null;
  return null;
}

export function shouldUseOutputFormatFlag(): boolean {
  const envOverride = getEnvOverride();
  if (envOverride !== null) {
    cachedOutputFormatSupport = envOverride;
    return envOverride;
  }

  if (cachedOutputFormatSupport !== null) {
    return cachedOutputFormatSupport;
  }

  const helpText = getCodexCliHelpText();
  if (helpText !== null) {
    cachedOutputFormatSupport = helpText.includes("--output-format");
    return cachedOutputFormatSupport;
  }

  // Codex CLIが存在しない場合などは従来の挙動を維持する
  cachedOutputFormatSupport = true;
  return cachedOutputFormatSupport;
}

export function shouldUseVerboseFlag(): boolean {
  if (cachedVerboseSupport !== null) {
    return cachedVerboseSupport;
  }

  const helpText = getCodexCliHelpText();
  if (helpText !== null) {
    cachedVerboseSupport = helpText.includes("--verbose");
    return cachedVerboseSupport;
  }

  cachedVerboseSupport = true;
  return cachedVerboseSupport;
}

export function shouldUseDangerouslySkipPermissionsFlag(): boolean {
  if (cachedDangerouslySkipPermissionsSupport !== null) {
    return cachedDangerouslySkipPermissionsSupport;
  }

  const helpText = getCodexCliHelpText();
  if (helpText !== null) {
    cachedDangerouslySkipPermissionsSupport = helpText.includes(
      "--dangerously-skip-permissions",
    );
    return cachedDangerouslySkipPermissionsSupport;
  }

  cachedDangerouslySkipPermissionsSupport = true;
  return cachedDangerouslySkipPermissionsSupport;
}

export function resetOutputFormatDetectionForTests(): void {
  cachedHelpText = null;
  helpDetectionAttempted = false;
  cachedOutputFormatSupport = null;
  cachedVerboseSupport = null;
  cachedDangerouslySkipPermissionsSupport = null;
}

export function recordVerboseFlagUnsupportedForTests(): void {
  cachedVerboseSupport = false;
}

export function recordDangerouslySkipPermissionsUnsupportedForTests(): void {
  cachedDangerouslySkipPermissionsSupport = false;
}
