#!/usr/bin/env node
import { ingestWebhook, invokeCheckout, readiness, solicitCheckout } from "./service.mjs";

const operation = process.argv.includes("--operation") ? process.argv[process.argv.indexOf("--operation") + 1] : "readiness";
async function input() { let text = ""; for await (const chunk of process.stdin) text += chunk; return text.trim() ? JSON.parse(text) : {}; }
let result;
if (operation === "readiness") result = readiness();
else if (operation === "solicit-checkout") result = solicitCheckout(await input());
else if (operation === "invoke-checkout") result = await invokeCheckout(await input());
else if (operation === "ingest-webhook") result = await ingestWebhook(await input());
else { process.stderr.write("usage: stripe-payment-acceptance --operation readiness|solicit-checkout|invoke-checkout|ingest-webhook\n"); process.exit(2); }
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.type === "Reject" || result.type === "StripeWebhookRefusal") process.exitCode = 1;
