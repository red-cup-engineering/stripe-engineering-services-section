import { randomBytes } from "node:crypto";
import { openAccount } from "@red-cup-engineering/assisted-browser-services-section/accounts";
import { stepGuide } from "@red-cup-engineering/assisted-browser-services-section/assist";

/**
 * Arming one Checkout surface (a shop Worker, say) with a Stripe account,
 * done with the person at the node in the assisted browser.
 *
 * Stripe shows a restricted key, and a webhook destination's signing secret,
 * once, in its dashboard, and only the account's own authority creates them.
 * So the person creates each in the dashboard while the step panel shows the
 * exact values to enter, then pastes what Stripe shows into the panel's own
 * field. Code checks each value before handing it to `store`, the surface's
 * secret store, and never prints, logs or keeps it.
 *
 * The key is restricted to Checkout Sessions: Write, as
 * merchant-authority-policy.json asks. Write includes reading sessions, and
 * the check refuses a key that can also read the balance, so a broader key
 * is not used. The customer-contract token is minted here when the person
 * arms: it stands for their acceptance of the customer-settlement contract,
 * and the surface only checks that it is present.
 */
export const CHECKOUT_KEY_PERMISSIONS = Object.freeze(["rak_checkout_session_write"]);
export const CHECKOUT_EVENTS = Object.freeze(["checkout.session.completed"]);
export const SECRET_NAMES = Object.freeze({ key: "STRIPE_SECRET_KEY", webhook: "STRIPE_WEBHOOK_SECRET", contract: "STRIPE_CUSTOMER_CONTRACT_TOKEN" });

const KEY_PATTERN = Object.freeze({ live: /^rk_live_[A-Za-z0-9]{20,}$/u, test: /^rk_test_[A-Za-z0-9]{20,}$/u });
const WEBHOOK_SECRET_PATTERN = /^whsec_[A-Za-z0-9+/=]{20,}$/u;
const DASHBOARD = "https://dashboard.stripe.com";
const dashboardUrl = (mode, path) => `${DASHBOARD}${mode === "test" ? "/test" : ""}${path}`;
const stopped = () => Object.assign(new Error("the person stopped arming"), { code: "ARM_STOPPED" });

/** The dashboard page that creates a restricted key with the given name and permissions already chosen. */
export function restrictedKeyUrl({ name, mode = "live", permissions = CHECKOUT_KEY_PERMISSIONS }) {
  const url = new URL(dashboardUrl(mode, "/apikeys/create"));
  url.searchParams.set("name", name);
  for (const permission of permissions) url.searchParams.append("permissions[]", permission);
  return url.href;
}

/** Whether a key is a restricted key of `mode` that opens Checkout Sessions and not the balance. Only the outcome comes back. */
export async function checkCheckoutKey(key, { mode = "live", fetch: fetchImpl = fetch } = {}) {
  if (!KEY_PATTERN[mode]?.test(key)) return { ok: false, reason: `it is not a ${mode} restricted key (rk_${mode}_…)` };
  const status = async (path) => {
    try { return (await fetchImpl(`https://api.stripe.com/v1${path}`, { headers: { Authorization: `Bearer ${key}` } })).status; } catch { return null; }
  };
  const sessions = await status("/checkout/sessions?limit=1");
  if (sessions === null) return { ok: false, reason: "Stripe could not be reached to check it" };
  if (sessions === 401) return { ok: false, reason: "Stripe does not recognize it" };
  if (sessions !== 200) return { ok: false, reason: `it cannot use Checkout Sessions (Stripe answered ${sessions})` };
  if (await status("/balance") === 200) return { ok: false, reason: "it can do more than Checkout Sessions; give it only Checkout Sessions: Write" };
  return { ok: true };
}

/**
 * Arm `surface`: each of its three Stripe secrets not already `present` (or
 * all of them, with `replace`) is obtained through the person and handed to
 * `store(name, value)`. Resolves with a receipt that names what was stored
 * and holds no secret. The person may stop at any step; secrets stored by
 * then stay stored, and the surface stays unarmed until all three are there.
 */
