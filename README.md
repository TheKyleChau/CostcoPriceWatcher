# CostcoPriceWatcher

A single-file [Tampermonkey](https://www.tampermonkey.net/) userscript that tracks price drops on your own Costco.com orders within Costco's 30-day price-adjustment window, and surfaces them on a receipt-styled dashboard. Everything stays local to your browser: no server, and no account data ever leaves your machine.

## Features

- Auto-scans your last 30 days of Costco.com online orders when you open Account → Orders & Purchases (capturing the price you actually paid).
- Re-checks prices daily (throttled to once per day) for every monitored item, while a Costco tab is open.
- Dashboard overlay (Tampermonkey menu → Open dashboard) showing paid-vs-current price, drop amount, days left in the window, and your total potential refund.
- Per-item actions: open the order, open the product page (works by direct URL even when an item is pulled from search), and Mark Adjusted to clear a completed adjustment so it stops showing (it stays cleared across re-scans).
- Skips E-Delivery $0 add-ons and cancelled line items automatically.
- Auto-updates through Tampermonkey from costco.kyle.jp, and shows an "update available" banner in the dashboard when a newer version is published.
- Multiple Costco accounts: each account gets its own ledger, auto-detected on scan, with an account switcher in the dashboard. Accounts are keyed by a non-reversible hash of the account email; only a masked label is stored for display.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open `costco-pricewatch.user.js`, copy its contents into a new Tampermonkey script (or drag the file onto the Tampermonkey dashboard), and save.
3. Ensure Tampermonkey is enabled for costco.com.

## Use

1. Log into Costco.com.
2. Visit Account → Orders & Purchases (Online tab). The scan runs automatically once your orders load.
3. Click the Tampermonkey icon → "Costco PriceWatch — Open dashboard." The dashboard opens as an overlay on the current tab; press Esc, click outside it, or hit Close to dismiss. Other menu commands: Rescan now, and Refresh prices now.

## Updates

The script declares `@updateURL` and `@downloadURL` pointing at `https://costco.kyle.jp`, so Tampermonkey checks for new versions automatically and prompts to install them. The script also checks for a newer version before each scan and shows an "update available" banner in the dashboard with a link to it.

`costco.kyle.jp` may redirect to GitHub raw content, so the script whitelists `costco.kyle.jp`, `raw.githubusercontent.com`, and `githubusercontent.com` for the update check. To publish an update, serve the new `costco-pricewatch.user.js` and `costco-pricewatch.meta.js` from `costco.kyle.jp` (e.g. redirecting to the repo's `main`) with a bumped `@version`.

## Privacy

Stored locally (Tampermonkey storage) only: order number, order date, item number and description, paid price, quantity, current and lowest price, and timestamps. Never stored: your name, address, phone, membership number, card details, or auth token. The session token is read in-memory to make the same API calls the page already makes, and is never persisted.

## How it works

| Purpose | Endpoint | Auth |
|---|---|---|
| Order list | `ecom-api.costco.com …/order/v1/orders/graphql` (`getOnlineOrders`) | page session token (in-memory) |
| Paid prices | same endpoint (`getOrderDetails`, one order per call) | page session token (in-memory) |
| Current price | `gdx-api.costco.com …/dispprice-api/v2/display-price-lite` | none |

## Notes and limitations

- A price drop reported here reflects the current online price; it does not by itself prove an item is actively on sale on a live product page. Use the View Product link to confirm before requesting an adjustment.
- Covers Costco.com online orders only (not in-warehouse purchases).
- Built against Costco's current site behavior; if Costco changes their APIs, the script may need updating.

## Disclaimer

Unofficial, personal-use tool. Not affiliated with or endorsed by Costco Wholesale. Use in accordance with Costco's terms of service.

## License

MIT
