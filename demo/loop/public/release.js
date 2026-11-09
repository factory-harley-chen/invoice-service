/* global document, fetch, setTimeout, clearTimeout */
// The release screen's page. It shows what staging serves and what the loop
// server knows. Its one action, "Roll out", asks the server to run
// ./demo.sh break; everything after that is the real service and monitor.
'use strict';

const POLL_MS = 1000;
const berlin = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const berlinHm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

let view = null;
let busy = false;
let lastCurrencies = '';
let lastPreview = '';
let lastTotal = null;
let lastYenOn = null;
let lastActivity = '';
let shownSteps = null;
let sendAt = '15:00';
let toastTimer = null;

const $ = (id) => document.getElementById(id);

function at(iso) {
  return iso ? berlin.format(new Date(iso)) : '';
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function renderStats() {
  const s = view.stats;
  if (s.invoices === 0) return;
  $('lede').textContent = `Today's run: ${plural(s.invoices, 'invoice')} to ${plural(s.customers, 'customer')} in ${s.currenciesOn} ${s.currenciesOn === 1 ? 'currency' : 'currencies'}`;
}

// Minutes until the next send time on Berlin's clock.
function untilSend(at) {
  const [h, m] = at.split(':').map(Number);
  const parts = Object.fromEntries(berlin.formatToParts(new Date()).map((p) => [p.type, p.value]));
  let diff = h * 3600 + m * 60 - (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second));
  const tomorrow = diff <= 0;
  if (tomorrow) diff += 86400;
  return { tomorrow, minutes: Math.max(1, Math.ceil(diff / 60)) };
}

function inText(min) {
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r === 0 ? `in ${h} h` : `in ${h} h ${r} min`;
}

function renderRun() {
  if (view.preview) sendAt = view.preview.sendAt;
  const u = untilSend(sendAt);
  $('run-at').textContent = u.tomorrow ? `tomorrow ${sendAt}` : sendAt;
  $('run-in').textContent = inText(u.minutes);
  $('run-chip').classList.toggle('urgent', view.check === 'wrong');
}

function renderCheck() {
  const c = view.check;
  const doc = $('doc');
  doc.classList.toggle('wrong', c === 'wrong');
  doc.classList.toggle('right', c === 'right');
  const exp = $('doc-expected');
  exp.hidden = c !== 'wrong';
  if (c === 'wrong') exp.textContent = `Rate card: ${view.alert.expected}`;
  const pill = $('preview-status');
  pill.classList.toggle('red', c === 'wrong');
  pill.classList.toggle('green', c === 'right');
  pill.classList.toggle('neutral', c === null);
  if (c === 'wrong') pill.textContent = "Doesn't match the rate card";
  else if (c === 'right') pill.textContent = 'Matches the rate card';
  else if (view.preview) pill.textContent = `Scheduled · ${view.preview.sendAt}`;
}

function step(cls, time, title, detail) {
  const li = el('li', `step ${cls}`);
  li.append(el('time', '', time));
  const rail = el('span', 'rail');
  rail.append(el('span', 'dot'));
  li.append(rail, el('b', '', title));
  if (detail) li.append(el('small', '', detail));
  return li;
}

function renderActivity() {
  const key = JSON.stringify([view.activity, view.stats.invoices, sendAt]);
  if (key === lastActivity) return;
  lastActivity = key;
  const track = $('track');
  track.textContent = '';
  const seen = new Set();
  if (view.activity.length === 0) track.append(step('empty', 'Today', 'No changes yet', 'Settings and alerts show here'));
  for (const a of view.activity) {
    const li = step(`tone-${a.tone}`, berlinHm.format(new Date(a.at)), a.title, a.detail);
    if (shownSteps !== null && !shownSteps.has(a.key)) li.classList.add('new');
    seen.add(a.key);
    track.append(li);
  }
  shownSteps = seen;
  const n = view.stats.invoices;
  track.append(step('end', sendAt, 'Invoices go out', n > 0 ? `${plural(n, 'invoice')} to customers` : ''));
}

function renderCurrencies() {
  const key = JSON.stringify([view.currencies, view.canRollOut, view.yenSince, busy]);
  if (key === lastCurrencies) return;
  lastCurrencies = key;
  const list = $('currencies');
  list.textContent = '';
  for (const c of view.currencies) {
    const li = el('li', 'cur');
    li.dataset.code = c.code;
    li.append(el('span', 'cur-badge', c.symbol));
    const name = el('span', 'cur-name');
    const title = el('b', '', c.name);
    if (c.rollingOut || (c.code === 'JPY' && view.yenSince)) title.append(el('em', 'tag', 'New'));
    name.append(title);
    let sub = `${c.code} · ${plural(c.customers, 'customer')}`;
    if (c.rollingOut) sub = `${c.code} · Off · ${view.canRollOut || busy || !view.reason ? "invoiced in euros until it's on" : view.reason}`;
    else if (c.code === 'JPY' && view.yenSince) sub += ` · on since ${at(view.yenSince)}`;
    name.append(el('small', '', sub));
    li.append(name);
    const state = el('span', 'cur-state');
    if (c.on) {
      state.append(el('span', 'pill green', 'On'), el('span', 'switch'));
    } else {
      const btn = el('button', 'btn primary', 'Turn on yen billing');
      btn.type = 'button';
      btn.disabled = !view.canRollOut || busy;
      if (view.reason) btn.title = view.reason;
      btn.addEventListener('click', openModal);
      state.append(btn);
    }
    li.append(state);
    list.append(li);
    if (c.code === 'JPY' && c.on && lastYenOn === false) li.classList.add('flash');
  }
  lastYenOn = view.yenOn;
}

