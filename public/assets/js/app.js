/* Kiln Controller UI
 *
 * Talks to the same four websockets as the original picoreflow UI:
 *   /status  - oven state stream (+ backlog on connect)
 *   /config  - server display configuration
 *   /control - RUN / STOP commands
 *   /storage - profile list / PUT / DELETE
 * No server-side API changes are required.
 */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state

const cfg = {
  temp_scale: 'c',
  time_scale_slope: 'h',
  time_scale_profile: 'm',
  kwh_rate: 0,
  currency_type: '$',
  seek_start: false,
};

let profiles = [];          // as received from /storage
let selectedName = null;    // name of the selected profile
let liveData = [];          // [[runtime, temperature], ...] for the current run
let lastTemp = null;        // latest kiln temperature from /status
let runState = 'IDLE';
let lastRunState = null;
let editing = false;
let editData = [];          // working copy of points while editing
let dragIdx = -1;

const TIME_UNIT_SECONDS = { s: 1, m: 60, h: 3600 };
const TIME_UNIT_LABEL = { s: 'sec', m: 'min', h: 'hr' };

// ---------------------------------------------------------------- helpers

function tempUnit() { return cfg.temp_scale === 'f' ? '°F' : '°C'; }

function hazardTemp() { return cfg.temp_scale === 'f' ? (1500 * 9) / 5 + 32 : 1500; }

function profileUnitSeconds() { return TIME_UNIT_SECONDS[cfg.time_scale_profile] || 60; }

function slopePerUnit(degPerSec) {
  const mult = TIME_UNIT_SECONDS[cfg.time_scale_slope] || 3600;
  return degPerSec * mult;
}

function fmtHMS(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h + ':' + pad(m) + ':' + pad(sec);
}

function currentProfile() {
  return profiles.find((p) => p.name === selectedName) || null;
}

function toast(message, type = 'info', timeout = 5000) {
  const el = document.createElement('div');
  el.className = 'toast' + (type !== 'info' ? ' toast-' + type : '');
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 500);
  }, timeout);
}

function confirmDialog(title, body, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    const dlg = $('confirm_dialog');
    $('confirm_title').textContent = title;
    $('confirm_body').textContent = body;
    $('confirm_ok').textContent = okLabel;
    dlg.returnValue = 'cancel';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}

// ---------------------------------------------------------------- websockets

const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsHost = wsProto + '//' + window.location.host;

const openSockets = new Set();
let everAllOpen = false;
let initialGrace = true;

// The server's websocket loops contain blocking sleeps that stall its whole
// process while it answers a command, which can hold up the remaining
// handshakes. During the initial connection window, queue outgoing commands
// until all four sockets are open so the handshakes complete undisturbed.
let allOpenQueue = [];

function queueWhenAllOpen(fn) {
  if (openSockets.size === 4 || !initialGrace) fn();
  else allOpenQueue.push(fn);
}

function flushAllOpenQueue() {
  const queued = allOpenQueue;
  allOpenQueue = [];
  queued.forEach((fn) => fn());
}

setTimeout(() => {
  initialGrace = false;
  flushAllOpenQueue();
  updateOnline();
}, 4000);

function updateOnline() {
  const banner = $('offline_banner');
  if (openSockets.size === 4) {
    everAllOpen = true;
    flushAllOpenQueue();
    banner.hidden = true;
  } else if (everAllOpen) {
    banner.textContent = 'Connection lost — reconnecting…';
    banner.classList.remove('banner-connecting');
    banner.hidden = false;
  } else if (!initialGrace) {
    banner.textContent = 'Connecting to kiln…';
    banner.classList.add('banner-connecting');
    banner.hidden = false;
  }
}

// Browsers apply a growing per-host backoff to websocket attempts that
// follow a failed attempt (RFC 6455 §7.2.3). In Firefox it persists across
// page reloads and can silently defer new connections by tens of seconds.
// So never retry the websocket blindly: after a drop, poll the server over
// plain HTTP (which is exempt from that backoff) and attempt the websocket
// again only once the server is answering.
const RETRY_MS = 1000;
const t0 = performance.now();
const allSockets = [];
let probeTimer = null;

