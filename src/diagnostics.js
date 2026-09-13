'use strict';

/**
 * Background diagnostics.
 *
 * Runs for as long as the app runs and writes one JSON object per line to
 * %APPDATA%/TFT Helper/logs/diagnostics.log. The point is to settle one
 * question: when the machine loses internet while this app is open, what
 * failed first, and was this app doing anything unusual at the time?
 *
 * Every sample records:
 *
 *   dns    a real DNS query, sent by c-ares straight to the configured
 *          servers - it deliberately bypasses the Windows DNS cache, so a
 *          failure here means the resolver path is genuinely down
 *   tcp    a raw TCP connect to 1.1.1.1:443, which uses no DNS at all
 *
 * Those two together are the whole diagnosis: tcp OK + dns dead is a
 * resolver/DNS-path problem, both dead is routing or NAT, and if neither ever
 * fails while the network is visibly broken then the problem is somewhere the
 * app cannot see.
 *
 * Alongside them it counts what the app itself is doing - requests, distinct
 * hostnames, per-error-code failures and open sockets - because the leading
 * theory for the outage is connection/DNS churn from several always-loaded
 * sites exhausting the router's NAT table.
 *
 * Writes are appendFileSync: small, infrequent, and already on disk when the
 * machine is force-restarted, which a buffered stream would not be.
 */

const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const os = require('os');
const { execFile } = require('child_process');
const { app, session } = require('electron');
const adblock = require('./adblock');

const SAMPLE_MS = 30_000;         // one heartbeat line every 30s
const PROBE_TIMEOUT_MS = 4000;
const SOCKETS_EVERY = 5;          // count sockets every 5th sample (~2.5 min)
const MAX_BYTES = 5 * 1024 * 1024;

const DNS_PROBE_NAME = 'www.google.com';
const TCP_PROBE = { host: '1.1.1.1', port: 443 };

let dir = null;
let logPath = null;
let detailPath = null;
let timer = null;
let ticks = 0;
let inFailure = false;            // so one outage does not spam detail dumps

// Counters, reset after every sample.
let requests = 0;
let hostSet = new Set();
let errorCounts = Object.create(null);

/* ------------------------------------------------------------------ output */

function rotateIfBig() {
  try {
    if (fs.statSync(logPath).size < MAX_BYTES) return;
    fs.renameSync(logPath, logPath + '.1');   // keep exactly one old file
  } catch { /* no log yet, or rename lost a race - not worth failing over */ }
}

function write(obj) {
  if (!logPath) return;
  try {
    rotateIfBig();
    fs.appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), ...obj }) + os.EOL);
  } catch { /* diagnostics must never take the app down */ }
}

/** Called from main.js for things worth correlating against the probes. */
function logEvent(event, data) {
  write({ event, ...data });
}

/* ------------------------------------------------------------------ probes */

function probeDns() {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    const timeout = setTimeout(() => done({ ok: false, err: 'TIMEOUT', ms: PROBE_TIMEOUT_MS }), PROBE_TIMEOUT_MS);
    dns.resolve4(DNS_PROBE_NAME, (err, addrs) => {
      clearTimeout(timeout);
      if (err) done({ ok: false, err: err.code || String(err), ms: Date.now() - started });
      else done({ ok: true, ms: Date.now() - started, n: addrs.length });
    });
  });
}

function probeTcp() {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => done({ ok: true, ms: Date.now() - started }));
    socket.once('timeout', () => done({ ok: false, err: 'TIMEOUT', ms: PROBE_TIMEOUT_MS }));
    socket.once('error', (e) => done({ ok: false, err: e.code || String(e), ms: Date.now() - started }));
    socket.connect(TCP_PROBE.port, TCP_PROBE.host);
  });
}

/** Local IPv4 addresses, so an adapter dropping out is visible in the log. */
function localAddresses() {
  const out = {};
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.family === 'IPv4' && !addr.internal) out[name] = addr.address;
    }
  }
  return out;
}

/**
 * Socket counts from netstat. `ours` is the number owned by this app's own
 * processes - that is the number that matters for the NAT-exhaustion theory,
 * since it is the load we are responsible for.
 */
