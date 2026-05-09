// main.js — runs as the regular step.
// Starts a background flusher process that periodically sends new log content to Foreman.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const logDir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), '_foreman_logs');
const configPath = path.join(logDir, 'config.json');

if (!fs.existsSync(configPath)) {
  console.log('Log collector main-step: no config (collector disabled in pre).');
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Spawn a detached background flusher process that runs until post-step kills it.
// The flusher script is a tiny Node program that polls log files every 5 seconds.
const flusherPath = path.join(logDir, 'flusher.js');
const flusherSrc = `
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const url = require('url');

const config = ${JSON.stringify(config)};
const sentSizes = new Map();
let seq = 0;

function postJson(targetUrl, headers, body) {
  return new Promise((resolve) => {
    const u = url.parse(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      timeout: 8000,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(-1));
    req.on('timeout', () => { req.destroy(); resolve(-1); });
    req.write(body);
    req.end();
  });
}

async function sendChunk(stepNumber, content) {
  if (!content) return;
  const payload = JSON.stringify({
    job_name: config.jobName,
    step_name: 'step-' + stepNumber,
    step_number: stepNumber,
    content,
    sequence: seq++,
  });

  if (config.callbackUrl && config.callbackToken) {
    await postJson(
      config.callbackUrl.replace(/\\/$/, '') + '/job_logs',
      { 'Authorization': 'Bearer ' + config.callbackToken },
      payload
    );
  } else if (config.pipelineId && config.apiToken) {
    await postJson(
      config.baseUrl.replace(/\\/$/, '') + '/api/pipelines/' + config.pipelineId + '/admin-callback/job_logs',
      { 'Authorization': 'Bearer ' + config.apiToken },
      payload
    );
  }
}

async function flush() {
  if (!fs.existsSync(config.logDir)) return;
  const files = fs.readdirSync(config.logDir)
    .filter(f => f.startsWith('step_') && f.endsWith('.log'))
    .sort();

  for (const f of files) {
    const full = path.join(config.logDir, f);
    let stat;
    try { stat = fs.statSync(full); } catch (e) { continue; }
    const prev = sentSizes.get(f) || 0;
    if (stat.size <= prev) continue;

    let content;
    try {
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(stat.size - prev);
      fs.readSync(fd, buf, 0, buf.length, prev);
      fs.closeSync(fd);
      content = buf.toString('utf-8');
    } catch (e) { continue; }

    if (!content) continue;

    const stepNumber = parseInt(f.replace('step_', '').replace('.log', ''), 10) || 0;
    await sendChunk(stepNumber, content);
    sentSizes.set(f, stat.size);
  }
}

let stopped = false;
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });

(async function main() {
  while (!stopped) {
    try { await flush(); } catch (e) {}
    await new Promise(r => setTimeout(r, 5000));
  }
  // Final flush before exit
  try { await flush(); } catch (e) {}
})();
`;
fs.writeFileSync(flusherPath, flusherSrc);

// Spawn detached so it survives this step
const child = spawn(process.execPath, [flusherPath], {
  detached: true,
  stdio: 'ignore',
});
child.unref();

fs.writeFileSync(path.join(logDir, '.flusher_pid'), String(child.pid));
console.log(`Log collector main-step: flusher started (pid=${child.pid}, flush every 5s)`);
