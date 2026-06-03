// ==UserScript==
// @name         Costco PriceWatch
// @namespace    local.costco.pricewatch
// @version      1.0.0
// @description  Monitor price drops on your own Costco.com purchases (30-day price-adjustment window). Local-only.
// @match        https://www.costco.com/*
// @updateURL    https://costco.kyle.jp/costco-pricewatch.meta.js
// @downloadURL  https://costco.kyle.jp/costco-pricewatch.user.js
// @connect      costco.kyle.jp
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';
/*
 * Costco PriceWatch — pure logic helpers.
 *
 * UMD export:
 * - Node: module.exports
 * - Userscript/browser: window.CostcoPriceWatchLogic
 */
(function (root, factory) {
  'use strict';

  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.CostcoPriceWatchLogic = api;
  } else if (root) {
    root.CostcoPriceWatchLogic = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MS_DAY = 86400000;
  var MONITOR_DAYS = 30;
  var E_DELIVERY_RE = /\be-?delivery\b/i;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function numOrNull(value) {
    if (value == null || value === '') return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function round2(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    return value ? [value] : [];
  }

  function toMillis(value) {
    var n = value instanceof Date ? value.getTime() : Number(value);
    if (Number.isFinite(n)) return n;
    n = Date.parse(value);
    return Number.isFinite(n) ? n : 0;
  }

  function formatCostcoDate(value) {
    var d = new Date(value);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function dateRangeLast30(now) {
    var endMs = toMillis(now);
    var startMs = endMs - MONITOR_DAYS * MS_DAY;
    return {
      startDate: formatCostcoDate(startMs),
      endDate: formatCostcoDate(endMs)
    };
  }

  function extractOrders(getOnlineOrdersResponse) {
    var nodes = getOnlineOrdersResponse &&
      getOnlineOrdersResponse.data &&
      getOnlineOrdersResponse.data.getOnlineOrders;
    var node = Array.isArray(nodes) ? nodes[0] : nodes;

    return {
      totalNumberOfRecords: node && node.totalNumberOfRecords != null ? Number(node.totalNumberOfRecords) : 0,
      pageNumber: node && node.pageNumber != null ? Number(node.pageNumber) : 1,
      pageSize: node && node.pageSize != null ? Number(node.pageSize) : 0,
      bcOrders: node && Array.isArray(node.bcOrders) ? node.bcOrders : []
    };
  }

  function extractDetailLineItems(getOrderDetailsResponse) {
    var details = getOrderDetailsResponse &&
      getOrderDetailsResponse.data &&
      getOrderDetailsResponse.data.getOrderDetails;
    var out = [];

    asArray(details).forEach(function (detail) {
      asArray(detail && detail.shipToAddress).forEach(function (ship) {
        asArray(ship && ship.orderLineItems).forEach(function (lineItem) {
          out.push({
            orderNumber: String(
              lineItem.orderNumber != null ? lineItem.orderNumber : detail && detail.orderNumber != null ? detail.orderNumber : ''
            ),
            lineNumber: Number(lineItem.lineNumber),
            itemNumber: String(lineItem.itemNumber != null ? lineItem.itemNumber : ''),
            itemId: lineItem.itemId != null ? String(lineItem.itemId) : null,
            description: lineItem.itemDescription != null ? String(lineItem.itemDescription) : '',
            paidPrice: numOrNull(lineItem.price != null ? lineItem.price : lineItem.unitPrice),
            quantity: Number(lineItem.quantity != null ? lineItem.quantity : lineItem.orderedTotalQuantity != null ? lineItem.orderedTotalQuantity : 1)
          });
        });
      });
    });

    return out;
  }

  function indexDetails(detailLineItems) {
    var detailMap = Object.create(null);
    asArray(detailLineItems).forEach(function (detail) {
      var key = String(detail.orderNumber) + ':' + Number(detail.lineNumber);
      detailMap[key] = detail;
    });
    return detailMap;
  }

  function orderIsCancelled(order) {
    return String(order && order.status || '').toLowerCase() === 'cancelled';
  }

  function isExcludedDescription(desc) {
    return E_DELIVERY_RE.test(String(desc || ''));
  }

  function monitorUntilFromOrderDate(orderPlacedDate) {
    var placedMs = Date.parse(orderPlacedDate);
    return Number.isFinite(placedMs) ? placedMs + MONITOR_DAYS * MS_DAY : 0;
  }

  function buildItemRecords(bcOrders, detailLineItems, now) {
    var detailMap = indexDetails(detailLineItems);
    var records = [];

    asArray(bcOrders).forEach(function (order) {
      if (orderIsCancelled(order)) return;

      asArray(order && order.orderLineItems).forEach(function (lineItem) {
        if (String(lineItem && lineItem.status || '').toLowerCase() === 'cancelled') return;

        var orderNumber = String(order.orderNumber != null ? order.orderNumber : order.sourceOrderNumber != null ? order.sourceOrderNumber : '');
        var lineNumber = Number(lineItem.lineNumber);
        var key = orderNumber + ':' + lineNumber;
        var detail = detailMap[key];
        var orderPlacedDate = order.orderPlacedDate != null ? order.orderPlacedDate : order.orderedDate;
        var effectiveDescription = lineItem.itemDescription != null ? String(lineItem.itemDescription) : detail && detail.description != null ? String(detail.description) : '';

        if (isExcludedDescription(effectiveDescription)) return;

        records.push({
          key: key,
          orderNumber: orderNumber,
          orderPlacedDate: orderPlacedDate,
          itemNumber: String(lineItem.itemNumber != null ? lineItem.itemNumber : detail && detail.itemNumber != null ? detail.itemNumber : ''),
          itemId: lineItem.itemId != null ? String(lineItem.itemId) : detail && detail.itemId != null ? String(detail.itemId) : null,
          description: effectiveDescription,
          paidPrice: detail && detail.paidPrice != null ? detail.paidPrice : null,
          quantity: detail && detail.quantity != null && Number.isFinite(Number(detail.quantity)) ? Number(detail.quantity) : 1,
          monitorUntil: monitorUntilFromOrderDate(orderPlacedDate)
        });
      });
    });

    return records;
  }

  function computeDrop(paidPrice, currentPrice) {
    var paid = numOrNull(paidPrice);
    var current = numOrNull(currentPrice);
    if (paid == null || current == null) return 0;
    return Math.max(0, round2(paid - current));
  }

  function mergeItems(prevItems, newRecords, now) {
    var out = Object.assign({}, prevItems || {});

    asArray(newRecords).forEach(function (record) {
      if (!record || record.key == null) return;

      var old = out[record.key] || {};
      var merged = {
        key: record.key,
        orderNumber: String(record.orderNumber != null ? record.orderNumber : old.orderNumber != null ? old.orderNumber : ''),
        orderPlacedDate: record.orderPlacedDate != null ? record.orderPlacedDate : old.orderPlacedDate,
        itemNumber: String(record.itemNumber != null ? record.itemNumber : old.itemNumber != null ? old.itemNumber : ''),
        itemId: record.itemId != null ? String(record.itemId) : old.itemId != null ? String(old.itemId) : null,
        description: record.description != null ? String(record.description) : old.description != null ? String(old.description) : '',
        paidPrice: record.paidPrice != null ? record.paidPrice : old.paidPrice != null ? old.paidPrice : null,
        quantity: Number.isFinite(Number(record.quantity)) ? Number(record.quantity) : Number.isFinite(Number(old.quantity)) ? Number(old.quantity) : 1,
        monitorUntil: Number.isFinite(Number(record.monitorUntil)) && Number(record.monitorUntil) > 0 ? Number(record.monitorUntil) : monitorUntilOf(record),
        currentPrice: old.currentPrice != null ? old.currentPrice : null,
        lowestPriceSeen: old.lowestPriceSeen != null ? old.lowestPriceSeen : null,
        lastCheckedAt: Number.isFinite(Number(old.lastCheckedAt)) ? Number(old.lastCheckedAt) : 0,
        adjusted: record.adjusted != null ? !!record.adjusted : !!old.adjusted,
        adjustedAt: Number.isFinite(Number(record.adjustedAt)) ? Number(record.adjustedAt) : Number.isFinite(Number(old.adjustedAt)) ? Number(old.adjustedAt) : 0,
        dropAmount: 0
      };
      merged.dropAmount = computeDrop(merged.paidPrice, merged.currentPrice);
      out[record.key] = merged;
    });

    return out;
  }

  function monitorUntilOf(item) {
    if (!item) return 0;
    var explicit = Number(item.monitorUntil);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    if (!item.orderPlacedDate) return 0;
    return monitorUntilFromOrderDate(item.orderPlacedDate);
  }

  function isMonitored(item, now) {
    return monitorUntilOf(item) >= toMillis(now);
  }

  function daysLeft(item, now) {
    return Math.max(0, Math.floor((monitorUntilOf(item) - toMillis(now)) / MS_DAY));
  }

  function parseDisplayPrice(json) {
    var priceData = json && json.priceData;
    var online = numOrNull(priceData && priceData.displayPrice && priceData.displayPrice.onlinePrice);
    var list = numOrNull(priceData && priceData.sourcePrice && priceData.sourcePrice.listPrice);
    if (list === -1) list = null;
    return {
      onlinePrice: online,
      listPrice: list
    };
  }

  function applyPriceUpdate(item, onlinePrice, now) {
    var checkedAt = toMillis(now);
    var price = numOrNull(onlinePrice);
    if (price == null) {
      return Object.assign({}, item, { lastCheckedAt: checkedAt });
    }

    var oldLowest = numOrNull(item && item.lowestPriceSeen);
    var lowest = oldLowest == null ? price : Math.min(oldLowest, price);
    return Object.assign({}, item, {
      currentPrice: price,
      lowestPriceSeen: lowest,
      dropAmount: computeDrop(item && item.paidPrice, price),
      lastCheckedAt: checkedAt
    });
  }

  function pruneExpired(items, now) {
    var cutoff = toMillis(now);
    var out = {};

    Object.keys(items || {}).forEach(function (key) {
      var item = items[key];
      if (monitorUntilOf(item) >= cutoff) {
        out[key] = item;
      }
    });

    return out;
  }

  function markItemAdjusted(items, key, now) {
    var out = Object.assign({}, items || {});
    if (out[key]) {
      out[key] = Object.assign({}, out[key], {
        adjusted: true,
        adjustedAt: toMillis(now)
      });
    }
    return out;
  }

  function compareVersions(a, b) {
    var pa = String(a || '0').replace(/^v/i, '').split('.').map(function (n) {
      return parseInt(n, 10) || 0;
    });
    var pb = String(b || '0').replace(/^v/i, '').split('.').map(function (n) {
      return parseInt(n, 10) || 0;
    });
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i += 1) {
      var x = pa[i] || 0;
      var y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  function isNewerVersion(remote, current) {
    return compareVersions(remote, current) > 0;
  }

  function summarize(items, now) {
    var monitored = Object.values(items || {}).filter(function (item) {
      return isMonitored(item, now) && !item.adjusted;
    });
    var drops = monitored.filter(function (item) {
      return computeDrop(item.paidPrice, item.currentPrice) > 0;
    });
    var total = drops.reduce(function (sum, item) {
      return sum + computeDrop(item.paidPrice, item.currentPrice) * (Number(item.quantity) || 1);
    }, 0);

    return {
      monitoredCount: monitored.length,
      dropCount: drops.length,
      totalPotentialRefund: round2(total)
    };
  }

  return {
    dateRangeLast30: dateRangeLast30,
    extractOrders: extractOrders,
    extractDetailLineItems: extractDetailLineItems,
    buildItemRecords: buildItemRecords,
    mergeItems: mergeItems,
    computeDrop: computeDrop,
    isMonitored: isMonitored,
    daysLeft: daysLeft,
    monitorUntilOf: monitorUntilOf,
    parseDisplayPrice: parseDisplayPrice,
    applyPriceUpdate: applyPriceUpdate,
    pruneExpired: pruneExpired,
    isExcludedDescription: isExcludedDescription,
    markItemAdjusted: markItemAdjusted,
    compareVersions: compareVersions,
    isNewerVersion: isNewerVersion,
    summarize: summarize,
    MS_DAY: MS_DAY,
    MONITOR_DAYS: MONITOR_DAYS
  };
});


/*
 * Costco PriceWatch — Dashboard UI ("ITEMIZED" receipt-ledger)
 * Self-contained: no external fonts/assets (CSP-safe, minimal overhead).
 * Exposes window.CostcoPriceWatchUI = { DASHBOARD_CSS, renderDashboard }.
 *
 * renderDashboard(root, state, actions)
 *   root    : HTMLElement to mount into (overlay is appended here)
 *   state   : storage object (see spec) { items:{...}, lastPriceCheckAt, lastScrapeAt, tokenStale? }
 *   actions : { rescan(), refreshPrices(), close() }  (async)
 *
 * SECURITY: all item-derived text is inserted via textContent only. Never innerHTML with data.
 */
(function (global) {
  'use strict';

  const NS = 'cpw'; // class prefix

  const DASHBOARD_CSS = `
  .${NS}-scrim{
    position:fixed; inset:0; z-index:2147483646;
    display:flex; align-items:flex-start; justify-content:center;
    padding:40px 16px 64px; overflow:auto;
    background:
      radial-gradient(120% 80% at 50% -10%, #2a2622 0%, #15120f 60%, #0c0a08 100%);
    font-family:"Courier New","Courier",ui-monospace,"SFMono-Regular",Menlo,monospace;
    -webkit-font-smoothing:antialiased;
    animation:${NS}-fade .35s ease both;
  }
  @keyframes ${NS}-fade{from{opacity:0}to{opacity:1}}

  .${NS}-receipt{
    position:relative; width:min(560px,100%);
    color:#1b1814;
    background:#f4efe3;
    background-image:
      url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)' opacity='0.05'/></svg>");
    box-shadow:0 30px 60px -20px rgba(0,0,0,.7), 0 2px 0 rgba(0,0,0,.3);
    padding:30px 30px 16px;
    /* perforated top + bottom edges */
    -webkit-mask:
      radial-gradient(circle 7px at 12px -1px, transparent 6px, #000 6.5px) top left/24px 14px repeat-x,
      radial-gradient(circle 7px at 12px calc(100% + 1px), transparent 6px, #000 6.5px) bottom left/24px 14px repeat-x,
      linear-gradient(#000,#000);
    -webkit-mask-composite:source-over;
    mask:
      radial-gradient(circle 7px at 12px -1px, transparent 6px, #000 6.5px) top left/24px 14px repeat-x,
      radial-gradient(circle 7px at 12px calc(100% + 1px), transparent 6px, #000 6.5px) bottom left/24px 14px repeat-x,
      linear-gradient(#000,#000);
    animation:${NS}-print .5s cubic-bezier(.16,1,.3,1) both;
  }
  @keyframes ${NS}-print{
    from{ transform:translateY(-18px); opacity:0; clip-path:inset(0 0 100% 0); }
    to{ transform:translateY(0); opacity:1; clip-path:inset(0 0 0 0); }
  }

  .${NS}-receipt *{ box-sizing:border-box; }
  .${NS}-row-reveal{ animation:${NS}-rise .4s ease both; }

  @keyframes ${NS}-rise{from{opacity:0; transform:translateY(8px)}to{opacity:1; transform:translateY(0)}}

  .${NS}-head{ text-align:center; }
  .${NS}-brand{
    font-size:22px; font-weight:700; letter-spacing:.42em;
    margin:2px 0 0 14px; /* offset for letter-spacing */
  }
  .${NS}-sub{
    font-size:10.5px; letter-spacing:.34em; color:#6b6258; margin-top:8px;
  }
  .${NS}-barcode{
    height:34px; margin:14px 0 4px;
    background:repeating-linear-gradient(90deg,#1b1814 0 2px,transparent 2px 4px,#1b1814 4px 5px,transparent 5px 9px,#1b1814 9px 12px,transparent 12px 14px);
    opacity:.9;
  }
  .${NS}-barnum{ font-size:10px; letter-spacing:.5em; color:#1b1814; text-align:center; margin:2px 0 0 8px; }

  .${NS}-rule{ border:0; border-top:2px dashed #b9ad99; margin:18px 0; }
  .${NS}-rule-thin{ border:0; border-top:1px solid #d8cfbd; margin:14px 0; }

  .${NS}-meta{ display:flex; justify-content:space-between; font-size:11.5px; color:#6b6258; letter-spacing:.04em; }

  .${NS}-summary{ text-align:center; margin:18px 0 6px; }
  .${NS}-sumline{ display:flex; justify-content:space-between; font-size:13px; padding:3px 0; letter-spacing:.05em; }
  .${NS}-sumline .${NS}-k{ color:#3f3a33; }
  .${NS}-sumline .${NS}-v{ font-weight:700; }
  .${NS}-refund{
    margin:14px auto 4px; text-align:center;
  }
  .${NS}-refund .${NS}-rk{ font-size:11px; letter-spacing:.34em; color:#6b6258; }
  .${NS}-refund .${NS}-rv{
    font-size:46px; font-weight:700; line-height:1.05; margin-top:6px; color:#c2311c;
    text-shadow:0 1px 0 rgba(194,49,28,.15);
  }
  .${NS}-refund.${NS}-zero .${NS}-rv{ color:#5c554c; }

  .${NS}-items{ margin-top:4px; }
  .${NS}-item{ padding:13px 0; }
  .${NS}-desc{
    font-size:13px; line-height:1.45; margin-bottom:9px;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
  }
  .${NS}-itemno{ color:#8a8170; }
  .${NS}-pline{ display:flex; justify-content:space-between; align-items:baseline; font-size:13.5px; padding:1px 0; }
  .${NS}-pline .${NS}-pk{ color:#4a443c; letter-spacing:.08em; }
  .${NS}-dots{ flex:1; border-bottom:1.5px dotted #c3b9a6; margin:0 7px 3px; }
  .${NS}-pv{ font-variant-numeric:tabular-nums; }
  .${NS}-pv-now{ font-weight:700; }
  .${NS}-pv-now.${NS}-dropnow{ color:#c2311c; }

  .${NS}-stamp{
    display:inline-flex; align-items:center; gap:8px; margin-top:11px;
    border:2.5px solid #c2311c; color:#c2311c;
    padding:5px 11px; border-radius:3px;
    font-size:12px; font-weight:700; letter-spacing:.12em;
    transform:rotate(-3.5deg); transform-origin:left center;
    box-shadow:inset 0 0 0 1px rgba(194,49,28,.25);
    animation:${NS}-stamp .35s cubic-bezier(.2,1.4,.3,1) both; animation-delay:.25s;
  }
  @keyframes ${NS}-stamp{from{opacity:0; transform:rotate(-3.5deg) scale(1.6)}to{opacity:.95; transform:rotate(-3.5deg) scale(1)}}
  .${NS}-note{ font-size:11px; color:#6b6258; margin-top:9px; letter-spacing:.05em; }
  .${NS}-note .${NS}-elig{ color:#1c4e8a; font-weight:700; }
  .${NS}-lowest{ font-size:10.5px; color:#9a917f; margin-top:5px; letter-spacing:.04em; }
  .${NS}-days{ color:#1c4e8a; font-weight:700; }
  .${NS}-days.${NS}-soon{ color:#c2311c; }

  .${NS}-links{ display:flex; gap:8px; margin-top:11px; flex-wrap:wrap; }
  .${NS}-link{
    font:inherit; font-size:10px; font-weight:700; letter-spacing:.1em; text-decoration:none;
    color:#1b1814; background:transparent; border:1.5px solid #1b1814; border-radius:2px;
    padding:5px 9px; cursor:pointer; transition:background .15s ease, color .15s ease;
  }
  .${NS}-link:hover{ background:#1b1814; color:#f4efe3; }
  .${NS}-link-product{ border-color:#1c4e8a; color:#1c4e8a; }
  .${NS}-link-product:hover{ background:#1c4e8a; color:#f4efe3; }
  .${NS}-link-done{ border-color:#2f7d32; color:#2f7d32; }
  .${NS}-link-done:hover{ background:#2f7d32; color:#f4efe3; }
  .${NS}-link-done[disabled]{ opacity:.5; cursor:progress; }

  .${NS}-empty{ text-align:center; padding:26px 8px; }
  .${NS}-empty .${NS}-big{ font-size:15px; font-weight:700; letter-spacing:.14em; margin-bottom:10px; }
  .${NS}-empty .${NS}-small{ font-size:12px; color:#6b6258; line-height:1.6; letter-spacing:.04em; }

  .${NS}-banner{
    border:2px dashed #c2311c; color:#9a2a18; background:rgba(194,49,28,.06);
    padding:9px 12px; font-size:11.5px; letter-spacing:.06em; text-align:center; margin:6px 0 14px;
  }
  .${NS}-update{
    display:flex; align-items:center; justify-content:space-between; gap:10px;
    border:2px solid #1c4e8a; color:#1c4e8a; background:rgba(28,78,138,.07);
    padding:9px 12px; font-size:11.5px; font-weight:700; letter-spacing:.06em; margin:6px 0 14px;
  }
  .${NS}-update a{
    color:#1c4e8a; text-decoration:none; border:1.5px solid #1c4e8a; border-radius:2px;
    padding:4px 8px; font-size:10px; white-space:nowrap; transition:background .15s ease, color .15s ease;
  }
  .${NS}-update a:hover{ background:#1c4e8a; color:#f4efe3; }

  .${NS}-foot{ text-align:center; margin-top:6px; }
  .${NS}-thanks{ font-size:12px; letter-spacing:.3em; color:#3f3a33; margin:14px 0 6px; }
  .${NS}-fineprint{ font-size:9.5px; color:#9a917f; letter-spacing:.08em; line-height:1.7; }

  .${NS}-actions{ display:flex; gap:9px; margin:16px 0 4px; }
  .${NS}-btn{
    flex:1; font:inherit; font-size:11.5px; font-weight:700; letter-spacing:.12em;
    padding:11px 8px; cursor:pointer; color:#1b1814;
    background:#f4efe3; border:2px solid #1b1814; border-radius:2px;
    transition:transform .08s ease, background .15s ease, color .15s ease;
  }
  .${NS}-btn:hover{ background:#1b1814; color:#f4efe3; }
  .${NS}-btn:active{ transform:translateY(1px); }
  .${NS}-btn[disabled]{ opacity:.45; cursor:progress; }
  .${NS}-btn-close{ border-color:#c2311c; color:#c2311c; }
  .${NS}-btn-close:hover{ background:#c2311c; color:#f4efe3; }

  .${NS}-spin{ display:inline-block; animation:${NS}-spin 1s steps(8) infinite; }
  @keyframes ${NS}-spin{to{transform:rotate(360deg)}}

  @media (max-width:480px){
    .${NS}-receipt{ padding:24px 18px 14px; }
    .${NS}-refund .${NS}-rv{ font-size:38px; }
    .${NS}-brand{ font-size:18px; letter-spacing:.3em; }
  }`;

  // ---- tiny pure helpers (UI-local; mirror engine semantics) ----
  const MS_DAY = 86400000;
  function money(n) {
    if (n == null || isNaN(n)) return '—';
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function monitorUntil(it) {
    return it.monitorUntil || (it.orderPlacedDate ? new Date(it.orderPlacedDate).getTime() + 30 * MS_DAY : 0);
  }
  function daysLeft(it, now) {
    return Math.max(0, Math.floor((monitorUntil(it) - now) / MS_DAY));
  }
  function isMonitored(it, now) {
    return monitorUntil(it) >= now;
  }
  function dropOf(it) {
    if (it.currentPrice == null || it.paidPrice == null) return 0;
    return Math.max(0, Math.round((it.paidPrice - it.currentPrice) * 100) / 100);
  }
  function ago(ts, now) {
    if (!ts) return 'never';
    const m = Math.round((now - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text); // safe insert
    return n;
  }
  function c(name) { return NS + '-' + name; }

  function renderDashboard(root, state, actions) {
    state = state || {};
    actions = actions || {};
    const now = Date.now();
    const clientId = state.clientId || '4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf';
    const mkLink = (label, cls, href) => {
      const a = el('a', cls, label);
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      return a;
    };
    // carry each item's storage key (orderNumber:lineNumber) so actions can target it
    const items = Object.entries(state.items || {}).map((e) => Object.assign({ _key: e[0] }, e[1]));
    const monitored = items.filter((it) => isMonitored(it, now) && !it.adjusted)
      .sort((a, b) => dropOf(b) - dropOf(a) || (monitorUntil(a) - monitorUntil(b)));
    const drops = monitored.filter((it) => dropOf(it) > 0);
    const totalRefund = drops.reduce((s, it) => s + dropOf(it) * (it.quantity || 1), 0);

    // inject CSS once
    if (!document.getElementById(NS + '-style') && !(typeof window !== 'undefined' && window.__cpwStyleInjected)) {
      const st = el('style');
      st.id = NS + '-style';
      st.textContent = DASHBOARD_CSS;
      document.head.appendChild(st);
    }

    const scrim = el('div', c('scrim'));
    scrim.addEventListener('click', (e) => { if (e.target === scrim && actions.close) actions.close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape' && actions.close) { actions.close(); document.removeEventListener('keydown', esc); }
    });

    const r = el('div', c('receipt'));

    // --- header ---
    const head = el('div', c('head'));
    head.appendChild(el('div', c('brand'), 'PRICEWATCH'));
    head.appendChild(el('div', c('sub'), 'COSTCO · 30-DAY PRICE LEDGER'));
    head.appendChild(el('div', c('barcode')));
    head.appendChild(el('div', c('barnum'), '* 30 DAY ADJUST *'));
    r.appendChild(head);

    const meta = el('div', c('meta'));
    meta.appendChild(el('span', null, 'WHS #' + (state.warehouseNumber || '—')));
    meta.appendChild(el('span', null, 'PRICES ' + ago(state.lastPriceCheckAt, now).toUpperCase()));
    r.appendChild(meta);

    r.appendChild(el('hr', c('rule')));

    // --- update-available banner ---
    if (state.updateAvailable && state.updateAvailable.version) {
      const up = el('div', c('update'));
      up.appendChild(el('span', null, '⬆ UPDATE AVAILABLE · v' + state.updateAvailable.version));
      const a = el('a', null, 'GET UPDATE ↗');
      a.href = state.updateAvailable.url || 'https://costco.kyle.jp/costco-pricewatch.user.js';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      up.appendChild(a);
      r.appendChild(up);
    }

    // --- stale token banner ---
    if (state.tokenStale) {
      r.appendChild(el('div', c('banner'), '⚠ SESSION EXPIRED — OPEN YOUR COSTCO ORDERS PAGE TO RESCAN'));
    }

    // --- empty state ---
    if (monitored.length === 0) {
      const empty = el('div', c('empty'));
      empty.appendChild(el('div', c('big'), 'NO ITEMS ON THE LEDGER'));
      const small = el('div', c('small'));
      small.appendChild(document.createTextNode('Visit your Costco "Orders & Purchases" page'));
      small.appendChild(el('br'));
      small.appendChild(document.createTextNode('and PriceWatch will scan the last 30 days automatically.'));
      empty.appendChild(small);
      r.appendChild(empty);
    } else {
      // --- summary ---
      const sum = el('div', c('summary'));
      const l1 = el('div', c('sumline'));
      l1.appendChild(el('span', c('k'), 'ITEMS MONITORED'));
      l1.appendChild(el('span', c('v'), String(monitored.length)));
      const l2 = el('div', c('sumline'));
      l2.appendChild(el('span', c('k'), 'PRICE DROPS FOUND'));
      l2.appendChild(el('span', c('v'), String(drops.length)));
      sum.appendChild(l1);
      sum.appendChild(l2);
      r.appendChild(sum);

      const refund = el('div', c('refund') + (totalRefund > 0 ? '' : ' ' + c('zero')));
      refund.appendChild(el('div', c('rk'), 'POTENTIAL REFUND'));
      refund.appendChild(el('div', c('rv'), money(totalRefund)));
      r.appendChild(refund);

      r.appendChild(el('hr', c('rule')));

      // --- items ---
      const list = el('div', c('items'));
      monitored.forEach((it, i) => {
        const drop = dropOf(it);
        const dl = daysLeft(it, now);
        const node = el('div', c('item') + ' ' + c('row-reveal'));
        node.style.animationDelay = (0.18 + i * 0.05) + 's';

        node.appendChild(el('div', c('desc'), it.description || ('Item #' + it.itemNumber)));

        const paid = el('div', c('pline'));
        paid.appendChild(el('span', c('pk'), 'PAID'));
        paid.appendChild(el('span', c('dots')));
        paid.appendChild(el('span', c('pv'), money(it.paidPrice) + (it.quantity > 1 ? ' ×' + it.quantity : '')));
        node.appendChild(paid);

        const nowln = el('div', c('pline'));
        nowln.appendChild(el('span', c('pk'), 'NOW'));
        nowln.appendChild(el('span', c('dots')));
        const nv = el('span', c('pv') + ' ' + c('pv-now') + (drop > 0 ? ' ' + c('dropnow') : ''),
          it.currentPrice == null ? 'checking…' : money(it.currentPrice));
        nowln.appendChild(nv);
        node.appendChild(nowln);

        if (drop > 0) {
          const stamp = el('div', c('stamp'));
          stamp.appendChild(el('span', null, '▼ PRICE DROP'));
          stamp.appendChild(el('span', null, '−' + money(drop)));
          node.appendChild(stamp);

          const note = el('div', c('note'));
          note.appendChild(el('span', c('elig'), 'ELIGIBLE FOR ADJUSTMENT'));
          note.appendChild(document.createTextNode(' · '));
          const dspan = el('span', c('days') + (dl <= 5 ? ' ' + c('soon') : ''), dl + 'd left');
          note.appendChild(dspan);
          node.appendChild(note);
        } else {
          const note = el('div', c('note'));
          note.appendChild(document.createTextNode(it.currentPrice == null ? 'awaiting first price check · ' : 'no drop yet · '));
          const dspan = el('span', c('days') + (dl <= 5 ? ' ' + c('soon') : ''), dl + 'd left in window');
          note.appendChild(dspan);
          node.appendChild(note);
        }

        if (it.lowestPriceSeen != null && it.lowestPriceSeen < it.paidPrice) {
          node.appendChild(el('div', c('lowest'), 'lowest seen ' + money(it.lowestPriceSeen)));
        }

        // per-item actions: open the order, and the product page (live even when delisted from search)
        const links = el('div', c('links'));
        if (it.orderNumber) {
          links.appendChild(mkLink('VIEW ORDER ↗', c('link'),
            'https://www.costco.com/myaccount/#/app/' + encodeURIComponent(clientId) + '/orderdetails/' + encodeURIComponent(it.orderNumber)));
        }
        if (it.itemNumber) {
          links.appendChild(mkLink('VIEW PRODUCT ↗', c('link') + ' ' + c('link-product'),
            'https://www.costco.com/p.product.' + encodeURIComponent(it.itemNumber) + '.html'));
        }
        // mark a completed price adjustment as done so it stops showing (only when there's a drop to adjust)
        if (drop > 0 && actions.markAdjusted) {
          const done = el('button', c('link') + ' ' + c('link-done'), '✓ MARK ADJUSTED');
          done.addEventListener('click', async () => {
            done.disabled = true;
            done.textContent = '✓ SAVING…';
            try { await actions.markAdjusted(it._key); } catch (e) { done.disabled = false; done.textContent = '✓ MARK ADJUSTED'; }
          });
          links.appendChild(done);
        }
        node.appendChild(links);

        list.appendChild(node);
        if (i < monitored.length - 1) list.appendChild(el('hr', c('rule-thin')));
      });
      r.appendChild(list);
    }

    // --- actions ---
    r.appendChild(el('hr', c('rule')));
    const actbar = el('div', c('actions'));
    const mkBtn = (label, cls, fn) => {
      const b = el('button', c('btn') + (cls ? ' ' + cls : ''), label);
      b.addEventListener('click', async () => {
        if (!fn) return;
        const original = b.textContent;
        b.disabled = true;
        const sp = el('span', c('spin'), '✶');
        b.textContent = '';
        b.appendChild(sp);
        b.appendChild(document.createTextNode(' WORKING'));
        try { await fn(); } finally { b.disabled = false; b.textContent = original; }
      });
      return b;
    };
    actbar.appendChild(mkBtn('RESCAN', null, actions.rescan));
    actbar.appendChild(mkBtn('REFRESH PRICES', null, actions.refreshPrices));
    actbar.appendChild(mkBtn('CLOSE', c('btn-close'), actions.close));
    r.appendChild(actbar);

    // --- footer ---
    const foot = el('div', c('foot'));
    foot.appendChild(el('div', c('thanks'), '★ SAVED LOCALLY ★'));
    foot.appendChild(el('div', c('fineprint'), 'Stored on this device only · No account data leaves your browser'));
    if (state.currentVersion) foot.appendChild(el('div', c('fineprint'), 'PriceWatch v' + state.currentVersion));
    r.appendChild(foot);

    scrim.appendChild(r);
    root.appendChild(scrim);
    return scrim;
  }

  global.CostcoPriceWatchUI = { DASHBOARD_CSS: DASHBOARD_CSS, renderDashboard: renderDashboard };
})(typeof window !== 'undefined' ? window : globalThis);


(function () {
  'use strict';

  var L = window.CostcoPriceWatchLogic;
  var UI = window.CostcoPriceWatchUI;
  var PAGE = typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;
  var pageFetch = PAGE && PAGE.fetch ? PAGE.fetch.bind(PAGE) : window.fetch.bind(window);

  var STORE_KEY = 'costco_pricewatch';
  var ORDERS_URL = 'https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql';
  var PRICE_URL = 'https://gdx-api.costco.com/catalog/product/dispprice-api/v2/display-price-lite';
  var PRICE_CHECK_INTERVAL = 24 * 3600 * 1000;
  var DEFAULT_WAREHOUSE_NUMBER = '847';
  var DEFAULT_CLIENT_ID = '4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf';
  var PRICE_CLIENT_IDENTIFIER = '6b262714-2ed4-4dcb-a39d-39a4b0357309'; // Registered client-identifier for gdx-api display-price-lite (from Costco frontend; public, validated by Apigee).
  var TOKEN_STALE_MS = 15 * 60 * 1000;
  var UPDATE_META_URL = 'https://costco.kyle.jp/costco-pricewatch.meta.js';
  var UPDATE_DOWNLOAD_URL = 'https://costco.kyle.jp/costco-pricewatch.user.js';
  var UPDATE_CHECK_INTERVAL = 24 * 3600 * 1000;
  var CURRENT_VERSION = typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version ? String(GM_info.script.version) : '0.0.0';

  var capturedAuth = null;
  var dashboardListenerInstalled = false;

  var QUERY_ONLINE_ORDERS = [
    'query getOnlineOrders($startDate: String!, $endDate: String!, $pageNumber: Int, $pageSize: Int, $warehouseNumber: String!) {',
    '  getOnlineOrders(startDate: $startDate, endDate: $endDate, pageNumber: $pageNumber, pageSize: $pageSize, warehouseNumber: $warehouseNumber) {',
    '    pageNumber',
    '    pageSize',
    '    totalNumberOfRecords',
    '    bcOrders {',
    '      orderHeaderId',
    '      orderPlacedDate: orderedDate',
    '      orderNumber: sourceOrderNumber',
    '      orderTotal',
    '      warehouseNumber',
    '      status',
    '      orderLineItems {',
    '        orderLineItemId',
    '        itemId',
    '        itemNumber',
    '        lineNumber',
    '        itemDescription',
    '        status',
    '      }',
    '    }',
    '  }',
    '}'
  ].join('\n');

  var QUERY_ORDER_DETAILS = [
    'query getOrderDetails($orderNumbers: [String]) {',
    '  getOrderDetails(orderNumbers: $orderNumbers) {',
    '    orderNumber: sourceOrderNumber',
    '    orderPlacedDate: orderedDate',
    '    status',
    '    shipToAddress: orderShipTos {',
    '      orderLineItems {',
    '        itemNumber',
    '        itemDescription: sourceItemDescription',
    '        price: unitPrice',
    '        quantity: orderedTotalQuantity',
    '        merchandiseTotalAmount',
    '        lineNumber',
    '        itemId',
    '        orderNumber',
    '      }',
    '    }',
    '  }',
    '}'
  ].join('\n');

  function defaultState() {
    return {
      version: 1,
      items: {},
      lastScrapeAt: 0,
      lastPriceCheckAt: 0,
      latestVersion: null,
      lastUpdateCheckAt: 0,
      warehouseNumber: null,
      clientId: null
    };
  }

  function numberOrNull(value) {
    if (value == null || value === '') return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function numberOrZero(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function stringOrNull(value) {
    return value == null || value === '' ? null : String(value);
  }

  function sanitizeItem(item) {
    if (!item || typeof item !== 'object') return null;

    var orderNumber = item.orderNumber != null ? String(item.orderNumber) : '';
    var lineFromKey = item.key && String(item.key).split(':')[1];
    var lineNumber = lineFromKey != null ? lineFromKey : '';
    var key = item.key != null ? String(item.key) : orderNumber + ':' + lineNumber;

    return {
      orderNumber: orderNumber,
      orderPlacedDate: item.orderPlacedDate != null ? item.orderPlacedDate : null,
      itemNumber: item.itemNumber != null ? String(item.itemNumber) : '',
      itemId: stringOrNull(item.itemId),
      description: item.description != null ? String(item.description) : '',
      paidPrice: numberOrNull(item.paidPrice),
      quantity: Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : 1,
      currentPrice: numberOrNull(item.currentPrice),
      lowestPriceSeen: numberOrNull(item.lowestPriceSeen),
      lastCheckedAt: numberOrZero(item.lastCheckedAt),
      adjusted: !!item.adjusted,
      adjustedAt: numberOrZero(item.adjustedAt),
      dropAmount: L.computeDrop(item.paidPrice, item.currentPrice),
      monitorUntil: L.monitorUntilOf(item),
      key: key
    };
  }

  function normalizeState(input) {
    var base = defaultState();
    var src = input && typeof input === 'object' ? input : {};
    var items = {};

    Object.keys(src.items || {}).forEach(function (key) {
      var clean = sanitizeItem(Object.assign({}, src.items[key], { key: key }));
      if (!clean) return;
      var storedKey = clean.key;
      delete clean.key;
      items[storedKey] = clean;
    });

    return {
      version: 1,
      items: items,
      lastScrapeAt: numberOrZero(src.lastScrapeAt != null ? src.lastScrapeAt : base.lastScrapeAt),
      lastPriceCheckAt: numberOrZero(src.lastPriceCheckAt != null ? src.lastPriceCheckAt : base.lastPriceCheckAt),
      latestVersion: stringOrNull(src.latestVersion != null ? src.latestVersion : base.latestVersion),
      lastUpdateCheckAt: numberOrZero(src.lastUpdateCheckAt != null ? src.lastUpdateCheckAt : base.lastUpdateCheckAt),
      warehouseNumber: stringOrNull(src.warehouseNumber != null ? src.warehouseNumber : base.warehouseNumber),
      clientId: stringOrNull(src.clientId != null ? src.clientId : base.clientId)
    };
  }

  function loadState() {
    try {
      return normalizeState(GM_getValue(STORE_KEY, null));
    } catch (err) {
      return defaultState();
    }
  }

  function saveState(state) {
    var clean = normalizeState(state);
    GM_setValue(STORE_KEY, clean);
    return clean;
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function randomUUID() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }

    var bytes = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i += 1) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.prototype.map.call(bytes, function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20)
    ].join('-');
  }

  function headersToObject(headers) {
    var out = {};
    if (!headers) return out;

    try {
      if (typeof headers.forEach === 'function') {
        headers.forEach(function (value, key) {
          out[String(key).toLowerCase()] = String(value);
        });
        return out;
      }

      if (Array.isArray(headers)) {
        headers.forEach(function (pair) {
          if (!pair || pair.length < 2) return;
          out[String(pair[0]).toLowerCase()] = String(pair[1]);
        });
        return out;
      }

      Object.keys(headers).forEach(function (key) {
        out[String(key).toLowerCase()] = String(headers[key]);
      });
    } catch (err) {
      return out;
    }

    return out;
  }

  function mergeHeaders() {
    var out = {};
    for (var i = 0; i < arguments.length; i += 1) {
      var obj = headersToObject(arguments[i]);
      Object.keys(obj).forEach(function (key) {
        out[key] = obj[key];
      });
    }
    return out;
  }

  function unique(list) {
    var seen = Object.create(null);
    var out = [];
    list.forEach(function (value) {
      var key = String(value);
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push(key);
    });
    return out;
  }

  function isOrdersUrl(url) {
    return typeof url === 'string' && url.indexOf(ORDERS_URL) === 0;
  }

  function captureAuthFromHeaders(headers, body) {
    try {
      var bearer = headers['costco-x-authorization'];
      if (!bearer) return;

      var wcsClientId = headers['costco-x-wcs-clientid'] || DEFAULT_CLIENT_ID;
      var clientIdentifier = headers['client-identifier'] || randomUUID();
      var warehouseNumber = capturedAuth && capturedAuth.warehouseNumber || null;

      if (body && typeof body === 'string') {
        try {
          var parsed = JSON.parse(body);
          if (parsed && parsed.variables && parsed.variables.warehouseNumber != null) {
            warehouseNumber = String(parsed.variables.warehouseNumber);
          }
        } catch (err) {
          // Body sniffing is opportunistic only.
        }
      }

      capturedAuth = {
        bearer: bearer,
        wcsClientId: wcsClientId,
        clientIdentifier: clientIdentifier,
        warehouseNumber: warehouseNumber,
        clientId: wcsClientId
      };
    } catch (err) {
      // Sniffer must never affect the page.
    }
  }

  function rememberWarehouseFromOrdersResponse(json) {
    try {
      var extracted = L.extractOrders(json);
      var first = extracted.bcOrders && extracted.bcOrders[0];
      if (!first || first.warehouseNumber == null) return;
      var whs = String(first.warehouseNumber);
      if (capturedAuth) {
        capturedAuth.warehouseNumber = whs;
      }
      var state = loadState();
      if (state.warehouseNumber !== whs) {
        state.warehouseNumber = whs;
        saveState(state);
      }
    } catch (err) {
      // Response sniffing is best-effort only.
    }
  }

  function inspectFetchResponse(response) {
    try {
      if (!response || typeof response.clone !== 'function') return;
      response.clone().json().then(rememberWarehouseFromOrdersResponse).catch(function () {});
    } catch (err) {
      // Sniffer must never affect the page.
    }
  }

  function installFetchSniffer() {
    var origFetch = PAGE && PAGE.fetch;
    if (typeof origFetch !== 'function' || origFetch.__cpwSniffed) return;

    function wrappedFetch(input, init) {
      var shouldInspect = false;
      try {
        var url = typeof input === 'string' ? input : input && input.url;
        shouldInspect = isOrdersUrl(url);
        if (shouldInspect) {
          var requestHeaders = input && input.headers;
          var initHeaders = init && init.headers;
          var headers = mergeHeaders(requestHeaders, initHeaders);
          var body = init && init.body;
          captureAuthFromHeaders(headers, body);
        }
      } catch (err) {
        // Sniffer must never affect the page.
      }

      var result = origFetch.apply(this, arguments);
      if (shouldInspect && result && typeof result.then === 'function') {
        result.then(inspectFetchResponse).catch(function () {});
      }
      return result;
    }

    wrappedFetch.__cpwSniffed = true;
    wrappedFetch.__cpwOriginal = origFetch;
    try {
      PAGE.fetch = wrappedFetch;
    } catch (err) {
      // Sniffer install is best-effort and must not affect the page.
    }
  }

  function installXhrSniffer() {
    var XHR = PAGE && PAGE.XMLHttpRequest;
    if (!XHR || !XHR.prototype || XHR.prototype.__cpwSniffed) return;

    var origOpen = XHR.prototype.open;
    var origSetRequestHeader = XHR.prototype.setRequestHeader;
    var origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      try {
        this.__cpwUrl = typeof url === 'string' ? url : String(url);
        this.__cpwHeaders = {};
      } catch (err) {
        // Best-effort only.
      }
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.setRequestHeader = function (name, value) {
      try {
        if (!this.__cpwHeaders) this.__cpwHeaders = {};
        this.__cpwHeaders[String(name).toLowerCase()] = String(value);
      } catch (err) {
        // Best-effort only.
      }
      return origSetRequestHeader.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      try {
        if (isOrdersUrl(this.__cpwUrl)) {
          captureAuthFromHeaders(this.__cpwHeaders || {}, body);
          this.addEventListener('loadend', function () {
            try {
              if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') return;
              var json = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
              rememberWarehouseFromOrdersResponse(json);
            } catch (err) {
              // Best-effort only.
            }
          });
        }
      } catch (err) {
        // Best-effort only.
      }
      return origSend.apply(this, arguments);
    };

    XHR.prototype.__cpwSniffed = true;
  }

  function installAuthSniffer() {
    try {
      installFetchSniffer();
    } catch (err) {
      // Sniffer install is best-effort.
    }
    try {
      installXhrSniffer();
    } catch (err) {
      // Sniffer install is best-effort.
    }
  }

  async function gql(query, variables) {
    if (!capturedAuth || !capturedAuth.bearer) {
      throw new Error('NO_TOKEN');
    }

    var res = await pageFetch(ORDERS_URL, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        'content-type': 'application/json-patch+json',
        'costco-x-authorization': capturedAuth.bearer,
        'costco-x-wcs-clientid': capturedAuth.wcsClientId || capturedAuth.clientId || DEFAULT_CLIENT_ID,
        'client-identifier': capturedAuth.clientIdentifier || randomUUID(),
        'costco.env': 'ecom',
        'costco.service': 'restOrders'
      },
      body: JSON.stringify({ query: query, variables: variables || {} })
    });

    if (res.status === 401 || res.status === 403) {
      capturedAuth = null;
      throw new Error('TOKEN_EXPIRED');
    }
    if (!res.ok) {
      throw new Error('HTTP_' + res.status);
    }

    return res.json();
  }

  async function scrapeLast30() {
    if (!capturedAuth || !capturedAuth.bearer) {
      return { ok: false, reason: 'NO_TOKEN' };
    }

    var state = loadState();
    var whs = capturedAuth.warehouseNumber || state.warehouseNumber || DEFAULT_WAREHOUSE_NUMBER;
    var range = L.dateRangeLast30(Date.now());
    var allOrders = [];
    var detailItems = [];
    var page = 1;
    var pageSize = 10;

    function persistScrape(markComplete) {
      if (allOrders[0] && allOrders[0].warehouseNumber != null) {
        state.warehouseNumber = String(allOrders[0].warehouseNumber);
      } else {
        state.warehouseNumber = whs;
      }
      state.clientId = capturedAuth && (capturedAuth.clientId || capturedAuth.wcsClientId) || state.clientId || DEFAULT_CLIENT_ID;

      var records = L.buildItemRecords(allOrders, detailItems, Date.now());
      state.items = L.mergeItems(state.items, records, Date.now());
      state.items = L.pruneExpired(state.items, Date.now());
      Object.keys(state.items).forEach(function (key) {
        if (L.isExcludedDescription(state.items[key] && state.items[key].description)) {
          delete state.items[key];
        }
      });
      if (markComplete) {
        state.lastScrapeAt = Date.now();
      }
      saveState(state);
      return records;
    }

    try {
      while (true) {
        var resp = await gql(QUERY_ONLINE_ORDERS, {
          startDate: range.startDate,
          endDate: range.endDate,
          pageNumber: page,
          pageSize: pageSize,
          warehouseNumber: whs
        });
        var extracted = L.extractOrders(resp);
        allOrders.push.apply(allOrders, extracted.bcOrders);

        var first = extracted.bcOrders && extracted.bcOrders[0];
        if (first && first.warehouseNumber != null) {
          whs = String(first.warehouseNumber);
          capturedAuth.warehouseNumber = whs;
        }

        if (page * pageSize >= extracted.totalNumberOfRecords || extracted.bcOrders.length === 0) {
          break;
        }
        page += 1;
        await sleep(200);
      }

      var orderNumbers = unique(allOrders.filter(function (order) {
        return String(order.status || '').toLowerCase() !== 'cancelled';
      }).map(function (order) {
        return order.orderNumber != null ? order.orderNumber : order.sourceOrderNumber;
      }));

      for (var i = 0; i < orderNumbers.length; i += 1) {
        var orderNumber = orderNumbers[i];
        try {
          var detailResp = await gql(QUERY_ORDER_DETAILS, { orderNumbers: [orderNumber] });
          detailItems.push.apply(detailItems, L.extractDetailLineItems(detailResp));
        } catch (err) {
          if (err && (err.message === 'NO_TOKEN' || err.message === 'TOKEN_EXPIRED')) {
            throw err;
          }
          // Skip a single bad order and continue with the rest.
        }
        await sleep(200);
      }

      var records = persistScrape(true);
      return { ok: true, count: records.length };
    } catch (err) {
      if (err && (err.message === 'NO_TOKEN' || err.message === 'TOKEN_EXPIRED')) {
        if (allOrders.length > 0) {
          persistScrape(false);
        }
        return { ok: false, reason: err.message };
      }
      return { ok: false, reason: 'SCRAPE_FAILED', error: err && err.message ? err.message : String(err) };
    }
  }

  async function refreshPrices(force) {
    var state = loadState();
    var now = Date.now();
    if (!force && now - state.lastPriceCheckAt < PRICE_CHECK_INTERVAL) {
      return { ok: true, skipped: true };
    }

    var whs = state.warehouseNumber || DEFAULT_WAREHOUSE_NUMBER;
    var clientId = state.clientId || DEFAULT_CLIENT_ID;
    var monitoredKeys = Object.keys(state.items || {}).filter(function (key) {
      return L.isMonitored(state.items[key], Date.now()) && !state.items[key].adjusted;
    });

    for (var i = 0; i < monitoredKeys.length; i += 1) {
      var key = monitoredKeys[i];
      var item = state.items[key];
      try {
        var url = PRICE_URL +
          '?whsNumber=' + encodeURIComponent(whs) +
          '&clientId=' + encodeURIComponent(clientId) +
          '&item=' + encodeURIComponent(item.itemNumber) +
          '&locale=en-us';
        var res = await pageFetch(url, {
          headers: {
            'client-identifier': PRICE_CLIENT_IDENTIFIER
          }
        });
        var json = await res.json();
        var parsed = L.parseDisplayPrice(json);
        state.items[key] = L.applyPriceUpdate(state.items[key], parsed.onlinePrice, Date.now());
      } catch (err) {
        // Leave the item unchanged and continue with the next one.
      }
      await sleep(250);
    }

    state.lastPriceCheckAt = Date.now();
    saveState(state);
    notifyDashboards();
    return { ok: true };
  }

  function notifyDashboards() {
    // GM_setValue already notifies visible overlays via GM_addValueChangeListener.
  }

  function ensureStyle() {
    if (window.__cpwStyleInjected) return;

    try {
      if (typeof GM_addStyle === 'function' && UI && UI.DASHBOARD_CSS) {
        GM_addStyle(UI.DASHBOARD_CSS);
        window.__cpwStyleInjected = true;
        return;
      }
    } catch (err) {
      // Fall back to a normal style element below.
    }

    try {
      if (!document.getElementById('cpw-style')) {
        var st = document.createElement('style');
        st.id = 'cpw-style';
        st.textContent = UI && UI.DASHBOARD_CSS || '';
        (document.head || document.documentElement).appendChild(st);
      }
      window.__cpwStyleInjected = true;
    } catch (err) {
      // Style injection must not affect page behavior.
    }
  }

  function getDashboardState() {
    var state = loadState();
    var hasItems = Object.keys(state.items || {}).length > 0;
    var tokenStale = hasItems && (!capturedAuth || !capturedAuth.bearer) &&
      (!state.lastScrapeAt || Date.now() - state.lastScrapeAt > TOKEN_STALE_MS);
    var latest = state.latestVersion;
    var updateAvailable = latest && L.isNewerVersion(latest, CURRENT_VERSION)
      ? { version: latest, current: CURRENT_VERSION, url: UPDATE_DOWNLOAD_URL }
      : null;
    return Object.assign({}, state, {
      tokenStale: tokenStale,
      updateAvailable: updateAvailable,
      currentVersion: CURRENT_VERSION
    });
  }

  function markAdjusted(key) {
    var state = loadState();
    state.items = L.markItemAdjusted(state.items, key, Date.now());
    saveState(state);
  }

  function checkForUpdate(force) {
    return new Promise(function (resolve) {
      try {
        var state = loadState();
        if (!force && Date.now() - state.lastUpdateCheckAt < UPDATE_CHECK_INTERVAL) {
          resolve({ skipped: true });
          return;
        }

        if (typeof GM_xmlhttpRequest !== 'function') {
          resolve({ ok: false });
          return;
        }

        function saveAttempt(ok, responseText) {
          try {
            var match = /@version\s+([^\s]+)/.exec(responseText || '');
            var remote = match ? match[1] : null;
            var next = loadState();
            if (remote) next.latestVersion = remote;
            next.lastUpdateCheckAt = Date.now();
            saveState(next);
          } catch (err) {
            // Update check state is best-effort.
          }
          resolve(ok ? { ok: true } : { ok: false });
        }

        GM_xmlhttpRequest({
          method: 'GET',
          url: UPDATE_META_URL,
          timeout: 10000,
          onload: function (response) {
            saveAttempt(true, response && response.responseText);
          },
          onerror: function () {
            saveAttempt(false, '');
          },
          ontimeout: function () {
            saveAttempt(false, '');
          }
        });
      } catch (err) {
        resolve({ ok: false });
      }
    });
  }

  function onReady(fn) {
    if (document.body) {
      fn();
      return;
    }
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  function mountOverlay() {
    try {
      if (!UI || typeof UI.renderDashboard !== 'function') return;
      if (!document.body) {
        onReady(mountOverlay);
        return;
      }

      ensureStyle();
      checkForUpdate(false);

      var existing = document.querySelector('.cpw-scrim');
      if (existing) existing.remove();

      UI.renderDashboard(document.body, getDashboardState(), {
        rescan: async function () {
          await scrapeLast30();
          await refreshPrices(true);
          mountOverlay();
        },
        refreshPrices: async function () {
          await refreshPrices(true);
          mountOverlay();
        },
        markAdjusted: async function (key) {
          markAdjusted(key);
          mountOverlay();
        },
        close: function () {
          var scrim = document.querySelector('.cpw-scrim');
          if (scrim) scrim.remove();
        }
      });

      if (!dashboardListenerInstalled && typeof GM_addValueChangeListener === 'function') {
        dashboardListenerInstalled = true;
        GM_addValueChangeListener(STORE_KEY, function () {
          if (document.querySelector('.cpw-scrim')) {
            mountOverlay();
          }
        });
      }
    } catch (err) {
      // Dashboard overlay must not affect page behavior.
    }
  }

  function openDashboard() {
    onReady(mountOverlay);
  }

  function isOrdersPage() {
    var hash = String(window.location.hash || '').toLowerCase();
    return hash.indexOf('ordersandpurchases') !== -1;
  }

  function waitForToken(timeoutMs) {
    var started = Date.now();
    return new Promise(function (resolve) {
      function tick() {
        if (capturedAuth && capturedAuth.bearer) {
          resolve(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tick, 500);
      }
      tick();
    });
  }

  function runOrdersScrapeWhenReady() {
    waitForToken(20000).then(function (hasToken) {
      if (!hasToken) return;
      scrapeLast30().then(function () {
        return refreshPrices(false);
      }).catch(function () {});
    });
  }

  function registerMenuCommands() {
    try {
      GM_registerMenuCommand('Costco PriceWatch — Open dashboard', openDashboard);
      GM_registerMenuCommand('Costco PriceWatch — Rescan now', async function () {
        await scrapeLast30();
        await refreshPrices(true);
      });
      GM_registerMenuCommand('Costco PriceWatch — Refresh prices now', function () {
        return refreshPrices(true);
      });
    } catch (err) {
      // Menu registration should not affect page behavior.
    }
  }

  function main() {
    installAuthSniffer();
    registerMenuCommands();
    setTimeout(function () {
      checkForUpdate(false);
    }, 6000);

    if (isOrdersPage()) {
      runOrdersScrapeWhenReady();
    } else {
      setTimeout(function () {
        refreshPrices(false).catch(function () {});
      }, 4000);
    }

    window.addEventListener('hashchange', function () {
      if (isOrdersPage()) {
        runOrdersScrapeWhenReady();
      }
    });
  }

  main();
})();

})();
