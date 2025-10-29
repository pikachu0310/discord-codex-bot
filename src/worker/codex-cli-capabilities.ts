const decoder = new TextDecoder();

let cachedSupport: boolean | null = null;

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

export function shouldUseOutputFormatFlag(): boolean {
  const envOverride = getEnvOverride();
  if (envOverride !== null) {
    cachedSupport = envOverride;
    return envOverride;
  }

  if (cachedSupport !== null) {
    return cachedSupport;
  }

  try {
    const command = new Deno.Command("codex", {
      args: ["--help"],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = command.outputSync();
    if (code === 0) {
      const helpText = decoder.decode(stdout);
      cachedSupport = helpText.includes("--output-format");
      return cachedSupport;
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      cachedSupport = true;
      return cachedSupport;
    }
  }

  // デフォルトでは従来の挙動を維持する
  cachedSupport = true;
  return cachedSupport;
}

export function resetOutputFormatDetectionForTests(): void {
  cachedSupport = null;
}
