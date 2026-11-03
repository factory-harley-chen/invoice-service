/* global document, window, EventSource, performance */
// The loop screen's page. It only renders what the server pushes; it never
// calls Slack or GitHub. Live counters (the clock, "waiting n min") tick here
// from the server's clock, so replay and simulation count in the run's time.
'use strict';

const STATION_X = [200, 488, 776, 1064, 1352, 1640];
const SOURCE_NAMES = { monitor: 'Monitor', slack: 'Slack', github: 'GitHub' };

let state = null;
let clock = null;
let connected = false;

const $ = (id) => document.getElementById(id);

function nowMs() {
  if (clock === null) return Date.now();
  return clock.virtualMs + (performance.now() - clock.receivedAt) * clock.speed;
}

function pad(n) {
  return n < 10 ? `0${n}` : String(n);
}

function clockText(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function minutesText(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  return m < 1 ? 'under 1 min' : `${m} min`;
}

function setLink(el, url) {
  if (url) {
    el.setAttribute('href', url);
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener');
  } else {
    el.removeAttribute('href');
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Browsers break lines after a hyphen, which splits ids such as B-1042.
function setUnbroken(node, value) {
  node.textContent = '';
  let last = 0;
  for (const m of value.matchAll(/\b[A-Z]+-\d+\b/g)) {
    if (m.index > last) node.append(value.slice(last, m.index));
    node.append(el('span', 'nowrap', m[0]));
    last = m.index + m[0].length;
  }
  if (last < value.length) node.append(value.slice(last));
}

function buildStations(stations) {
  const root = $('stations');
  root.textContent = '';
  stations.forEach((s, i) => {
    const a = el('a', 'st');
    a.id = `st-${s.key}`;
    a.dataset.key = s.key;
    a.style.left = `${STATION_X[i]}px`;
    const dot = el('span', 'st-dot', String(s.n));
    const tx = el('div', 'st-tx');
    tx.append(el('div', 'st-n', s.name), el('div', 'st-q', s.question), el('div', 'st-a'), el('div', 'st-meta'), el('ul', 'st-rows'), el('div', 'st-t'));
    a.append(dot, tx);
    root.append(a);
  });
}

function renderStation(s) {
  const a = $(`st-${s.key}`);
  if (!a) return;
  a.dataset.status = s.status;
  a.title = s.at ? new Date(s.at).toLocaleString('en-GB') : '';
  setLink(a, s.url);
  const answer = a.querySelector('.st-a');
  answer.dataset.waiting = s.status === 'waiting' ? 'true' : 'false';
  if (s.status !== 'waiting') setUnbroken(answer, s.answer);
  a.querySelector('.st-meta').textContent = s.meta;
  a.querySelector('.st-t').textContent = s.timeText;
  const rows = a.querySelector('.st-rows');
  rows.textContent = '';
  for (const r of s.rows) {
    const li = el('li', '', r.label);
    li.dataset.state = r.state;
    if (r.note) li.title = r.note;
    rows.append(li);
  }
}

function renderSources() {
  const root = $('sources');
  root.textContent = '';
  if (!connected) {
    const s = el('span', 'src', 'Screen: reconnecting');
    s.dataset.state = 'error';
    root.append(s);
  }
  if (!state) return;
  for (const key of ['monitor', 'slack', 'github']) {
    const src = state.sources[key];
    const name = SOURCE_NAMES[key];
    const words = src.state === 'off' ? `${name}: recorded` : src.note && src.state !== 'ok' ? `${name}: ${src.note}` : `${name} ${src.state === 'ok' ? 'ok' : src.state}`;
    const s = el('span', 'src', words);
    s.dataset.state = src.state;
    root.append(s);
  }
}

function renderCards() {
  const inv = state.invoice;
  const card = $('invoice');
  if (!inv) {
    card.dataset.state = 'none';
    $('invoice-line').textContent = 'Shown when an alert fires';
    $('invoice-expected').textContent = '';
    $('invoice-actual').textContent = '';
    $('invoice-was').textContent = '';
    card.querySelector('.card-label').textContent = 'Invoice';
    setLink(card, '');
  } else {
    card.dataset.state = inv.fixed ? 'fixed' : 'broken';
    card.querySelector('.card-label').textContent = `Invoice ${inv.bookingId}`;
    $('invoice-line').textContent = inv.customer ? `${inv.customer} \u00b7 ${inv.line}` : inv.line;
    $('invoice-expected').textContent = `Expected ${inv.expected}`;
    $('invoice-actual').textContent = inv.fixed ? `Now ${inv.expected}` : `Got ${inv.actual}`;
    $('invoice-was').textContent = inv.fixed ? `was ${inv.actual}` : '';
    setLink(card, inv.url);
  }

  const rec = state.record;
  const dl = $('record-rows');
  dl.textContent = '';
  const row = (label, value, url) => {
    const dd = el('dd');
    if (url) {
      const a = el('a', '', value);
      setLink(a, url);
      dd.append(a);
    } else {
      dd.textContent = value;
    }
    dl.append(el('dt', '', label), dd);
  };
  row('Run as', rec.runAs);
  row('Pull request by', rec.prAuthor);
  row('Approved by', rec.approver);
  if (rec.runUrl) row('Run record', 'open', rec.runUrl);
}

function renderLeft() {
  const lb = state.leftBehind;
  const a = $('left');
  a.dataset.visible = lb.visible ? 'true' : 'false';
  a.dataset.status = lb.visible ? lb.status : 'idle';
  setLink(a, lb.visible ? lb.url : '');
  $('left-answer').textContent = lb.visible ? lb.answer : '';
  $('left-time').textContent = lb.visible ? lb.timeText : '';
  a.dataset.open = lb.visible && (lb.answer !== '' || lb.timeText !== '') ? 'true' : 'false';
}

function render() {
  renderSources();
  if (!state) return;
  const banner = $('banner');
  banner.dataset.kind = state.banner.kind;
  banner.textContent = state.banner.text;
  $('stage').dataset.loop = state.loop;
  if (!$('st-signal')) buildStations(state.stations);
  state.stations.forEach(renderStation);
  renderLeft();
  renderCards();
  tick();
}

function tick() {
  if (!state) return;
  const now = nowMs();
  const c = $('clock');
  if (state.loop === 'fixed') {
    c.dataset.phase = 'fixed';
    c.textContent = state.summary;
  } else if (state.clockFrom) {
    c.dataset.phase = 'broken';
    c.textContent = `Broken ${clockText(now - Date.parse(state.clockFrom))} ago`;
  } else {
    c.dataset.phase = 'idle';
    c.textContent = 'No alert';
  }
  for (const s of state.stations) {
    if (s.status !== 'waiting' || !s.waitingSince) continue;
    const a = document.querySelector(`#st-${s.key} .st-a`);
    if (a) a.textContent = `${s.waitingLabel}, ${minutesText(now - Date.parse(s.waitingSince))}`;
  }
}

function fit() {
  const stage = $('stage');
  const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  const x = (window.innerWidth - 1920 * s) / 2;
  const y = (window.innerHeight - 1080 * s) / 2;
  stage.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
}

function connect() {
  const es = new EventSource('/events');
  es.onopen = () => {
    connected = true;
    renderSources();
  };
  es.onerror = () => {
    connected = false;
    renderSources();
  };
  es.onmessage = (msg) => {
    const p = JSON.parse(msg.data);
    state = p.state;
    clock = { virtualMs: p.clock.virtualMs, speed: p.clock.speed, receivedAt: performance.now() };
    connected = true;
    render();
  };
}

window.addEventListener('resize', fit);
fit();
connect();
window.setInterval(tick, 250);
