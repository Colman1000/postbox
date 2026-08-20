/**
 * `just secrets` — where the machine-local credentials live, and what they are.
 *
 * Nothing here is fetched from the network; this only reads the vault that
 * `just up` wrote.
 */
import { resolveConfig } from "./config.ts";
import { readVault, vaultPath } from "./vault.ts";

const config = resolveConfig();
const vault = readVault(config.stage);
const path = vaultPath(config.stage);

const mask = (value?: string) =>
  value ? `${value.slice(0, 6)}${"•".repeat(18)}${value.slice(-4)}` : "\x1b[2mnot provisioned\x1b[0m";

console.log(`
  \x1b[1mPostbox secrets\x1b[0m  \x1b[2m(stage: ${config.stage})\x1b[0m

  \x1b[2mFile\x1b[0m            ${path} \x1b[2m(0400, git-ignored)\x1b[0m

  \x1b[2mUI password\x1b[0m     ${vault.appPassword ?? "\x1b[2mnot provisioned\x1b[0m"}
  \x1b[2mResend key\x1b[0m      ${mask(vault.resendSendingKey)} \x1b[2m(send-only, scoped to ${config.domain})\x1b[0m
  \x1b[2mSession secret\x1b[0m  ${mask(vault.authSecret)}
  \x1b[2mState key\x1b[0m       ${mask(vault.statePassword)} \x1b[2m(encrypts secrets in .alchemy/)\x1b[0m
  \x1b[2mResend domain\x1b[0m   ${vault.resendDomainId ?? "\x1b[2mnot provisioned\x1b[0m"}

  \x1b[2mDeleting this file does not break the running deployment, but the next
  \`just up\` cannot read the state it already wrote: the send-only key is
  unrecoverable and a replacement is minted. Back it up, or set
  ALCHEMY_PASSWORD yourself if you would rather hold the state key elsewhere.\x1b[0m
`);
