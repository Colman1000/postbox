/**
 * `just verify` — re-runs the Resend DNS check for your sending domain.
 *
 * Useful when a deploy finished before DNS had propagated far enough for
 * Resend's resolvers to see it.
 */
import { resolveConfig } from "./config.ts";
import { readVault } from "./vault.ts";

const config = resolveConfig();
const domainId = readVault(config.stage).resendDomainId;

if (!domainId) {
  console.error(
    "\n  No Resend domain has been provisioned for this stage yet. Run `just up` first.\n",
  );
  process.exit(1);
}

const headers = { Authorization: `Bearer ${config.resendApiKey}` };

await fetch(`https://api.resend.com/domains/${domainId}/verify`, {
  method: "POST",
  headers,
});

process.stdout.write("  Asking Resend to re-check DNS");

for (let attempt = 0; attempt < 24; attempt++) {
  const res = await fetch(`https://api.resend.com/domains/${domainId}`, { headers });
  const body = (await res.json()) as {
    status?: string;
    records?: Array<{ record: string; name: string; status: string }>;
  };

  if (body.status === "verified") {
    console.log(`\n\n  \x1b[32m✓\x1b[0m ${config.domain} is verified — sending is live.\n`);
    process.exit(0);
  }
  if (body.status === "failed") {
    console.log(`\n\n  \x1b[31m✗\x1b[0m Verification failed. Records Resend could not confirm:\n`);
    for (const r of body.records ?? []) {
      if (r.status !== "verified") console.log(`      ${r.record.padEnd(9)} ${r.name}`);
    }
    console.log("\n  Check these exist in Cloudflare DNS, then run `just up` to rewrite them.\n");
    process.exit(1);
  }

  process.stdout.write(".");
  await new Promise((r) => setTimeout(r, 5000));
}

console.log(
  "\n\n  \x1b[33m!\x1b[0m Still pending after two minutes. DNS can take longer to propagate;" +
    "\n    run `just verify` again in a few minutes.\n",
);