function countSockets() {
  return new Promise((resolve) => {
    const ourPids = new Set(app.getAppMetrics().map((m) => m.pid));
    execFile('netstat', ['-ano', '-p', 'TCP'], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ err: err.code || 'netstat-failed' });
      let total = 0, ours = 0, timeWait = 0;
      for (const raw of stdout.split('\n')) {
        const cols = raw.trim().split(/\s+/);
        if (cols.length < 5 || cols[0] !== 'TCP') continue;
        total++;
        if (cols[3] === 'TIME_WAIT') timeWait++;
        if (ourPids.has(Number(cols[4]))) ours++;
      }
      resolve({ total, ours, timeWait });
    });
  });
}

/**
 * On the first failed sample, dump the full picture next to the log. Once per
 * outage - a broken network stays broken for many samples and we do not want
 * a hundred copies.
 */
function dumpDetail(reason) {
  const commands = [
    ['ipconfig', ['/all']],
    ['netstat', ['-ano']],
    ['route', ['print', '-4']],
    ['nslookup', [DNS_PROBE_NAME]],
  ];
  let out = `=== ${new Date().toISOString()} :: ${reason} ===${os.EOL}`;
  let pending = commands.length;

  for (const [cmd, args] of commands) {
    execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      out += `${os.EOL}--- ${cmd} ${args.join(' ')} ---${os.EOL}`;
      out += (stdout || '') + (stderr || '') + (err ? `[error: ${err.message}]` : '');
      if (--pending === 0) {
        try { fs.appendFileSync(detailPath, out + os.EOL); } catch { /* ignore */ }
      }
    });
  }
}

/* ------------------------------------------------------------------ sample */

async function sample() {
  ticks++;
  const [dnsResult, tcpResult] = await Promise.all([probeDns(), probeTcp()]);
  const failed = !dnsResult.ok || !tcpResult.ok;

  const row = {
    up: Math.round(process.uptime()),
    dns: dnsResult,
    tcp: tcpResult,
    req: requests,                       // requests since the last sample
    hosts: hostSet.size,                 // distinct hostnames since the last sample
    procs: app.getAppMetrics().length,
    ip: localAddresses(),
  };
  if (Object.keys(errorCounts).length) row.netErrors = { ...errorCounts };
  const blocked = adblock.drainBlocked();
  if (blocked) row.adsBlocked = blocked;

  // Sockets are a child process, so only occasionally - but always when
  // something just failed, because that is the sample we will actually read.
  if (failed || ticks % SOCKETS_EVERY === 0) row.sockets = await countSockets();

  if (failed && !inFailure) {
    inFailure = true;
    row.detail = 'dumped';
    dumpDetail(`dns=${dnsResult.err || 'ok'} tcp=${tcpResult.err || 'ok'}`);
  } else if (!failed && inFailure) {
    inFailure = false;
    row.recovered = true;
  }

  write(row);

  requests = 0;
  hostSet = new Set();
  errorCounts = Object.create(null);
}

/* ------------------------------------------------------- request counting */

const counted = new WeakSet();

/**
 * Every site runs in its own partition, so its own session. Hooking
 * 'session-created' catches all of them, including ones created later when a
 * site is first opened.
 */
function attachTo(ses) {
  if (!ses || counted.has(ses)) return;
  counted.add(ses);
  const filter = { urls: ['<all_urls>'] };

  ses.webRequest.onCompleted(filter, (details) => {
    requests++;
    try { hostSet.add(new URL(details.url).hostname); } catch { /* data: / blob: */ }
  });

  ses.webRequest.onErrorOccurred(filter, (details) => {
    requests++;
    const code = details.error || 'unknown';
    errorCounts[code] = (errorCounts[code] || 0) + 1;
  });
}

/* ------------------------------------------------------------------- setup */

function start() {
  dir = path.join(app.getPath('userData'), 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* already there */ }
  logPath = path.join(dir, 'diagnostics.log');
  detailPath = path.join(dir, 'diagnostics-detail.log');

  app.on('session-created', attachTo);
  attachTo(session.defaultSession);

  logEvent('start', {
    version: app.getVersion(),
    electron: process.versions.electron,
    os: `${os.type()} ${os.release()}`,
    sampleMs: SAMPLE_MS,
  });

  sample();                                  // one immediately, so a short run still logs
  timer = setInterval(sample, SAMPLE_MS);
  if (timer.unref) timer.unref();            // never hold the app open on our account
}

function stop(reason) {
  clearInterval(timer);
  timer = null;
  logEvent('stop', { reason });
}

const logDir = () => dir;

module.exports = { start, stop, logEvent, logDir };