function wsLog(path, what) {
  console.info('[kiln] ' + path + ' ' + what + ' (+' + ((performance.now() - t0) / 1000).toFixed(2) + 's)');
}

function retryAllNow() { allSockets.forEach((s) => s.retryNow()); }

async function probeServer() {
  try {
    await fetch(window.location.href, { cache: 'no-store' });
    probeTimer = null;
    retryAllNow();
  } catch (err) {
    probeTimer = setTimeout(probeServer, RETRY_MS);
  }
}

function requestReconnect() {
  if (probeTimer !== null) return;
  probeTimer = setTimeout(probeServer, RETRY_MS);
}

function connect(path, { onopen, onmessage } = {}) {
  let ws = null;
  function open() {
    try {
      ws = new WebSocket(wsHost + path);
    } catch (err) {
      console.error('[kiln] ' + path + ' could not be created', err);
      requestReconnect();
      return;
    }
    ws.onopen = () => {
      wsLog(path, 'connected');
      openSockets.add(path);
      updateOnline();
      if (onopen) onopen(api);
    };
    ws.onmessage = (e) => {
      try {
        if (onmessage) onmessage(e);
      } catch (err) {
        console.error(path, err);
      }
    };
    ws.onclose = () => {
      wsLog(path, openSockets.has(path) ? 'closed' : 'connection failed');
      openSockets.delete(path);
      updateOnline();
      requestReconnect();
    };
    ws.onerror = () => ws.close();
  }
  const api = {
    send(msg) {
      if (api.trySend(msg)) return true;
      toast('Not connected to the kiln — command not sent', 'error');
      return false;
    },
    trySend(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
        return true;
      }
      return false;
    },
    retryNow() {
      // skip if connected or an attempt is already in flight
      if (!ws || ws.readyState === WebSocket.CLOSED) open();
    },
  };
  allSockets.push(api);
  open();
  return api;
}

// ---------------------------------------------------------------- chart

const chartSvg = $('chart');
const chartWrap = $('chart_wrap');
const NS = 'http://www.w3.org/2000/svg';
const MARGIN = { l: 52, r: 16, t: 14, b: 36 };

// scale of the most recent render, used for pointer -> data mapping
let scale = null;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function niceStep(rawStep) {
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (rawStep <= m * pow) return m * pow;
  }
  return 10 * pow;
}

