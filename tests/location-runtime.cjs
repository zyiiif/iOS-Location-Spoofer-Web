const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

for (const filename of ['location-spoofer.js', 'public/location-spoofer.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
  const exportsContext = { module: { exports: {} } };
  vm.runInNewContext(source, exportsContext);
  const api = exportsContext.module.exports;
  const location = api.concatBytes([
    api.makeVarintField(1, api.coordToInt(1)),
    api.makeVarintField(2, api.coordToInt(2)),
    api.makeVarintField(3, 100),
  ]);
  const wifi = api.makeLengthDelimitedField(2, location);
  const payload = api.makeLengthDelimitedField(2, wifi);
  const input = api.buildAppleWLocResponse(payload);
  const expected = api.spoofAppleResponse(input, api.normalizeConfig({ latitude: 31.2, longitude: 121.5 })).response;
  let completed;
  let requestedUrl;
  vm.runInNewContext(source, {
    $argument: 'mode=response&configUrl=https://example.pages.dev/loc.json?token=fixture-token&latitude=1&longitude=2&debug=true',
    $response: { status: 200, body: Array.from(input), headers: { 'Content-Type': 'application/octet-stream' } },
    $httpClient: {
      get(request, callback) {
        requestedUrl = request.url;
        callback(null, { status: 200 }, JSON.stringify({ latitude: 31.2, longitude: 121.5 }));
      },
    },
    $done(value) { completed = value; },
    console: { log() {} },
  });
  assert.equal(requestedUrl, 'https://example.pages.dev/loc.json?token=fixture-token');
  assert.ok(completed && completed.body, `${filename}: http-response must return a top-level body`);
  assert.equal(completed.response, undefined, `${filename}: nested response is for synthetic request responses`);
  assert.deepEqual(Array.from(completed.body), Array.from(expected), `${filename}: cloud coordinates must reach the returned binary response`);
  assert.equal(completed.headers['X-Location-Spoofer-Wifi'], '1');
  const logs = [];
  vm.runInNewContext(source, {
    $argument: 'configUrl=https://example.pages.dev/loc.json?token=fixture-token&debug=true',
    $response: { body: Array.from(input), headers: {} },
    $httpClient: { get(request, callback) { callback(null, { status: 401 }, '{"error":"unauthorized"}'); } },
    $done(value) { completed = value; },
    console: { log(message) { logs.push(message); } },
  });
  assert.ok(logs.some(message => message.includes('Remote config failed: HTTP 401')), `${filename}: auth failure must be diagnosable`);
  assert.ok(logs.every(message => !message.includes('fixture-token')), `${filename}: diagnostics must not expose the token`);
  console.log(`PASS ${filename}: remote coordinates reach the http-response callback`);
}

async function checkStorageBindings() {
  const base = path.join(__dirname, '..', 'functions');
  const setEndpoint = await import(pathToFileURL(path.join(base, 'set.js')).href);
  const locEndpoint = await import(pathToFileURL(path.join(base, 'loc.json.js')).href);
  const token = 'fixture-token';
  const postRequest = () => new Request(`https://example.pages.dev/set?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ latitude: 31.2, longitude: 121.5 }),
  });
  const missingStorage = { TOKEN: token };
  const saveMissing = await setEndpoint.onRequestPost({ request: postRequest(), env: missingStorage });
  assert.equal(saveMissing.status, 503, 'a missing KV binding must not report that coordinates were saved');
  const getRequest = () => new Request(`https://example.pages.dev/loc.json?token=${token}`);
  const readMissing = await locEndpoint.onRequestGet({ request: getRequest(), env: missingStorage });
  assert.equal(readMissing.status, 503, 'a missing KV binding must not return default coordinates as stored data');
  const store = new Map();
  const env = { TOKEN: token, SPOOFER_DATA: {
    async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
    async put(key, value) { store.set(key, value); },
  } };
  const saved = await setEndpoint.onRequestPost({ request: postRequest(), env });
  assert.equal(saved.status, 200);
  const loaded = await locEndpoint.onRequestGet({ request: getRequest(), env });
  assert.deepEqual(await loaded.json(), await saved.json(), 'saved coordinates must be read back through the script endpoint');
  console.log('PASS KV: missing binding fails explicitly; successful saves can be read back');
}

checkStorageBindings().catch(error => { console.error(error); process.exitCode = 1; });
