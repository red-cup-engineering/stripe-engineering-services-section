import { readFileSync } from "node:fs";
import { compileRmlLaw } from "@red-cup-engineering/rmn-semantic-conformance/law";

const compile = (name) => compileRmlLaw(readFileSync(new URL(`../content/contracts/${name}.rml`, import.meta.url), "utf8"));
export const CHECKOUT_LAW = compile("stripe-checkout-session-creation");
export const WEBHOOK_LAW = compile("stripe-webhook-event-admission");
export const MANAGEMENT_IMPORT_LAW = compile("executive-office-management-instrument-import");
export const CHECKOUT_CONTRACT = CHECKOUT_LAW.id;
export const WEBHOOK_CONTRACT = WEBHOOK_LAW.id;
export const MANAGEMENT_IMPORT_CONTRACT = MANAGEMENT_IMPORT_LAW.id;