function fmtTick(v) {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

function activeProfileData() {
  if (editing) return editData;
  const p = currentProfile();
  return p && Array.isArray(p.data) ? p.data : [];
}

function renderChart() {
  const rect = chartSvg.getBoundingClientRect();
  const W = Math.max(rect.width, 200);
  const H = Math.max(rect.height, 160);
  chartSvg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

  const prof = activeProfileData();

  let xmax = 0;
  let ymax = 0;
  for (const [x, y] of prof) { if (x > xmax) xmax = x; if (y > ymax) ymax = y; }
  for (const [x, y] of liveData) { if (x > xmax) xmax = x; if (y > ymax) ymax = y; }
  xmax = Math.max(xmax * 1.04, 3600);
  ymax = Math.max(ymax * 1.1, cfg.temp_scale === 'f' ? 500 : 260);

  const pw = W - MARGIN.l - MARGIN.r;
  const ph = H - MARGIN.t - MARGIN.b;
  const x2px = (x) => MARGIN.l + (x / xmax) * pw;
  const y2px = (y) => MARGIN.t + ph - (y / ymax) * ph;
  scale = { xmax, ymax, pw, ph, W, H };

  let g = '';

  // x ticks: label in hours when the run is long, minutes otherwise
  const xUnit = xmax > 2 * 3600 ? 3600 : 60;
  const xUnitLabel = xUnit === 3600 ? 'hours' : 'minutes';
  const xStep = niceStep(xmax / xUnit / Math.max(3, Math.floor(pw / 90))) * xUnit;
  for (let x = 0; x <= xmax + 1e-6; x += xStep) {
    const px = x2px(x);
    g += `<line x1="${px}" y1="${MARGIN.t}" x2="${px}" y2="${MARGIN.t + ph}" stroke="var(--grid)"/>`;
    g += `<text x="${px}" y="${MARGIN.t + ph + 18}" fill="var(--ink-muted)" font-size="11" text-anchor="middle">${fmtTick(x / xUnit)}</text>`;
  }
  g += `<text x="${MARGIN.l + pw}" y="${MARGIN.t + ph + 32}" fill="var(--ink-muted)" font-size="11" text-anchor="end">${xUnitLabel}</text>`;

  // y ticks
  const yStep = niceStep(ymax / Math.max(3, Math.floor(ph / 50)));
  for (let y = 0; y <= ymax + 1e-6; y += yStep) {
    const py = y2px(y);
    g += `<line x1="${MARGIN.l}" y1="${py}" x2="${MARGIN.l + pw}" y2="${py}" stroke="var(--grid)"/>`;
    g += `<text x="${MARGIN.l - 8}" y="${py + 4}" fill="var(--ink-muted)" font-size="11" text-anchor="end">${fmtTick(y)}</text>`;
  }
  g += `<text x="${MARGIN.l - 8}" y="${MARGIN.t - 2}" fill="var(--ink-muted)" font-size="11" text-anchor="end">${tempUnit()}</text>`;

  // baseline
  g += `<line x1="${MARGIN.l}" y1="${MARGIN.t + ph}" x2="${MARGIN.l + pw}" y2="${MARGIN.t + ph}" stroke="var(--axis)"/>`;

  const toPath = (data) =>
    data.map((p, i) => (i ? 'L' : 'M') + x2px(p[0]).toFixed(1) + ' ' + y2px(p[1]).toFixed(1)).join(' ');

  if (prof.length) {
    g += `<path d="${toPath(prof)}" fill="none" stroke="var(--series-profile)" stroke-width="2" stroke-linejoin="round"/>`;
  }
  if (liveData.length) {
    g += `<path d="${toPath(liveData)}" fill="none" stroke="var(--series-live)" stroke-width="2" stroke-linejoin="round"/>`;
    const last = liveData[liveData.length - 1];
    g += `<circle cx="${x2px(last[0])}" cy="${y2px(last[1])}" r="4" fill="var(--series-live)" stroke="var(--surface)" stroke-width="2"/>`;
  }

  // draggable points in edit mode: visible mark + a larger invisible hit target
  if (editing) {
    prof.forEach((p, i) => {
      const cx = x2px(p[0]);
      const cy = y2px(p[1]);
      g += `<circle cx="${cx}" cy="${cy}" r="6" fill="var(--series-profile)" stroke="var(--surface)" stroke-width="2" pointer-events="none"/>`;
      g += `<circle class="pt" data-idx="${i}" cx="${cx}" cy="${cy}" r="16" fill="transparent" style="cursor:grab"/>`;
    });
  }

  chartSvg.innerHTML = g;
}

new ResizeObserver(() => renderChart()).observe(chartWrap);

// pointer -> data coordinates
function pointerToData(e) {
  const rect = chartSvg.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const x = ((px - MARGIN.l) / scale.pw) * scale.xmax;
  const y = ((MARGIN.t + scale.ph - py) / scale.ph) * scale.ymax;
  return { x, y };
}

// ---- edit-mode dragging

chartSvg.addEventListener('pointerdown', (e) => {
  if (!editing) return;
  const target = e.target.closest('.pt');
  if (!target) return;
  dragIdx = Number(target.dataset.idx);
  chartSvg.setPointerCapture(e.pointerId);
  e.preventDefault();
});

chartSvg.addEventListener('pointermove', (e) => {
  if (editing && dragIdx >= 0) {
    const { x, y } = pointerToData(e);
    const snap = cfg.time_scale_profile === 's' ? 1 : 60;
    let nx = Math.round(x / snap) * snap;
    const prev = dragIdx > 0 ? editData[dragIdx - 1][0] : 0;
    const next = dragIdx < editData.length - 1 ? editData[dragIdx + 1][0] : Infinity;
    nx = Math.min(Math.max(nx, dragIdx > 0 ? prev + snap : 0), next === Infinity ? nx : next - snap);
    const ny = Math.max(0, Math.round(y));
    editData[dragIdx] = [Math.max(0, nx), ny];
    renderChart();
    renderTable();
    return;
  }
  if (!editing) showTooltip(e);
});

function endDrag() { dragIdx = -1; }
chartSvg.addEventListener('pointerup', endDrag);
chartSvg.addEventListener('pointercancel', endDrag);

chartSvg.addEventListener('dblclick', (e) => {
  if (!editing) return;
  const { x, y } = pointerToData(e);
  addPoint(Math.max(0, Math.round(x)), Math.max(0, Math.round(y)));
});

// ---- hover tooltip (view mode)

function interpProfile(data, t) {
  if (!data.length || t < data[0][0] || t > data[data.length - 1][0]) return null;
  for (let i = 1; i < data.length; i++) {
    if (t <= data[i][0]) {
      const [x1, y1] = data[i - 1];
      const [x2, y2] = data[i];
      return x2 === x1 ? y2 : y1 + ((y2 - y1) * (t - x1)) / (x2 - x1);
    }
  }
  return null;
}

function nearestLive(t) {
  if (!liveData.length) return null;
  let lo = 0;
  let hi = liveData.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (liveData[mid][0] < t) lo = mid; else hi = mid;
  }
  const best = Math.abs(liveData[lo][0] - t) < Math.abs(liveData[hi][0] - t) ? liveData[lo] : liveData[hi];
  return Math.abs(best[0] - t) <= scale.xmax * 0.02 ? best : null;
}

