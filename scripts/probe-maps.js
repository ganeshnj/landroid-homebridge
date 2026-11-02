#!/usr/bin/env node
'use strict';
// One-off probe: logs in to the Worx cloud and prints a REDACTED sample of the
// mower record, maps and zone layers, so we can see the real data shape.
// Nothing is written except the output file; the password is never stored or printed.
//
//   node scripts/probe-maps.js            (prompts for email and password)
//   WORX_EMAIL=.. WORX_PASSWORD=.. node scripts/probe-maps.js
const fs = require('fs');
const readline = require('readline');

const LOGIN = 'https://id.worx.com/';
const API = 'https://api.worxlandroid.com';
const CLIENT_ID = '150da4d2-bb44-433b-9429-3773adc70a2a';
const OUT = 'probe-output.json';

// Keep zone/map names (we need them); hide anything that identifies you or the mower.
const SENSITIVE = /(mac|serial|^sn$|lat|lon|gps|addr|ssid|wifi|token|user_id|email|city|street|postal|zip|phone|uuid|^id$|_id$|ip$|key|pass|secret|cert|topic|endpoint|contours|coordinates|points|geometry)/i;
function redact(v, k = '') {
  if (Array.isArray(v)) {
    if (/contours|coordinates|points|geometry/i.test(k)) return `<${v.length} items>`;
    return v.length > 30 ? [`<${v.length} items>`, redact(v[0], k)] : v.map((x) => redact(x, k));
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, redact(vv, kk)]));
  return SENSITIVE.test(k) && v != null ? '<redacted>' : v;
}

function ask(question, hidden) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
  }
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); }));
}

async function get(path, token) {
  const r = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
  return { status: r.status, body };
}

(async () => {
  const email = process.env.WORX_EMAIL || (await ask('Worx email: ', false));
  const password = process.env.WORX_PASSWORD || (await ask('Worx password: ', true));
  const r = await fetch(`${LOGIN}oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, username: email, password, scope: '*', grant_type: 'password' }),
  });
  if (!r.ok) { console.error(`Login failed: HTTP ${r.status}`); process.exit(1); }
  const { access_token: token } = await r.json();

  const result = {};
  const items = await get('/api/v2/product-items?status=1&gps_status=1', token);
  result.productItems = { status: items.status, body: redact(items.body) };

  // The maps path prefix is unconfirmed, so try a few and record which answer.
  result.mapsAttempts = {};
  let mapsList = null; let prefix = null;
  for (const p of ['/api/v2', '/api/v1', '/api/v3', '']) {
    const res = await get(`${p}/maps`, token);
    result.mapsAttempts[`${p}/maps`] = res.status;
    if (res.status === 200 && !mapsList) { mapsList = res.body; prefix = p; }
  }
  result.mapsPrefix = prefix;
  if (mapsList) {
    result.maps = redact(mapsList);
    const list = Array.isArray(mapsList) ? mapsList : (mapsList.data || mapsList.maps || []);
    result.details = {};
    for (const m of list.slice(0, 3)) {
      if (!m || !m.id) continue;
      const base = `${prefix}/maps/${encodeURIComponent(m.id)}`;
      const entry = {};
      for (const sub of ['', '/layers', '/layers/zone', '/schedule']) {
        const res = await get(base + sub, token);
        entry[sub || '(map)'] = { status: res.status, body: redact(res.body) };
      }
      result.details[m.name || 'map'] = entry;
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`Wrote ${OUT}. Maps path answered: ${JSON.stringify(result.mapsAttempts)}`);
  console.log('Please check the file for anything personal before sharing it.');
})().catch((e) => { console.error(e.message); process.exit(1); });
