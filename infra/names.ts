/**
 * Prints the derived resource names as shell exports.
 *
 * The justfile evals this rather than re-deriving names itself, so there is
 * exactly one definition of "what is this stage's database called" — in
 * config.ts — and no chance of the CLI and the deploy disagreeing.
 */
import { resolveConfig } from "./config.ts";

try {
  const config = resolveConfig();
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

  console.log(
    [
      `export POSTBOX_DOMAIN=${quote(config.domain)}`,
      `export POSTBOX_STAGE=${quote(config.stage)}`,
      `export POSTBOX_HOST=${quote(config.appHostname)}`,
      `export POSTBOX_WORKER=${quote(config.names.worker)}`,
      `export POSTBOX_DB=${quote(config.names.database)}`,
      `export POSTBOX_KV=${quote(config.names.kv)}`,
    ].join("\n"),
  );
} catch (error) {
  // Emitted on stderr so `eval` does not swallow it, and exits non-zero so the
  // calling recipe stops rather than running against empty names.
  console.error((error as Error).message);
  process.exit(1);
}