function showTooltip(e) {
  const tip = $('chart_tip');
  const xhair = $('chart_xhair');
  const rect = chartSvg.getBoundingClientRect();
  const px = e.clientX - rect.left;
  if (px < MARGIN.l || px > rect.width - MARGIN.r) { hideTooltip(); return; }
  const t = ((px - MARGIN.l) / scale.pw) * scale.xmax;

  const target = interpProfile(activeProfileData(), t);
  const live = nearestLive(t);
  if (target === null && !live) { hideTooltip(); return; }

  let html = '<div class="tip-time">' + fmtHMS(t) + '</div>';
  if (target !== null) {
    html += '<div class="tip-row"><span class="swatch swatch-profile"></span>Schedule<span class="tip-val">' +
      Math.round(target) + tempUnit() + '</span></div>';
  }
  if (live) {
    html += '<div class="tip-row"><span class="swatch swatch-live"></span>Kiln<span class="tip-val">' +
      Math.round(live[1]) + tempUnit() + '</span></div>';
  }
  tip.innerHTML = html;
  tip.hidden = false;

  xhair.style.left = px + 'px';
  xhair.style.height = rect.height - MARGIN.b + 'px';
  xhair.hidden = false;

  const wrapRect = chartWrap.getBoundingClientRect();
  const tw = tip.offsetWidth;
  let left = px + 14;
  if (left + tw > wrapRect.width - 4) left = px - tw - 14;
  tip.style.left = Math.max(4, left) + 'px';
  tip.style.top = Math.min(e.clientY - rect.top + 14, rect.height - tip.offsetHeight - 8) + 'px';
}

function hideTooltip() {
  $('chart_tip').hidden = true;
  $('chart_xhair').hidden = true;
}

chartSvg.addEventListener('pointerleave', hideTooltip);

// ---------------------------------------------------------------- point table

