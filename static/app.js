import QrScanner from '/vendor/qr-scanner.min.js';

const POLL_MS = 5000;       // how often the list refreshes while the tab is visible
const COOLDOWN_MS = 4000;   // a code must be out of view this long before it counts again
const PENDING_KEY = 'scan-inbox.pending';

const $ = (id) => document.getElementById(id);
const els = {
  scanner: $('scanner'), viewfinder: $('viewfinder'), video: $('video'), idle: $('idle'),
  toggle: $('toggle'), status: $('status'),
  banner: $('banner'), bannerText: $('banner-text'), bannerReload: $('banner-reload'),
  list: $('list'), empty: $('empty'), pager: $('pager'), newer: $('newer'), older: $('older'),
  range: $('range'), unseen: $('unseen'),
  insertOpen: $('insert-open'), insert: $('insert'), insertText: $('insert-text'),
  insertSave: $('insert-save'), insertCancel: $('insert-cancel'),
  detail: $('detail'), detailText: $('detail-text'), detailCopy: $('detail-copy'), detailClose: $('detail-close'),
};

/* ---------- API ------------------------------------------------------- */

class SessionError extends Error {}

// redirect:'manual' + X-Requested-With: an expired Authelia session shows up as a
// 401 (or an opaque redirect) instead of silently following the login page.
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    redirect: 'manual',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) {
    throw new SessionError('session expired');
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

/* ---------- Scans that could not be sent yet -------------------------- */

const loadPending = () => {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || []; } catch { return []; }
};
const savePending = (items) => {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(items)); } catch { /* storage unavailable */ }
};

let flushing = false;
async function flushPending() {
  if (flushing) return;
  flushing = true;
  try {
    const queue = loadPending();
    while (queue.length) {
      try {
        await api('/api/scans', { method: 'POST', body: JSON.stringify(queue[0]) });
      } catch (e) {
        // A scan the server permanently rejects must not block the ones behind it.
        if (e.status !== 400 && e.status !== 413) throw e;
      }
      queue.shift();
      savePending(queue);
    }
  } finally {
    flushing = false;
  }
}

/* ---------- Banner / status ------------------------------------------- */

function showBanner(kind) {
  if (!kind) { els.banner.hidden = true; return; }
  const pending = loadPending().length;
  const kept = pending ? ` ${pending} unsent scan${pending === 1 ? ' is' : 's are'} kept on this device.` : '';
  els.bannerText.textContent = kind === 'auth'
    ? `Your session expired. Reload to sign in again.${kept}`
    : `Can't reach the server.${kept} It will retry automatically.`;
  els.bannerReload.hidden = kind !== 'auth';
  els.banner.hidden = false;
}
els.bannerReload.addEventListener('click', () => location.reload());

let statusTimer;
function setStatus(message) {
  els.status.textContent = message;
  clearTimeout(statusTimer);
  if (message) statusTimer = setTimeout(() => { els.status.textContent = ''; }, 3000);
}

function handleError(error) {
  showBanner(error instanceof SessionError ? 'auth' : 'offline');
}

/* ---------- List + paging --------------------------------------------- */

const desktop = window.matchMedia('(pointer: fine)');
const MOBILE_PER_PAGE = 10;
const ROW_REM = 2.75; // desktop row height; keep in sync with --row-h in style.css

let latest = [];        // newest data from the server
let view = [];          // what the pager is paging through (newest first)
let page = 0;
let unseen = 0;         // scans that arrived while browsing an older page
let loaded = false;
let knownIds = new Set();
let lastSig = '';

function perPage() {
  if (!desktop.matches) return MOBILE_PER_PAGE;
  const rowPx = ROW_REM * parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Math.max(1, Math.floor(els.list.clientHeight / rowPx));
}

function whenLabel(ts) {
  const date = new Date(ts * 1000);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = date.toDateString() === new Date().toDateString()
    ? 'today'
    : date.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return [time, day];
}

function asHttpUrl(text) {
  if (/\s/.test(text.trim())) return null;
  try {
    const url = new URL(text.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = label; }, 1200);
  } catch {
    setStatus('Copy failed. Select the text manually.');
  }
}

function openDetail(text) {
  els.detailText.textContent = text;
  els.detail.showModal();
}
els.detailCopy.addEventListener('click', () => copyText(els.detailText.textContent, els.detailCopy));
els.detailClose.addEventListener('click', () => els.detail.close());
els.detail.addEventListener('click', (e) => { if (e.target === els.detail) els.detail.close(); });

