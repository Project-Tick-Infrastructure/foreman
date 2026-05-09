// post.js — runs AFTER all user steps (always, even on failure/cancel).
// Stops the background flusher, does a final synchronous flush, cleans up.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const url = require('url');
const os = require('os');

const logDir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), '_foreman_logs');
const configPath = path.join(logDir, 'config.json');

if (!fs.existsSync(configPath)) {
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Kill the background flusher
try {
  const pidStr = fs.readFileSync(path.join(logDir, '.flusher_pid'), 'utf-8').trim();
  const pid = parseInt(pidStr, 10);
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch (e) {}
  }
} catch (e) {}

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
      timeout: 10000,
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

let seq = 1000000;

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
      config.callbackUrl.replace(/\/$/, '') + '/job_logs',
      { 'Authorization': 'Bearer ' + config.callbackToken },
      payload
    );
  } else if (config.pipelineId && config.apiToken) {
    await postJson(
      config.baseUrl.replace(/\/$/, '') + '/api/pipelines/' + config.pipelineId + '/admin-callback/job_logs',
      { 'Authorization': 'Bearer ' + config.apiToken },
      payload
    );
  }
}

(async function main() {
  try {
    const files = fs.readdirSync(logDir)
      .filter(f => f.startsWith('step_') && f.endsWith('.log'))
      .sort();

    for (const f of files) {
      const full = path.join(logDir, f);
      const content = fs.readFileSync(full, 'utf-8');
      if (!content) continue;

      const stepNumber = parseInt(f.replace('step_', '').replace('.log', ''), 10) || 0;
      const CHUNK = 50000;
      for (let i = 0; i < content.length; i += CHUNK) {
        await sendChunk(stepNumber, content.slice(i, i + CHUNK));
      }
    }
  } catch (e) {
    console.log('Final flush error: ' + e.message);
  }

  try {
    fs.rmSync(logDir, { recursive: true, force: true });
  } catch (e) {}

  console.log('Log collector post-step: final flush + cleanup done');
})();
