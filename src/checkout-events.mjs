/** Checkout events that can carry a paid, complete session. Payment status and intent must still be admitted. */
export const CHECKOUT_EVENTS = Object.freeze([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);
