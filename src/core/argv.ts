// Tiny, dependency-free argv helpers shared by the CLI command handlers.
// Kept deliberately small: only the unambiguous flag forms the CLI actually uses
// (`--name value`, `--name=value`, and bare boolean `--name`). Positional parsing
// stays in each command since it is command-specific.

/**
 * Read the value of a `--name value` or `--name=value` flag.
 * Returns undefined when the flag is absent or has no value.
 */
export function getFlag(argv: readonly string[], name: string): string | undefined {
  const eq = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(eq)) return a.slice(eq.length);
  }
  return undefined;
}

/** True when a bare boolean flag `--name` is present. */
export function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}