function renderTable() {
  const tbody = $('point_table').querySelector('tbody');
  $('th_time').textContent = 'Time (' + (TIME_UNIT_LABEL[cfg.time_scale_profile] || 'min') + ')';
  $('th_temp').textContent = 'Temp (' + tempUnit() + ')';
  $('th_rate').textContent = tempUnit() + '/' + (TIME_UNIT_LABEL[cfg.time_scale_slope] || 'hr');

  const unit = profileUnitSeconds();
  let html = '';
  editData.forEach((p, i) => {
    let rate = '';
    if (i > 0) {
      const dt = p[0] - editData[i - 1][0];
      const dps = dt > 0 ? (p[1] - editData[i - 1][1]) / dt : 0;
      const perUnit = Math.round(slopePerUnit(dps));
      rate = (perUnit > 0 ? '▲ ' : perUnit < 0 ? '▼ ' : '▶ ') + Math.abs(perUnit);
    }
    html += '<tr>' +
      '<td class="num">' + (i + 1) + '</td>' +
      '<td><input type="number" inputmode="decimal" min="0" data-row="' + i + '" data-col="0" value="' + esc(Math.round(p[0] / unit)) + '"></td>' +
      '<td><input type="number" inputmode="decimal" min="0" data-row="' + i + '" data-col="1" value="' + esc(Math.round(p[1])) + '"></td>' +
      '<td class="rate">' + rate + '</td>' +
      '<td><button type="button" class="btn btn-icon" data-del="' + i + '" aria-label="Remove point ' + (i + 1) + '">&#10005;</button></td>' +
      '</tr>';
  });
  tbody.innerHTML = html;
}

$('point_table').addEventListener('change', (e) => {
  const input = e.target.closest('input[data-row]');
  if (!input) return;
  const row = Number(input.dataset.row);
  const col = Number(input.dataset.col);
  const value = parseFloat(input.value);
  if (!Number.isFinite(value)) { renderTable(); return; }
  if (col === 0) {
    editData[row][0] = Math.max(0, Math.round(value * profileUnitSeconds()));
  } else {
    editData[row][1] = Math.max(0, value);
  }
  renderChart();
  renderTable();
});

$('point_table').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-del]');
  if (!btn) return;
  editData.splice(Number(btn.dataset.del), 1);
  renderChart();
  renderTable();
});

function addPoint(x, y) {
  if (x === undefined) {
    if (editData.length) {
      const last = editData[editData.length - 1];
      x = last[0] + 30 * 60;
      y = last[1];
    } else {
      x = 0;
      y = cfg.temp_scale === 'f' ? 65 : 20;
    }
  }
  editData.push([x, y]);
  editData.sort((a, b) => a[0] - b[0]);
  renderChart();
  renderTable();
}

// ---------------------------------------------------------------- profile summary

// Port of Profile.find_next_time_from_temperature (lib/oven.py): the time at
// which the schedule first reaches `temperature` on a rising segment.
function seekTimeForTemperature(data, temperature) {
  let time = 0;
  for (let i = 1; i < data.length; i++) {
    const [x1, y1] = data[i - 1];
    const [x2, y2] = data[i];
    if (y2 >= temperature && y1 <= temperature) {
      time = x1 > x2 || y1 >= y2 ? 0 : ((temperature - y1) * (x2 - x1)) / (y2 - y1) + x1;
      if (time === 0 && y1 === y2) {
        // a hold segment at this temperature restarts from its beginning
        time = x1;
        break;
      }
    }
  }
  return time;
}

// Seconds of the schedule that would be skipped if the run started now,
// mirroring Oven.get_start_from_temperature + config.seek_start.
function startOffsetNow(data) {
  if (!cfg.seek_start || lastTemp === null || !data.length) return 0;
  const target0 = interpProfile(data, 0);
  const startTarget = target0 === null ? data[0][1] : target0;
  if (lastTemp <= startTarget + 5) return 0;
  return seekTimeForTemperature(data, lastTemp);
}