function scanRow(scan, isNew) {
  const li = document.createElement('li');
  li.className = 'scan' + (isNew ? ' new' : '');

  const when = document.createElement('div');
  when.className = 'when';
  const [time, day] = whenLabel(scan.ts);
  when.append(time, document.createElement('br'), ' ', day);

  const body = document.createElement('div');
  body.className = 'body';
  const payload = document.createElement('p');
  payload.className = 'payload';
  const href = asHttpUrl(scan.text);
  if (href) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = scan.text;
    payload.append(a);
  } else {
    payload.textContent = scan.text;
  }
  payload.title = scan.text;
  payload.addEventListener('click', (e) => {
    if (desktop.matches && !e.target.closest('a')) openDetail(scan.text);
  });

  const actions = document.createElement('div');
  actions.className = 'actions';

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => copyText(scan.text, copy));

  const del = document.createElement('button');
  del.type = 'button';
  del.textContent = 'Delete';
  del.addEventListener('click', async () => {
    if (!del.dataset.armed) {
      del.dataset.armed = '1';
      del.textContent = 'Confirm delete';
      setTimeout(() => { delete del.dataset.armed; del.textContent = 'Delete'; }, 3000);
      return;
    }
    try {
      await api(`/api/scans/${scan.id}`, { method: 'DELETE' });
      refresh(true);
    } catch (error) {
      handleError(error);
    }
  });

  actions.append(copy, del);
  body.append(payload, actions);
  li.append(when, body);
  return li;
}

function render() {
  const size = perPage();
  const pages = Math.max(1, Math.ceil(view.length / size));
  page = Math.min(page, pages - 1);
  const slice = view.slice(page * size, page * size + size);

  const fragment = document.createDocumentFragment();
  for (const scan of slice) fragment.append(scanRow(scan, loaded && !knownIds.has(scan.id)));
  els.list.replaceChildren(fragment);

  els.empty.hidden = !loaded || view.length > 0;
  els.pager.hidden = view.length <= size && !unseen;
  els.range.textContent = view.length ? `${page * size + 1}–${page * size + slice.length} of ${view.length}` : '';
  els.newer.disabled = page === 0;
  els.older.disabled = page >= pages - 1;
  els.unseen.hidden = !unseen;
  els.unseen.textContent = `${unseen} new`;
}

// While browsing an older page the view stays put; new scans are announced instead of shifting rows.
function applyData(scans, force) {
  latest = scans;
  if (page === 0 || force) {
    view = scans;
    unseen = 0;
  } else {
    const have = new Set(view.map((s) => s.id));
    unseen = scans.filter((s) => !have.has(s.id)).length;
    if (!unseen) view = scans;
  }
  render();
  loaded = true;
  knownIds = new Set(view.map((s) => s.id));
}

function goTo(target) {
  page = target;
  if (page === 0) applyData(latest, true); else render();
}
els.newer.addEventListener('click', () => goTo(page - 1));
els.older.addEventListener('click', () => goTo(page + 1));
els.unseen.addEventListener('click', () => goTo(0));

document.addEventListener('keydown', (e) => {
  if (!desktop.matches || document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowLeft' && !els.newer.disabled) els.newer.click();
  if (e.key === 'ArrowRight' && !els.older.disabled) els.older.click();
});

// Re-fit the page size when the window is resized or zoomed.
let lastSize = 0;
new ResizeObserver(() => {
  const size = perPage();
  if (size !== lastSize) { lastSize = size; render(); }
}).observe(els.list);
desktop.addEventListener('change', render);

async function refresh(force = false) {
  try {
    await flushPending();
    const head = await api('/api/scans/latest');
    const signature = `${head.id}:${head.count}`;
    if (force || signature !== lastSig) {
      const { scans } = await api('/api/scans');
      lastSig = signature;
      applyData(scans, force);
    }
    showBanner(null);
  } catch (error) {
    handleError(error);
  }
}

let pollTimer;
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (document.visibilityState === 'visible') await refresh();
    schedulePoll();
  }, POLL_MS);
}

/* ---------- Scanning -------------------------------------------------- */

let scanner = null;
let scanning = false;
let lastText = '';
let lastSeen = 0;

async function save(text) {
  const ts = Math.floor(Date.now() / 1000);
  try {
    await api('/api/scans', { method: 'POST', body: JSON.stringify({ text, ts }) });
    setStatus('Saved');
  } catch (error) {
    savePending([...loadPending(), { text, ts }]);
    setStatus('Not sent yet');
    handleError(error);
    return;
  }
  refresh();
}

