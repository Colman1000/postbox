/**
 * Prints the environment a Postbox shell command should run in: the derived
 * resource names, and the Cloudflare credential .env chose.
 *
 * The justfile evals this rather than re-deriving any of it, so there is
 * exactly one definition of "what is this stage's database called" — in
 * config.ts — and no chance of the CLI and the deploy disagreeing.
 *
 * The credential half matters because wrangler does not read .env. Left to
 * itself it would pick up whatever CLOUDFLARE_API_TOKEN is in the shell, which
 * is how `just sql` ends up querying a different account's database than the
 * one `just up` deployed to.
 */
import { CLOUDFLARE_CREDENTIAL_KEYS, resolveConfig } from "./config.ts";

try {
  const config = resolveConfig();
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

  // resolveConfig has already let .env overrule the shell and dropped the
  // credentials it disagreed with, so process.env is now the decided answer.
  const credentials = CLOUDFLARE_CREDENTIAL_KEYS.map((key) => {
    const value = process.env[key];
    return value ? `export ${key}=${quote(value)}` : `unset ${key}`;
  });

  console.log(
    [
      `export POSTBOX_DOMAIN=${quote(config.domain)}`,
      `export POSTBOX_STAGE=${quote(config.stage)}`,
      `export POSTBOX_HOST=${quote(config.appHostname)}`,
      `export POSTBOX_WORKER=${quote(config.names.worker)}`,
      `export POSTBOX_DB=${quote(config.names.database)}`,
      `export POSTBOX_KV=${quote(config.names.kv)}`,
      ...credentials,
    ].join("\n"),
  );
} catch (error) {
  // Emitted on stderr so `eval` does not swallow it, and exits non-zero so the
  // calling recipe stops rather than running against empty names.
  console.error((error as Error).message);
  process.exit(1);
}