function renderSummary() {
  const wrap = $('profile_summary');
  const p = currentProfile();
  if (editing || !p || !Array.isArray(p.data) || p.data.length < 2) {
    wrap.hidden = true;
    return;
  }
  const data = p.data;
  const total = data[data.length - 1][0];

  $('sum_steps').textContent = String(data.length - 1);
  $('sum_total').textContent = fmtHMS(total);

  const offset = startOffsetNow(data);
  $('sum_eta').textContent = fmtHMS(Math.max(0, total - offset));

  const note = $('sum_note');
  if (offset > 0) {
    note.textContent = 'The kiln is already at ' + Math.round(lastTemp) + tempUnit() +
      ', so starting now would skip the first ' + fmtHMS(offset) + ' of the schedule.';
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  $('sum_th_temp').textContent = 'Temperature (' + tempUnit() + ')';
  $('sum_th_rate').textContent = tempUnit() + '/' + (TIME_UNIT_LABEL[cfg.time_scale_slope] || 'hr');
  let html = '';
  for (let i = 1; i < data.length; i++) {
    const [x1, y1] = data[i - 1];
    const [x2, y2] = data[i];
    const dt = x2 - x1;
    const dps = dt > 0 ? (y2 - y1) / dt : 0;
    const perUnit = Math.round(slopePerUnit(dps));
    const rate = (perUnit > 0 ? '▲ ' : perUnit < 0 ? '▼ ' : '▶ ') + Math.abs(perUnit);
    html += '<tr>' +
      '<td class="num">' + i + '</td>' +
      '<td>' + Math.round(y1) + ' → ' + Math.round(y2) + '</td>' +
      '<td>' + fmtHMS(dt) + '</td>' +
      '<td class="rate">' + rate + '</td>' +
      '</tr>';
  }
  $('sum_tbody').innerHTML = html;
  wrap.hidden = false;
}

// ---------------------------------------------------------------- edit mode

function enterEdit(fresh) {
  editing = true;
  dragIdx = -1;
  if (fresh) {
    editData = [];
    $('profile_name').value = '';
  } else {
    const p = currentProfile();
    if (!p) return;
    editData = p.data.map((pt) => [pt[0], pt[1]]);
    $('profile_name').value = p.name;
  }
  $('btn_delete').hidden = fresh;
  $('status_section').hidden = true;
  $('view_toolbar').hidden = true;
  $('edit_toolbar').hidden = false;
  $('edit_hint').hidden = false;
  $('point_table_wrap').hidden = false;
  chartSvg.classList.add('editing');
  hideTooltip();
  renderSummary();
  renderChart();
  renderTable();
  if (fresh) $('profile_name').focus();
}

function exitEdit() {
  editing = false;
  dragIdx = -1;
  $('status_section').hidden = false;
  $('view_toolbar').hidden = false;
  $('edit_toolbar').hidden = true;
  $('edit_hint').hidden = true;
  $('point_table_wrap').hidden = true;
  chartSvg.classList.remove('editing');
  renderChart();
  renderSummary();
}

function saveProfile() {
  const name = $('profile_name').value.trim();
  if (!name) { toast('Please enter a schedule name', 'error'); return; }
  if (editData.length < 2) { toast('A schedule needs at least two points', 'error'); return; }
  let last = -1;
  for (const [x] of editData) {
    if (x <= last) {
      toast('Point times must increase — an oven is not a time machine', 'error');
      return;
    }
    last = x;
  }
  const profile = { type: 'profile', data: editData.map((p) => [Math.round(p[0]), p[1]]), name };
  if (!wsStorage.send(JSON.stringify({ cmd: 'PUT', profile }))) return;
  selectedName = name;
  toast('Schedule "' + name + '" saved', 'success');
  exitEdit();
  wsStorage.send('GET');
}

async function deleteProfile() {
  const name = $('profile_name').value.trim() || selectedName;
  if (!name) return;
  const ok = await confirmDialog('Delete schedule?', '"' + name + '" will be permanently deleted.', 'Delete');
  if (!ok) return;
  const profile = { type: 'profile', data: '', name };
  if (!wsStorage.send(JSON.stringify({ cmd: 'DELETE', profile }))) return;
  if (selectedName === name) selectedName = null;
  toast('Schedule "' + name + '" deleted', 'success');
  exitEdit();
  wsStorage.send('GET');
}

// ---------------------------------------------------------------- run controls

function fillStartDialog() {
  const p = currentProfile();
  if (!p || !p.data.length) return false;
  const seconds = p.data[p.data.length - 1][0];
  const peak = Math.max(...p.data.map((pt) => pt[1]));
  $('dlg_prof_name').textContent = p.name;
  $('dlg_prof_eta').textContent = fmtHMS(seconds);
  $('dlg_prof_peak').textContent = Math.round(peak) + ' ' + tempUnit();
  $('dlg_prof_segments').textContent = String(Math.max(0, p.data.length - 1));
  return true;
}

function startRun() {
  const p = currentProfile();
  if (!p) return;
  liveData = [];
  if (wsControl.send(JSON.stringify({ cmd: 'RUN', profile: p }))) renderChart();
}

async function stopRun() {
  const ok = await confirmDialog('Stop firing?', 'This will abort the current run. The kiln will cool down naturally.', 'Stop firing');
  if (ok) wsControl.send(JSON.stringify({ cmd: 'STOP' }));
}

async function apiCmd(cmd) {
  try {
    await fetch('/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd }),
    });
  } catch (err) {
    toast('Command failed: ' + cmd, 'error');
  }
}