export async function armCheckout({ surface, webhookUrl, merchant, mode = "live", present = [], replace = false, store, notify }, capabilities = {}) {
  if (typeof store !== "function") throw new TypeError("arming needs the surface's secret store");
  if (!KEY_PATTERN[mode]) throw new TypeError(`mode must be live or test, not ${mode}`);
  const endpoint = new URL(webhookUrl);
  if (endpoint.protocol !== "https:") throw new TypeError("the webhook endpoint must be HTTPS");
  const fetchImpl = capabilities.fetch ?? fetch;
  const needed = new Set(Object.entries(SECRET_NAMES).filter(([, name]) => replace || !present.includes(name)).map(([step]) => step));
  const receipt = {
    type: "StripeCheckoutArming", surface, mode, keyPermissions: [...CHECKOUT_KEY_PERMISSIONS], webhookUrl: endpoint.href, events: [...CHECKOUT_EVENTS],
    stored: [], alreadyPresent: Object.values(SECRET_NAMES).filter((name) => present.includes(name) && !replace), secretRecorded: false,
  };
  if (needed.size === 0) return { ...receipt, at: new Date().toISOString() };

  const { context, page, close } = await (capabilities.openAccount ?? openAccount)("stripe", { visible: true, notify }, capabilities.browser ?? {});
  try {
    const guide = await (capabilities.stepGuide ?? stepGuide)(context, { notify });
    const keep = async (step, value) => { await store(SECRET_NAMES[step], value); receipt.stored.push(SECRET_NAMES[step]); };
    // Ask until the pasted value passes `check`; the reason a value was refused heads the next ask.
    const obtain = async (text, options, check) => {
      for (let refusal = ""; ;) {
        const answer = await guide.show(`${refusal}${text}`, options);
        if (answer.label !== options.labels[0]) throw stopped();
        const checked = await check(answer.value);
        if (checked.ok) return answer.value;
        refusal = `That was not used: ${checked.reason}.\n\n`;
      }
    };

    if (needed.has("key")) {
      const name = `${surface} checkout`;
      await page.goto(restrictedKeyUrl({ name, mode }), { waitUntil: "domcontentloaded", timeout: 60_000 });
      await keep("key", await obtain(
        `Create the restricted key ${surface} uses to start card checkouts. This page should already have its name and one permission chosen; if not, enter them. Create it, then paste the key Stripe shows (it shows it once).`,
        {
          values: [{ label: "Key name", value: name }, { label: "Permission (the only one)", value: "Checkout Sessions: Write" }],
          labels: ["Use this key", "Stop"],
          input: { label: `Restricted key (rk_${mode}_…)`, pattern: KEY_PATTERN[mode], secret: true, placeholder: `rk_${mode}_…` },
        },
        (value) => checkCheckoutKey(value, { mode, fetch: fetchImpl }),
      ));
    }

    if (needed.has("webhook")) {
      await page.goto(dashboardUrl(mode, "/webhooks"), { waitUntil: "domcontentloaded", timeout: 60_000 });
      await keep("webhook", await obtain(
        `Add the webhook destination that tells ${surface} a checkout was paid: events from your account, the one event below, sent to a webhook endpoint at the URL below. Then open the destination, reveal its signing secret, and paste it here.`,
        {
          values: [{ label: "Endpoint URL", value: endpoint.href }, ...CHECKOUT_EVENTS.map((event) => ({ label: "Event (the only one)", value: event })), { label: "Description", value: `${surface} paid checkouts` }],
          labels: ["Use this secret", "Stop"],
          input: { label: "Signing secret (whsec_…)", pattern: WEBHOOK_SECRET_PATTERN, secret: true, placeholder: "whsec_…" },
        },
        async () => ({ ok: true }),
      ));
    }

    if (needed.has("contract")) {
      await page.goto(dashboardUrl(mode, "/"), { waitUntil: "domcontentloaded", timeout: 60_000 });
      const answer = await guide.show(
        `Arm card checkout on ${surface}?\n\nOnce armed, anyone can buy there by card through this Stripe account. Arm only if the account is activated for ${mode === "live" ? "live" : "test"} payments, payouts go to the right bank account, and the refund and tax terms are settled. Arming accepts the customer-settlement contract: each paid checkout is a sale by ${merchant ?? "the merchant"} to the buyer named on it.`,
        { labels: ["Arm", "Not yet"] },
      );
      if (answer.label !== "Arm") throw stopped();
      await keep("contract", randomBytes(32).toString("base64url"));
    }
    return { ...receipt, at: new Date().toISOString() };
  } catch (error) {
    if (error?.code === "ARM_STOPPED") return { ...receipt, stoppedEarly: true, at: new Date().toISOString() };
    throw error;
  } finally {
    await close();
  }
}
