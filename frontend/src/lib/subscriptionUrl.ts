/**
 * Whether an address can be subscribed to as a calendar. Sites publish
 * subscription links as `webcal://` (so a click opens a calendar app); the
 * core fetches them over HTTPS.
 */
export function isSubscriptionUrl(value: string): boolean {
  return /^(https?|webcals?):\/\/\S+$/i.test(value.trim())
}