// ---------------------------------------------------------------- status UI

function setBadge(state) {
  const badge = $('state_badge');
  badge.textContent = state;
  badge.className = 'badge';
  if (state === 'RUNNING') badge.classList.add('badge-running');
  else if (state === 'PAUSED') badge.classList.add('badge-paused');
  else badge.classList.add('badge-idle');
}

function updateRunButtons() {
  const running = runState === 'RUNNING';
  const paused = runState === 'PAUSED';
  $('btn_start').hidden = running || paused;
  $('btn_stop').hidden = !(running || paused);
  $('btn_pause').hidden = !running;
  $('btn_resume').hidden = !paused;
  $('btn_start').disabled = !currentProfile();
}

function updateStatusUI(x) {
  setBadge(runState);
  updateRunButtons();

  $('act_temp').textContent = Math.round(x.temperature);

  let hr = Math.round(x.heat_rate);
  if (!Number.isFinite(hr)) hr = 0;
  hr = Math.max(-9999, Math.min(9999, hr));
  $('heat_rate').textContent = hr;

  const active = runState === 'RUNNING' || runState === 'PAUSED';
  if (active) {
    $('target_temp').textContent = Math.round(x.target);
    $('cost').textContent = (x.currency_type || cfg.currency_type) + Number(x.cost || 0).toFixed(2);
    const remaining = Math.max(0, (x.totaltime || 0) - (x.runtime || 0));
    $('eta').textContent = fmtHMS(remaining);
    const pct = x.totaltime > 0 ? Math.min(100, (x.runtime / x.totaltime) * 100) : 0;
    $('progress_row').hidden = false;
    $('progress_bar').style.width = pct + '%';
    $('progress_label').textContent = Math.floor(pct) + '%';
  } else {
    $('target_temp').textContent = '--';
    $('eta').textContent = '--:--:--';
    $('progress_row').hidden = true;
    $('progress_bar').style.width = '0%';
  }

  let out = 0;
  if (x.pidstats && Number.isFinite(x.pidstats.out)) out = x.pidstats.out;
  else if (Number.isFinite(x.heat)) out = x.heat;
  const pct = Math.max(0, Math.min(100, Math.round(out * 100)));
  $('heat_bar').style.width = pct + '%';
  $('heat_pct').textContent = pct + '%';

  $('chip_catchup').hidden = !x.catching_up;
  $('chip_hazard').hidden = !(x.temperature > hazardTemp());
}

// ---------------------------------------------------------------- profile select

function renderSelect() {
  const sel = $('profile_select');
  sel.innerHTML = '';
  if (!profiles.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No schedules yet';
    opt.disabled = true;
    opt.selected = true;
    sel.appendChild(opt);
    updateRunButtons();
    return;
  }
  if (!profiles.some((p) => p.name === selectedName)) selectedName = profiles[0].name;
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    opt.selected = p.name === selectedName;
    sel.appendChild(opt);
  }
  updateRunButtons();
  renderSummary();
}