function onDecode(result) {
  const text = result.data;
  if (!text) return;
  const now = Date.now();
  const repeat = text === lastText && now - lastSeen < COOLDOWN_MS;
  lastText = text;
  lastSeen = now; // keeps extending while the same code stays in view
  if (repeat) return;

  els.viewfinder.classList.add('hit');
  setTimeout(() => els.viewfinder.classList.remove('hit'), 500);
  if (navigator.vibrate) navigator.vibrate(60);
  save(text);
}

function cameraMessage(error) {
  const name = error && error.name;
  if (name === 'NotAllowedError') return 'Camera blocked. Allow it in the browser’s site settings.';
  if (name === 'NotFoundError') return 'No camera found.';
  if (name === 'NotReadableError') return 'Camera is in use by another app.';
  return String((error && error.message) || error || 'Could not start the camera.');
}

function setScanning(on) {
  scanning = on;
  els.viewfinder.classList.toggle('on', on);
  els.toggle.textContent = on ? 'Stop camera' : 'Start camera';
}

// Native BarcodeDetector reads Data Matrix (qr-scanner cannot). Use it whenever the browser offers it.
const WANTED_FORMATS = ['qr_code', 'data_matrix', 'aztec', 'pdf417', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'itf'];
let detector = null;
let stream = null;
let loopId = 0;
let engineReady = false;

async function initEngine() {
  if (engineReady) return;
  engineReady = true;
  try {
    if ('BarcodeDetector' in window) {
      const supported = await BarcodeDetector.getSupportedFormats();
      if (supported.includes('data_matrix')) {
        detector = new BarcodeDetector({ formats: WANTED_FORMATS.filter((f) => supported.includes(f)) });
      }
    }
  } catch { detector = null; }
}

async function startNative(deviceId) {
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
  try { await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* not supported */ }
  els.video.srcObject = stream;
  await els.video.play();
  const run = ++loopId;
  const tick = async () => {
    if (run !== loopId) return;
    try {
      if (els.video.readyState >= 2) {
        const codes = await detector.detect(els.video);
        if (codes.length) onDecode({ data: codes[0].rawValue });
      }
    } catch (e) { setStatus(String((e && e.message) || e)); }
    setTimeout(tick, 120);
  };
  tick();
}

function stopNative() {
  loopId++;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  els.video.srcObject = null;
}

async function startCamera() {
  els.toggle.disabled = true;
  try {
    await initEngine();
    if (detector) {
      await startNative();
    } else {
      if (!scanner) {
        scanner = new QrScanner(els.video, onDecode, {
          preferredCamera: 'environment',
          returnDetailedScanResult: true,
          highlightScanRegion: false,
          highlightCodeOutline: true,
          maxScansPerSecond: 10,
        });
      }
      await scanner.start();
      setStatus('This browser can only read QR codes, not Data Matrix.');
    }
    setScanning(true);
  } catch (error) {
    stopNative();
    setStatus(cameraMessage(error));
  } finally {
    els.toggle.disabled = false;
  }
}

function stopCamera() {
  if (scanner) scanner.stop();
  stopNative();
  setScanning(false);
}

els.toggle.addEventListener('click', () => (scanning ? stopCamera() : startCamera()));

// Release the camera when the tab is hidden (battery, privacy indicator).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && scanning) stopCamera();
  if (document.visibilityState === 'visible') refresh();
});

async function setupScanner() {
  // The camera is for phones/tablets only; on a mouse-driven desktop the section stays hidden.
  if (!window.matchMedia('(pointer: coarse)').matches) {
    els.scanner.hidden = true;
    return;
  }
  if (!window.isSecureContext) {
    els.scanner.hidden = true;
    return;
  }
  let hasCamera = false;
  try { hasCamera = await QrScanner.hasCamera(); } catch { /* treat as no camera */ }
  els.scanner.hidden = !hasCamera;
}

/* ---------- Insert text manually --------------------------------------- */

els.insertOpen.addEventListener('click', () => {
  els.insertText.value = '';
  els.insert.showModal();
  els.insertText.focus();
});
els.insertCancel.addEventListener('click', () => els.insert.close());

async function saveInserted() {
  const text = els.insertText.value.trim();
  if (!text) { els.insertText.focus(); return; }
  els.insertSave.disabled = true;
  await save(text); // on failure it is queued on this device and the banner explains
  els.insertSave.disabled = false;
  els.insert.close();
}
els.insertSave.addEventListener('click', saveInserted);
els.insertText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveInserted(); }
});

/* ---------- Boot ------------------------------------------------------ */

setupScanner();
refresh();
schedulePoll();
