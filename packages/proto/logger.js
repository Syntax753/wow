const fs = require('fs');
const path = require('path');

// ── Log Level Enum ───────────────────────────────────────────────────
const LogLevel = Object.freeze({
  ERROR: 'error',
  WARN:  'warn',
  INFO:  'info',
  DEBUG: 'debug',
  TRACE: 'trace',
});

const LOG_LEVEL_VALUE = Object.freeze({
  [LogLevel.ERROR]: 0,
  [LogLevel.WARN]:  1,
  [LogLevel.INFO]:  2,
  [LogLevel.DEBUG]: 3,
  [LogLevel.TRACE]: 4,
});

// ── Settings file path ───────────────────────────────────────────────
const SETTINGS_PATH = path.join(__dirname, '../../data/settings.json');

let cachedLevel = null;
let lastRead = 0;
const CACHE_TTL = 5000; // re-read settings every 5s

function readLogLevel() {
  const now = Date.now();
  if (cachedLevel !== null && now - lastRead < CACHE_TTL) return cachedLevel;
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const settings = JSON.parse(raw);
    cachedLevel = LOG_LEVEL_VALUE[settings.logLevel] ?? LOG_LEVEL_VALUE[LogLevel.INFO];
  } catch {
    cachedLevel = LOG_LEVEL_VALUE[LogLevel.INFO];
  }
  lastRead = now;
  return cachedLevel;
}

// ── Logger factory ───────────────────────────────────────────────────
// Creates a logger tagged with a service name.
//
// Levels:
//   info  — high-level status messages (default)
//   debug — request payloads, decisions, non-trivial branches
//   trace — full span trees, per-tile operations, all gRPC sub-spans
//
function createLogger(serviceName) {
  const tag = `[${serviceName}]`;

  return {
    LogLevel,

    error(...args) {
      console.error(tag, ...args);
    },

    warn(...args) {
      if (readLogLevel() >= LOG_LEVEL_VALUE[LogLevel.WARN]) {
        console.warn(tag, ...args);
      }
    },

    info(...args) {
      if (readLogLevel() >= LOG_LEVEL_VALUE[LogLevel.INFO]) {
        console.log(tag, ...args);
      }
    },

    debug(...args) {
      if (readLogLevel() >= LOG_LEVEL_VALUE[LogLevel.DEBUG]) {
        console.log(tag, '[DEBUG]', ...args);
      }
    },

    trace(...args) {
      if (readLogLevel() >= LOG_LEVEL_VALUE[LogLevel.TRACE]) {
        console.log(tag, '[TRACE]', ...args);
      }
    },

    // Log a span tree — only at trace level
    span(span, indent = 0) {
      if (readLogLevel() < LOG_LEVEL_VALUE[LogLevel.TRACE]) return;
      if (!span) return;
      const pad = '  '.repeat(indent);
      const dur = span.timeEnd ? `${span.timeEnd - span.timeStart}ms` : '?ms';
      console.log(`${pad}${tag} [SPAN] ${span.serviceName || '?'} | ${dur} | spanId:${span.spanId || '?'}`);
      if (span.data) {
        try {
          const parsed = JSON.parse(span.data);
          console.log(`${pad}  ← req:`, parsed);
        } catch {
          console.log(`${pad}  ← req:`, span.data);
        }
      }
      if (span.dataRet) {
        try {
          const parsed = JSON.parse(span.dataRet);
          console.log(`${pad}  → res:`, parsed);
        } catch {
          console.log(`${pad}  → res:`, span.dataRet);
        }
      }
      if (span.subSpans) {
        for (const sub of span.subSpans) {
          this.span(sub, indent + 1);
        }
      }
    },

    // Log a request payload — only at debug+ level
    request(method, payload) {
      if (readLogLevel() >= LOG_LEVEL_VALUE[LogLevel.DEBUG]) {
        console.log(tag, '[DEBUG]', `${method}:`, JSON.stringify(payload));
      }
    },
  };
}

module.exports = { createLogger, LogLevel, LOG_LEVEL_VALUE };