$('profile_select').addEventListener('change', (e) => {
  selectedName = e.target.value;
  renderChart();
  renderSummary();
});

// ---------------------------------------------------------------- socket handlers

const wsStatus = connect('/status', {
  onmessage(e) {
    const x = JSON.parse(e.data);

    if (x.type === 'backlog') {
      if (x.profile && x.profile.name) {
        selectedName = x.profile.name;
        renderSelect();
      }
      liveData = (x.log || []).map((v) => [v.runtime, v.temperature]);
      renderChart();
      return;
    }

    runState = x.state;
    if (lastRunState === 'RUNNING' && runState !== 'RUNNING' && runState !== 'PAUSED') {
      toast('Run complete', 'success', 15000);
    }
    if (runState === 'RUNNING') liveData.push([x.runtime, x.temperature]);
    if (Number.isFinite(x.temperature)) lastTemp = x.temperature;
    if (!editing) {
      updateStatusUI(x);
      renderChart();
      renderSummary();
    }
    lastRunState = runState;
  },
});

const wsConfig = connect('/config', {
  onopen(sock) { queueWhenAllOpen(() => sock.trySend('GET')); },
  onmessage(e) {
    const x = JSON.parse(e.data);
    cfg.temp_scale = x.temp_scale || cfg.temp_scale;
    cfg.time_scale_slope = x.time_scale_slope || cfg.time_scale_slope;
    cfg.time_scale_profile = x.time_scale_profile || cfg.time_scale_profile;
    cfg.kwh_rate = x.kwh_rate;
    cfg.currency_type = x.currency_type || cfg.currency_type;
    cfg.seek_start = Boolean(x.seek_start);
    document.querySelectorAll('[data-tempunit]').forEach((el) => { el.textContent = tempUnit(); });
    renderChart();
    if (editing) renderTable();
    else renderSummary();
  },
});

const wsControl = connect('/control', {
  onmessage(e) {
    // simulation feedback from the server (legacy path)
    const x = JSON.parse(e.data);
    if (Number.isFinite(x.runtime) && Number.isFinite(x.temperature)) {
      liveData.push([x.runtime, x.temperature]);
      renderChart();
    }
  },
});

const wsStorage = connect('/storage', {
  onopen(sock) { queueWhenAllOpen(() => sock.trySend('GET')); },
  onmessage(e) {
    const message = JSON.parse(e.data);

    if (message.resp) {
      if (message.resp === 'FAIL') {
        confirmDialog('Overwrite schedule?', 'A schedule with this name already exists.', 'Overwrite')
          .then((ok) => {
            if (ok) {
              message.force = true;
              wsStorage.send(JSON.stringify(message));
            }
          });
      }
      return;
    }

    // otherwise the message is the full list of profiles
    if (Array.isArray(message)) {
      profiles = message;
      renderSelect();
      if (!editing) renderChart();
    }
  },
});

// retry closed sockets immediately when the tab or network comes back
window.addEventListener('focus', retryAllNow);
window.addEventListener('online', retryAllNow);
window.addEventListener('pageshow', retryAllNow);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') retryAllNow();
});

// ---------------------------------------------------------------- wire up buttons

$('btn_edit').addEventListener('click', () => { if (currentProfile()) enterEdit(false); });
$('btn_new').addEventListener('click', () => enterEdit(true));
$('btn_save').addEventListener('click', saveProfile);
$('btn_cancel').addEventListener('click', exitEdit);
$('btn_delete').addEventListener('click', deleteProfile);
$('btn_add_point').addEventListener('click', () => addPoint());

$('btn_start').addEventListener('click', () => {
  if (fillStartDialog()) $('start_dialog').showModal();
});
$('start_dialog').addEventListener('close', () => {
  if ($('start_dialog').returnValue === 'ok') startRun();
});
$('btn_stop').addEventListener('click', stopRun);
$('btn_pause').addEventListener('click', () => apiCmd('pause'));
$('btn_resume').addEventListener('click', () => apiCmd('resume'));

setBadge('IDLE');
updateRunButtons();
renderChart();

})();
