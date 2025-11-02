const decoder = new TextDecoder();

let cachedHelpText: string | null = null;
let helpDetectionAttempted = false;

let cachedExecHelpText: string | null = null;
let execHelpDetectionAttempted = false;

let cachedExecJsonSupport: boolean | null = null;
let cachedExecColorSupport: boolean | null = null;
let cachedExecResumeSupport: boolean | null = null;
let cachedDangerouslyBypassSupport: boolean | null = null;
let cachedSearchFlagSupport: boolean | null = null;

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

function getCodexExecHelpText(): string | null {
  if (execHelpDetectionAttempted) {
    return cachedExecHelpText;
  }

  execHelpDetectionAttempted = true;

  try {
    const command = new Deno.Command("codex", {
      args: ["exec", "--help"],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = command.outputSync();
    if (code === 0) {
      cachedExecHelpText = decoder.decode(stdout);
      return cachedExecHelpText;
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      cachedExecHelpText = null;
      return null;
    }
  }

  cachedExecHelpText = null;
  return null;
}

export function supportsExecJsonMode(): boolean {
  if (cachedExecJsonSupport !== null) {
    return cachedExecJsonSupport;
  }

  const helpText = getCodexExecHelpText();
  if (helpText !== null) {
    cachedExecJsonSupport = helpText.includes("--json") ||
      helpText.includes("--experimental-json");
    return cachedExecJsonSupport;
  }

  // CLIが利用できない場合は最新仕様を前提にtrueとする
  cachedExecJsonSupport = true;
  return cachedExecJsonSupport;
}

export function supportsExecColorFlag(): boolean {
  if (cachedExecColorSupport !== null) {
    return cachedExecColorSupport;
  }

  const helpText = getCodexExecHelpText();
  if (helpText !== null) {
    cachedExecColorSupport = helpText.includes("--color");
    return cachedExecColorSupport;
  }

  cachedExecColorSupport = true;
  return cachedExecColorSupport;
}

export function supportsExecResumeSubcommand(): boolean {
  if (cachedExecResumeSupport !== null) {
    return cachedExecResumeSupport;
  }

  const helpText = getCodexExecHelpText();
  if (helpText !== null) {
    cachedExecResumeSupport = helpText.includes("resume");
    return cachedExecResumeSupport;
  }

  cachedExecResumeSupport = true;
  return cachedExecResumeSupport;
}

export function supportsDangerouslyBypassFlag(): boolean {
  if (cachedDangerouslyBypassSupport !== null) {
    return cachedDangerouslyBypassSupport;
  }

  const helpText = getCodexExecHelpText();
  if (helpText !== null) {
    cachedDangerouslyBypassSupport = helpText.includes(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    return cachedDangerouslyBypassSupport;
  }

  cachedDangerouslyBypassSupport = true;
  return cachedDangerouslyBypassSupport;
}

export function supportsSearchFlag(): boolean {
  if (cachedSearchFlagSupport !== null) {
    return cachedSearchFlagSupport;
  }

  const helpText = getCodexCliHelpText();
  if (helpText !== null) {
    cachedSearchFlagSupport = helpText.includes("--search");
    return cachedSearchFlagSupport;
  }

  cachedSearchFlagSupport = true;
  return cachedSearchFlagSupport;
}

export function supportsLegacyOutputFormatFlag(): boolean {
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

  cachedOutputFormatSupport = true;
  return cachedOutputFormatSupport;
}

export function shouldUseVerboseFlag(): boolean {
  if (cachedVerboseSupport !== null) {
    return cachedVerboseSupport;
  }

  const execHelp = getCodexExecHelpText();
  if (execHelp !== null) {
    cachedVerboseSupport = execHelp.includes("--verbose");
    if (cachedVerboseSupport) {
      return true;
    }
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

  const execHelp = getCodexExecHelpText();
  if (execHelp !== null && execHelp.includes("--dangerously-skip-permissions")) {
    cachedDangerouslySkipPermissionsSupport = true;
    return true;
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

export function resetCodexCliCapabilityCacheForTests(): void {
  cachedHelpText = null;
  helpDetectionAttempted = false;
  cachedExecHelpText = null;
  execHelpDetectionAttempted = false;
  cachedExecJsonSupport = null;
  cachedExecColorSupport = null;
  cachedExecResumeSupport = null;
  cachedDangerouslyBypassSupport = null;
  cachedSearchFlagSupport = null;
  cachedOutputFormatSupport = null;
  cachedVerboseSupport = null;
  cachedDangerouslySkipPermissionsSupport = null;
}

export function recordExecJsonUnsupportedForTests(): void {
  cachedExecJsonSupport = false;
}

export function recordExecColorUnsupportedForTests(): void {
  cachedExecColorSupport = false;
}

export function recordExecResumeUnsupportedForTests(): void {
  cachedExecResumeSupport = false;
}

export function recordDangerouslyBypassUnsupportedForTests(): void {
  cachedDangerouslyBypassSupport = false;
}

export function recordVerboseFlagUnsupportedForTests(): void {
  cachedVerboseSupport = false;
}

export function recordDangerouslySkipPermissionsUnsupportedForTests(): void {
  cachedDangerouslySkipPermissionsSupport = false;
}

export function recordSearchFlagUnsupportedForTests(): void {
  cachedSearchFlagSupport = false;
}