function renderPreview() {
  const p = view.preview;
  const key = JSON.stringify(p);
  if (key === lastPreview) return;
  lastPreview = key;
  const total = $('doc-total');
  const lines = $('doc-lines');
  lines.textContent = '';
  if (p === null) {
    $('doc-id').textContent = 'Invoice';
    $('doc-customer').textContent = 'Not available';
    $('doc-customer-id').textContent = '';
    $('doc-currency').textContent = '';
    $('preview-status').textContent = 'Waiting for the service';
    total.textContent = '–';
    return;
  }
  $('doc-id').textContent = `Invoice ${p.bookingId}`;
  $('doc-customer').textContent = p.customer.name;
  $('doc-customer-id').textContent = p.customer.id;
  $('doc-currency').textContent = p.currency;
  for (const line of p.lines) {
    const tr = el('tr');
    tr.append(
      el('td', '', line.item),
      el('td', 'num', plural(line.quantity, line.unit)),
      el('td', 'num', line.unitPrice.formatted),
      el('td', 'num amt', line.total.formatted),
    );
    lines.append(tr);
  }
  total.textContent = p.total.formatted;
  if (lastTotal !== null && lastTotal !== p.total.formatted) {
    total.classList.remove('updated');
    void total.offsetWidth;
    total.classList.add('updated');
  }
  lastTotal = p.total.formatted;
}

function renderAlert() {
  const box = $('alert');
  const a = view.alert;
  $('bell').dataset.alert = String(a !== null && a.resolvedAt === null);
  if (a === null) {
    box.hidden = true;
    return;
  }
  const resolved = a.resolvedAt !== null;
  box.classList.toggle('resolved', resolved);
  if (resolved) {
    $('alert-title').textContent = `Resolved: invoice ${a.bookingId}`;
    $('alert-text').textContent = `${a.customer}'s invoice matches the rate card again.`;
    $('alert-time').textContent = at(a.resolvedAt);
  } else {
    $('alert-title').textContent = `Billing alert: invoice ${a.bookingId}`;
    $('alert-text').textContent = `${a.customer}: expected ${a.expected}, invoiced ${a.actual}. On-call has been notified in Slack.`;
    $('alert-time').textContent = at(a.at);
  }
  box.hidden = false;
}

function render() {
  renderStats();
  renderCurrencies();
  renderPreview();
  renderCheck();
  renderRun();
  renderAlert();
  renderActivity();
}

function openModal() {
  if (!view || !view.canRollOut || busy) return;
  $('modal-error').hidden = true;
  $('modal').hidden = false;
  $('confirm').focus();
}

function closeModal() {
  if (busy) return;
  $('modal').hidden = true;
}

function setBusy(on) {
  busy = on;
  const confirm = $('confirm');
  confirm.disabled = on;
  $('cancel').disabled = on;
  confirm.textContent = '';
  if (on) confirm.append(el('span', 'spinner'), 'Rolling out…');
  else confirm.textContent = 'Roll out';
  if (view) renderCurrencies();
}

function toast(title, text) {
  $('toast-title').textContent = title;
  $('toast-text').textContent = text;
  const t = $('toast');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 4000);
}

async function rollOut() {
  setBusy(true);
  let result;
  try {
    const res = await fetch('/release/roll-out', {
      method: 'POST',
      headers: { 'X-Release-Action': 'roll-out', 'Content-Type': 'application/json' },
      body: '{}',
    });
    result = await res.json();
  } catch (e) {
    result = { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  setBusy(false);
  if (result.ok) {
    $('modal').hidden = true;
    toast('Yen billing is on', `JPY added to billing currencies at ${berlin.format(new Date())}`);
    void poll(false);
  } else {
    const err = $('modal-error');
    err.textContent = `Couldn't roll out: ${result.message}`;
    err.hidden = false;
  }
}

async function poll(again = true) {
  try {
    const res = await fetch('/release/state', { cache: 'no-store' });
    if (res.ok) {
      view = await res.json();
      render();
    }
  } catch {
    // The page keeps the last view; the next poll tries again.
  }
  if (again) setTimeout(poll, POLL_MS);
}

$('cancel').addEventListener('click', closeModal);
$('confirm').addEventListener('click', () => void rollOut());
$('modal').addEventListener('click', (e) => {
  if (e.target === $('modal')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});
void poll();
