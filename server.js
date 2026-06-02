import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

function loadLocalEnv() {
  try {
    const envFile = readFileSync(path.join(__dirname, ".env.local"), "utf8");
    for (const line of envFile.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }

      const separator = trimmed.indexOf("=");
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // Local credentials are optional.
  }
}

loadLocalEnv();

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const SPOTHOLE_BASE_URL = process.env.SPOTHOLE_BASE_URL || "https://spothole.app";
const SPOTHOLE_REFRESH_MS = Number(process.env.SPOTHOLE_REFRESH_MS || 30000);
const SPOTHOLE_RATE_LIMIT_BACKOFF_MS = Number(process.env.SPOTHOLE_RATE_LIMIT_BACKOFF_MS || 10 * 60 * 1000);
const SPOTHOLE_ERROR_BACKOFF_MS = Number(process.env.SPOTHOLE_ERROR_BACKOFF_MS || 2 * 60 * 1000);
const DEFAULT_SPOT_LIMIT = Number(process.env.SPOT_LIMIT || 500);
const MAX_SPOT_LIMIT = 1000;
const DEFAULT_SPOT_AGE_SECONDS = Number(process.env.SPOT_AGE_SECONDS || process.env.DEFAULT_SPOT_AGE_SECONDS || 1800);
const DEFAULT_SCAN_DELAY_SECONDS = Number(process.env.SCAN_DELAY_SECONDS || process.env.DEFAULT_SCAN_DELAY_SECONDS || 3);
const DEFAULT_COMMANDER_HOST = process.env.COMMANDER_HOST || "127.0.0.1";
const DEFAULT_COMMANDER_PORT = Number(process.env.COMMANDER_PORT || 52002);
const DEFAULT_DXKEEPER_HOST = process.env.DXKEEPER_HOST || "127.0.0.1";
const DEFAULT_DXKEEPER_PORT = Number(process.env.DXKEEPER_PORT || 52001);
const CW_TX_OFFSET_HZ = Number(process.env.CW_TX_OFFSET_HZ || 90);
const MIN_VFO_OFFSET_HZ = -5000;
const MAX_VFO_OFFSET_HZ = 5000;
const QRZ_USERNAME = process.env.QRZ_USERNAME || "";
const QRZ_PASSWORD = process.env.QRZ_PASSWORD || "";
const QRZ_BASE_URL = process.env.QRZ_BASE_URL || "https://xmldata.qrz.com/xml/current/";
const DXCLUSTER_HOST = process.env.DXCLUSTER_HOST || "dx.cqspot.com";
const DXCLUSTER_PORT = Number(process.env.DXCLUSTER_PORT || 1234);
const DXCLUSTER_USERNAME = process.env.DXCLUSTER_USERNAME || QRZ_USERNAME || "";
const DXCLUSTER_COMMAND_DELAY_MS = Number(process.env.DXCLUSTER_COMMAND_DELAY_MS || 1800);
const POTA_SPOT_URL = process.env.POTA_SPOT_URL || "https://api.pota.app/spot";
const POTA_ACTIVATOR_SPOTS_URL = process.env.POTA_ACTIVATOR_SPOTS_URL || "https://api.pota.app/spot/activator";
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, ".cache");
const POTA_REFERENCE_CACHE_PATH = process.env.POTA_REFERENCE_CACHE_PATH || path.join(CACHE_DIR, "pota-references.json");
const POTA_REFERENCE_CACHE_TTL_MS = Number(process.env.POTA_REFERENCE_CACHE_TTL_MS || 10 * 60 * 1000);
let potaBearerToken = process.env.POTA_BEARER_TOKEN || "";
const POTA_REFRESH_TOKEN = process.env.POTA_REFRESH_TOKEN || "";
const POTA_COGNITO_CLIENT_ID = process.env.POTA_COGNITO_CLIENT_ID || "7hluqct0n2nckib7i7sd5753oa";
const POTA_COGNITO_REGION = process.env.POTA_COGNITO_REGION || "us-east-2";
const POTA_SPOTTER_CALLSIGN = process.env.POTA_SPOTTER_CALLSIGN || QRZ_USERNAME || DXCLUSTER_USERNAME || "";
const CONFIGURED_POTA_SPOT_SOURCE = String(process.env.POTA_SPOT_SOURCE || "ParkHunter").trim();
const POTA_SPOT_SOURCE = /^ParkHunter\s+-\s+/i.test(CONFIGURED_POTA_SPOT_SOURCE)
  ? "ParkHunter"
  : CONFIGURED_POTA_SPOT_SOURCE;
const POTA_SPOT_TARGET = String(process.env.POTA_SPOT_TARGET || "pota").trim().toLowerCase();

let qrzSessionKey = "";
let potaReferenceCacheLoaded = false;
let potaReferenceCacheUpdatedAt = 0;
let potaReferenceCache = new Map();
let potaReferenceCacheRefreshPromise;
let spotholeBackoffUntil = 0;
let spotholeBackoffReason = "";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

export function adifField(name, value) {
  const stringValue = String(value);
  return `<${name}:${stringValue.length}>${stringValue}`;
}

export function hzToCommanderKhz(freqHz) {
  const numericFreq = Number(freqHz);
  if (!Number.isFinite(numericFreq) || numericFreq <= 0) {
    throw new Error("A valid spot frequency is required.");
  }

  return (numericFreq / 1000).toFixed(3).replace(/\.?0+$/, "");
}

export function hzToMhz(freqHz) {
  const numericFreq = Number(freqHz);
  if (!Number.isFinite(numericFreq) || numericFreq <= 0) {
    throw new Error("A valid spot frequency is required.");
  }

  return (numericFreq / 1000000).toFixed(5).replace(/\.?0+$/, "");
}

export function addHzOffset(freqHz, offsetHz) {
  const numericFreq = Number(freqHz);
  const numericOffset = Number(offsetHz);
  if (!Number.isFinite(numericFreq) || !Number.isFinite(numericOffset)) {
    throw new Error("A valid frequency and offset are required.");
  }

  return numericFreq + numericOffset;
}

export function normalizeCommanderMode(mode, freqHz) {
  const candidate = String(mode || "").trim().toUpperCase();
  const supportedModes = new Set([
    "AM",
    "CW",
    "CW-R",
    "DATA-L",
    "DATA-U",
    "FM",
    "LSB",
    "USB",
    "RTTY",
    "RTTY-R",
    "WBFM"
  ]);

  if (supportedModes.has(candidate)) {
    return candidate;
  }

  if (candidate === "PHONE" || candidate === "SSB") {
    return Number(freqHz) < 10000000 ? "LSB" : "USB";
  }

  return "CW";
}

export function buildSetFreqModeCommand({ freqHz, mode }) {
  const commanderFreq = hzToCommanderKhz(freqHz);
  const commanderMode = normalizeCommanderMode(mode, freqHz);
  const parameters = [
    adifField("xcvrfreq", commanderFreq),
    adifField("xcvrmode", commanderMode),
    adifField("preservesplitanddual", "N")
  ].join("");

  return `${adifField("command", "CmdSetFreqMode")}${adifField("parameters", parameters)}`;
}

export function buildQsxSplitCommand({ txFreqHz }) {
  const commanderFreq = hzToCommanderKhz(txFreqHz);
  const parameters = [
    adifField("xcvrfreq", commanderFreq),
    adifField("SuppressDual", "Y"),
    adifField("SuppressModeChange", "N")
  ].join("");

  return `${adifField("command", "CmdQSXSplit")}${adifField("parameters", parameters)}`;
}

export function isCwCommanderMode(mode) {
  return mode === "CW" || mode === "CW-R";
}

export function isPhoneInCwOnlyPortion(freqHz) {
  const freq = Number(freqHz);
  if (!Number.isFinite(freq) || freq <= 0) {
    return false;
  }

  return [
    [1800000, 1840000],
    [3500000, 3600000],
    [7000000, 7125000],
    [10100000, 10150000],
    [14000000, 14150000],
    [18068000, 18110000],
    [21000000, 21200000],
    [24890000, 24930000],
    [28000000, 28300000],
    [50000000, 50100000],
    [144000000, 144100000]
  ].some(([lower, upper]) => freq >= lower && freq <= upper);
}

function effectiveSpotMode(spot) {
  if (spot?.phoneInCwOnlyPortion) {
    return "CW";
  }

  return spot?.modeOverride || spot?.mode || spot?.mode_type;
}

export function buildTuneCommands({ freqHz, mode, cwTxOffsetHz = CW_TX_OFFSET_HZ }) {
  const commanderMode = normalizeCommanderMode(mode, freqHz);
  const commands = [buildSetFreqModeCommand({ freqHz, mode: commanderMode })];

  if (isCwCommanderMode(commanderMode)) {
    commands.push(buildQsxSplitCommand({ txFreqHz: addHzOffset(freqHz, cwTxOffsetHz) }));
  }

  return commands;
}

export function normalizeVfoOffsetHz(offsetHz = CW_TX_OFFSET_HZ) {
  const numericOffset = Number(offsetHz);
  if (!Number.isInteger(numericOffset) || numericOffset < MIN_VFO_OFFSET_HZ || numericOffset > MAX_VFO_OFFSET_HZ) {
    throw new Error(`VFO offset must be a whole number from ${MIN_VFO_OFFSET_HZ} to ${MAX_VFO_OFFSET_HZ} Hz.`);
  }

  return numericOffset;
}

function xmlText(xml, tagName) {
  const match = String(xml).match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i"));
  return match ? match[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
}

function decodeXmlText(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function decodeJwtPayload(token) {
  const payload = String(token || "").split(".")[1];
  if (!payload) {
    return {};
  }

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function tokenExpiresSoon(token, windowSeconds = 300) {
  const payload = decodeJwtPayload(token);
  return !payload.exp || payload.exp <= Math.floor(Date.now() / 1000) + windowSeconds;
}

async function refreshPotaBearerToken() {
  if (!POTA_REFRESH_TOKEN) {
    return potaBearerToken;
  }

  const cognitoUrl = `https://cognito-idp.${POTA_COGNITO_REGION}.amazonaws.com/`;
  let response;
  try {
    response = await fetch(cognitoUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth"
      },
      body: JSON.stringify({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: POTA_COGNITO_CLIENT_ID,
        AuthParameters: {
          REFRESH_TOKEN: POTA_REFRESH_TOKEN
        }
      })
    });
  } catch (error) {
    logApiNetworkError({ apiName: "POTA Cognito", url: cognitoUrl, error });
    throw error;
  }

  const body = await readApiBody(response);

  if (!response.ok || !body.AuthenticationResult?.AccessToken) {
    logApiHttpError({ apiName: "POTA Cognito", response, url: cognitoUrl, body });
    throw new Error(body.message || body.__type || `Cognito returned HTTP ${response.status}.`);
  }

  potaBearerToken = body.AuthenticationResult.AccessToken;
  return potaBearerToken;
}

async function getPotaBearerToken() {
  if (!potaBearerToken || tokenExpiresSoon(potaBearerToken)) {
    return refreshPotaBearerToken();
  }

  return potaBearerToken;
}

export function isQrtSpot(spot) {
  const text = [spot.comment, spot.notes, spot.status]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();

  return /\bQRT\b/.test(text);
}

async function getQrzSessionKey() {
  if (qrzSessionKey) {
    return qrzSessionKey;
  }

  if (!QRZ_USERNAME || !QRZ_PASSWORD) {
    return "";
  }

  const loginUrl = new URL(QRZ_BASE_URL);
  loginUrl.searchParams.set("username", QRZ_USERNAME);
  loginUrl.searchParams.set("password", QRZ_PASSWORD);

  let response;
  try {
    response = await fetch(loginUrl);
  } catch (error) {
    logApiNetworkError({ apiName: "QRZ", url: loginUrl, error });
    throw error;
  }

  const xml = await response.text();
  const error = decodeXmlText(xmlText(xml, "Error"));

  if (!response.ok || error) {
    logApiHttpError({ apiName: "QRZ", response, url: loginUrl, body: xml });
    throw new Error(error || `QRZ login returned HTTP ${response.status}.`);
  }

  qrzSessionKey = xmlText(xml, "Key");
  return qrzSessionKey;
}

function utcLogParts(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");

  return {
    qsoDate: `${year}${month}${day}`,
    timeOn: `${hour}${minute}${second}`
  };
}

function normalizeAdifValue(value) {
  return String(value ?? "").trim();
}

function normalizeSignalReport(value) {
  return normalizeAdifValue(value) || "599";
}

function firstSigRef(spot, sig) {
  return (spot.sig_refs || []).find(ref => String(ref?.sig || spot.sig || "").toUpperCase() === sig)
    || (String(spot.sig || "").toUpperCase() === sig ? spot.sig_refs?.[0] : undefined);
}

function spotReference(spot, sig) {
  return normalizeAdifValue(firstSigRef(spot, sig)?.id);
}

function activeSig(spot) {
  return normalizeAdifValue(spot.sig || spot.source).toUpperCase();
}

export function isPotaSpot(spot) {
  return Boolean(spotReference(spot, "POTA") || activeSig(spot) === "POTA");
}

export function buildPotaSpotPayload({ spot, comment, spotter, timestamp = new Date() }) {
  const activator = normalizeAdifValue(spot.dx_call).toUpperCase();
  const reference = spotReference(spot, "POTA") || normalizeAdifValue(spot.reference);
  const normalizedSpotter = normalizeAdifValue(spotter || POTA_SPOTTER_CALLSIGN).toUpperCase();
  const frequency = hzToMhz(spot.freq);
  const mode = normalizeCommanderMode(effectiveSpotMode(spot), spot.freq);
  const comments = normalizeAdifValue(comment || spot.spotComment || spot.logComment || spot.comment);

  if (!activator) {
    throw new Error("A POTA activator callsign is required.");
  }

  if (!reference) {
    throw new Error("A POTA reference is required.");
  }

  if (!normalizedSpotter) {
    throw new Error("A POTA spotter callsign is required.");
  }

  return {
    activator,
    frequency,
    mode,
    reference,
    comments,
    spotter: normalizedSpotter,
    source: POTA_SPOT_SOURCE,
    timestamp: timestamp.toISOString()
  };
}

export function buildDxClusterSpotNotes({ spot, comment }) {
  const mode = normalizeCommanderMode(effectiveSpotMode(spot), spot.freq);
  const cleanComment = normalizeAdifValue(comment || spot.spotComment || spot.logComment || spot.comment);
  const potaRef = spotReference(spot, "POTA");
  const sotaRef = spotReference(spot, "SOTA");
  const wwffRef = spotReference(spot, "WWFF");
  const sig = activeSig(spot);

  if (potaRef || sig === "POTA") {
    return ["_POTA_", potaRef, mode, cleanComment].filter(Boolean).join(" ");
  }

  if (sotaRef || sig === "SOTA") {
    return ["SOTA", sotaRef, mode, cleanComment].filter(Boolean).join(" ");
  }

  if (wwffRef || sig === "WWFF") {
    return ["WWFF", wwffRef, mode, cleanComment].filter(Boolean).join(" ");
  }

  return [mode, cleanComment].filter(Boolean).join(" ");
}

export function buildDxClusterSpotCommand({ spot, comment }) {
  const frequencyKhz = hzToCommanderKhz(spot.freq);
  const call = normalizeAdifValue(spot.dx_call).toUpperCase();
  const notes = buildDxClusterSpotNotes({ spot, comment });

  if (!call) {
    throw new Error("A callsign is required to spot to DXCluster.");
  }

  return ["DX", frequencyKhz, call, notes].filter(Boolean).join(" ");
}

export function buildDxKeeperLogCommand({ spot, loggedAt = new Date() }) {
  const { qsoDate, timeOn } = utcLogParts(loggedAt);
  const mode = normalizeCommanderMode(effectiveSpotMode(spot), spot.freq);
  const sig = normalizeAdifValue(spot.sig || spot.source).toUpperCase();
  const reference = normalizeAdifValue(spot.sig_refs?.[0]?.id || spot.reference || "");
  const potaRef = firstSigRef(spot, "POTA")?.id || (sig === "POTA" ? reference : "");
  const sotaRef = firstSigRef(spot, "SOTA")?.id || (sig === "SOTA" ? reference : "");
  const wwffRef = firstSigRef(spot, "WWFF")?.id || (sig === "WWFF" ? reference : "");
  const signalReport = normalizeSignalReport(spot.signalReport || spot.report);
  const logComment = normalizeAdifValue(spot.logComment || spot.comment).slice(0, 1024);
  const fields = [
    ["CALL", normalizeAdifValue(spot.dx_call)],
    ["RST_SENT", signalReport],
    ["RST_RCVD", signalReport],
    ["FREQ", hzToMhz(spot.freq)],
    ["BAND", normalizeAdifValue(spot.band).toUpperCase()],
    ["MODE", mode],
    ["QSO_DATE", qsoDate],
    ["TIME_ON", timeOn]
  ];

  if (sig) {
    fields.push(["SIG", sig]);
  }

  if (reference) {
    fields.push(["SIG_INFO", reference]);
  }

  if (potaRef) {
    fields.push(["POTA_REF", potaRef]);
  }

  if (sotaRef) {
    fields.push(["SOTA_REF", sotaRef]);
  }

  if (wwffRef) {
    fields.push(["WWFF_REF", wwffRef]);
  }

  if (logComment) {
    fields.push(["COMMENT", logComment]);
  }

  const adifRecord = `${fields
    .filter(([, value]) => value)
    .map(([name, value]) => adifField(name, value))
    .join("")}<EOR>`;

  return `${adifField("command", "log")}${adifField("parameters", adifRecord)}`;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function redactedApiUrl(input) {
  const url = new URL(String(input));
  for (const key of url.searchParams.keys()) {
    if (/password|token|key|session/i.test(key)) {
      url.searchParams.set(key, "[redacted]");
    }
  }
  return url.toString();
}

function formatApiBodyDetail(body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (!text) {
    return "";
  }

  return text.length > 1200 ? `${text.slice(0, 1200)}...` : text;
}

function parseApiBodyText(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return text;
  }
}

async function readApiBody(response) {
  return parseApiBodyText(await response.text());
}

function logApiHttpError({ apiName, response, url, body, retryAfterMs }) {
  const details = [
    `[${new Date().toISOString()}] ${apiName} API returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
    `URL: ${redactedApiUrl(url)}`
  ];
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    details.push(`Retry-After: ${retryAfter}`);
  }
  if (retryAfterMs !== undefined) {
    details.push(`Backoff: ${Math.ceil(retryAfterMs / 1000)} seconds`);
  }

  const bodyDetail = formatApiBodyDetail(body);
  if (bodyDetail) {
    details.push(`Response body: ${bodyDetail}`);
  }

  console.error(details.join("\n"));
}

function logApiNetworkError({ apiName, url, error, retryAfterMs }) {
  const details = [
    `[${new Date().toISOString()}] ${apiName} API network error: ${error.message || error}.`,
    `URL: ${redactedApiUrl(url)}`
  ];
  if (retryAfterMs !== undefined) {
    details.push(`Backoff: ${Math.ceil(retryAfterMs / 1000)} seconds`);
  }

  console.error(details.join("\n"));
}

function parseRetryAfterMs(value) {
  const retryAfter = String(value || "").trim();
  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryAt = Date.parse(retryAfter);
  if (Number.isFinite(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }

  return undefined;
}

function spotholeBackoffMsForResponse(response) {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }

  if (response.status === 429) {
    return SPOTHOLE_RATE_LIMIT_BACKOFF_MS;
  }

  return SPOTHOLE_ERROR_BACKOFF_MS;
}

function setSpotholeBackoff({ status, retryAfterMs }) {
  const boundedRetryAfterMs = Math.max(SPOTHOLE_REFRESH_MS, Number(retryAfterMs || SPOTHOLE_ERROR_BACKOFF_MS));
  spotholeBackoffUntil = Date.now() + boundedRetryAfterMs;
  spotholeBackoffReason = `Spothole returned HTTP ${status}.`;
  return boundedRetryAfterMs;
}

function getRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendTcpCommand({ host, port, command, appName }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${appName} at ${host}:${port}.`));
    }, 3500);

    socket.on("connect", () => {
      socket.end(command);
    });

    socket.on("error", error => {
      clearTimeout(timeout);
      reject(error);
    });

    socket.on("close", hadError => {
      clearTimeout(timeout);
      if (!hadError) {
        resolve();
      }
    });
  });
}

function sendDxClusterCommand({ host, port, username, command }) {
  return new Promise((resolve, reject) => {
    let output = "";
    let usernameSent = false;
    let commandSent = false;
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to DXCluster at ${host}:${port}.`));
    }, 12000);

    function writeLine(line) {
      socket.write(`${line}\r\n`);
    }

    function sendUsername() {
      if (username && !usernameSent) {
        usernameSent = true;
        writeLine(username);
      }
    }

    function sendCommand() {
      if (!commandSent) {
        commandSent = true;
        writeLine(command);
        setTimeout(() => socket.end("bye\r\n"), 900);
      }
    }

    socket.on("connect", () => {
      if (username) {
        setTimeout(sendUsername, 300);
      }
      setTimeout(sendCommand, DXCLUSTER_COMMAND_DELAY_MS);
    });

    socket.on("data", chunk => {
      output += chunk.toString("utf8");
      if (/call|login|callsign|enter/i.test(output)) {
        sendUsername();
      }
      if (/[>\r\n]$/.test(output) && (!username || usernameSent)) {
        sendCommand();
      }
    });

    socket.on("error", error => {
      clearTimeout(timeout);
      reject(error);
    });

    socket.on("close", hadError => {
      clearTimeout(timeout);
      if (!hadError) {
        resolve(output);
      }
    });
  });
}

async function sendPotaSpot({ token, payload }) {
  let response;
  try {
    response = await fetch(POTA_SPOT_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "ParkHunter/0.1"
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    logApiNetworkError({ apiName: "POTA spot", url: POTA_SPOT_URL, error });
    throw error;
  }

  const body = await readApiBody(response);

  if (!response.ok) {
    logApiHttpError({ apiName: "POTA spot", response, url: POTA_SPOT_URL, body });
    throw new Error(`POTA returned HTTP ${response.status}: ${formatApiBodyDetail(body)}`);
  }

  return body;
}

function potaReferenceFromSpot(spot) {
  const reference = normalizeAdifValue(spot.reference).toUpperCase();
  if (!reference) {
    return undefined;
  }

  return [
    reference,
    {
      reference,
      name: normalizeAdifValue(spot.name || spot.parkName),
      locationDesc: normalizeAdifValue(spot.locationDesc),
      grid: normalizeAdifValue(spot.grid6 || spot.grid4),
      latitude: Number.isFinite(Number(spot.latitude)) ? Number(spot.latitude) : undefined,
      longitude: Number.isFinite(Number(spot.longitude)) ? Number(spot.longitude) : undefined,
      updatedAt: new Date().toISOString()
    }
  ];
}

async function loadPotaReferenceCache() {
  if (potaReferenceCacheLoaded) {
    return;
  }

  potaReferenceCacheLoaded = true;

  try {
    const cacheFile = JSON.parse(await readFile(POTA_REFERENCE_CACHE_PATH, "utf8"));
    potaReferenceCacheUpdatedAt = Number(cacheFile.updatedAt || 0);
    potaReferenceCache = new Map(Object.entries(cacheFile.references || {}));
  } catch {
    potaReferenceCacheUpdatedAt = 0;
    potaReferenceCache = new Map();
  }
}

async function savePotaReferenceCache() {
  await mkdir(path.dirname(POTA_REFERENCE_CACHE_PATH), { recursive: true });
  await writeFile(POTA_REFERENCE_CACHE_PATH, JSON.stringify({
    updatedAt: potaReferenceCacheUpdatedAt,
    references: Object.fromEntries(potaReferenceCache)
  }, null, 2));
}

async function refreshPotaReferenceCache() {
  await loadPotaReferenceCache();

  let response;
  try {
    response = await fetch(POTA_ACTIVATOR_SPOTS_URL, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "ParkHunter/0.1"
      }
    });
  } catch (error) {
    logApiNetworkError({ apiName: "POTA activator spots", url: POTA_ACTIVATOR_SPOTS_URL, error });
    throw error;
  }

  if (!response.ok) {
    logApiHttpError({
      apiName: "POTA activator spots",
      response,
      url: POTA_ACTIVATOR_SPOTS_URL,
      body: await readApiBody(response)
    });
    return;
  }

  const potaSpots = await response.json();
  let updated = false;

  for (const entry of potaSpots.map(potaReferenceFromSpot).filter(Boolean)) {
    const [reference, details] = entry;
    const existing = potaReferenceCache.get(reference) || {};
    potaReferenceCache.set(reference, { ...existing, ...details });
    updated = true;
  }

  if (updated) {
    potaReferenceCacheUpdatedAt = Date.now();
    await savePotaReferenceCache();
  }
}

async function ensurePotaReferenceCache() {
  await loadPotaReferenceCache();

  if (Date.now() - potaReferenceCacheUpdatedAt <= POTA_REFERENCE_CACHE_TTL_MS) {
    return;
  }

  if (!potaReferenceCacheRefreshPromise) {
    potaReferenceCacheRefreshPromise = refreshPotaReferenceCache()
      .catch(() => {})
      .finally(() => {
        potaReferenceCacheRefreshPromise = undefined;
      });
  }
}

function mergePotaReferenceDetails(spot, referenceDetails) {
  const sigRefs = (spot.sig_refs || []).map(ref => {
    if (String(ref?.sig || spot.sig || "").toUpperCase() !== "POTA") {
      return ref;
    }

    const details = referenceDetails.get(String(ref.id || "").toUpperCase());
    return details ? { ...details, ...ref, locationDesc: ref.locationDesc || details.locationDesc } : ref;
  });
  const firstPotaReference = sigRefs.find(ref => String(ref?.sig || spot.sig || "").toUpperCase() === "POTA");
  const locationDesc = spot.locationDesc || firstPotaReference?.locationDesc;

  return {
    ...spot,
    sig_refs: sigRefs,
    ...(locationDesc ? { locationDesc } : {})
  };
}

async function enrichPotaReferenceDetails(spots) {
  const needsPotaDetails = spots.some(spot => (
    spot.sig === "POTA"
    && spot.sig_refs?.some(ref => ref?.id)
  ));

  if (!needsPotaDetails) {
    return spots;
  }

  await ensurePotaReferenceCache();

  if (potaReferenceCache.size === 0 && potaReferenceCacheRefreshPromise) {
    try {
      await potaReferenceCacheRefreshPromise;
    } catch {
      // Reference enrichment is optional; spots should still load if it fails.
    }
  }

  return spots.map(spot => mergePotaReferenceDetails(spot, potaReferenceCache));
}

async function handleSpots(request, response) {
  const spotholeRetryAfterMs = spotholeBackoffUntil - Date.now();
  if (spotholeRetryAfterMs > 0) {
    sendJson(response, 503, {
      ok: false,
      error: `${spotholeBackoffReason} Pausing Spothole requests for ${Math.ceil(spotholeRetryAfterMs / 1000)} more seconds.`,
      retryAfterMs: spotholeRetryAfterMs
    });
    return;
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const requestedLimit = Number(requestUrl.searchParams.get("limit") || DEFAULT_SPOT_LIMIT);
  const spotLimit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_SPOT_LIMIT)
    : DEFAULT_SPOT_LIMIT;
  const requestedModeType = String(requestUrl.searchParams.get("mode_type") || "CW").trim().toUpperCase();
  const modeTypes = requestedModeType === "PHONE" ? ["PHONE"] : ["CW", "PHONE"];
  const upstreamUrls = modeTypes.map(modeType => {
    const upstreamUrl = new URL("/api/v1/spots", SPOTHOLE_BASE_URL);
    upstreamUrl.searchParams.set("sig", requestUrl.searchParams.get("sig") || "POTA,SOTA,WWFF");
    upstreamUrl.searchParams.set("mode_type", modeType);
    upstreamUrl.searchParams.set("limit", String(spotLimit));
    upstreamUrl.searchParams.set("max_age", requestUrl.searchParams.get("max_age") || String(DEFAULT_SPOT_AGE_SECONDS));
    return upstreamUrl;
  });

  const band = requestUrl.searchParams.get("band");
  if (band) {
    upstreamUrls.forEach(upstreamUrl => upstreamUrl.searchParams.set("band", band));
  }

  try {
    const qrzSessionKey = await getQrzSessionKey();
    if (qrzSessionKey) {
      upstreamUrls.forEach(upstreamUrl => upstreamUrl.searchParams.set("qrz_session_key", qrzSessionKey));
    }
  } catch {
    // Callsign enrichment is optional; spots should still load if QRZ is unavailable.
  }

  const spotsById = new Map();
  for (const upstreamUrl of upstreamUrls) {
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "ParkHunter/0.1"
        }
      });
    } catch (error) {
      const retryAfterMs = setSpotholeBackoff({
        status: "network error",
        retryAfterMs: SPOTHOLE_ERROR_BACKOFF_MS
      });
      logApiNetworkError({ apiName: "Spothole", url: upstreamUrl, error, retryAfterMs });
      sendJson(response, 503, {
        ok: false,
        error: `Could not reach Spothole: ${error.message}. Pausing requests for ${Math.ceil(retryAfterMs / 1000)} seconds.`,
        retryAfterMs
      });
      return;
    }

    if (!upstreamResponse.ok) {
      const retryAfterMs = setSpotholeBackoff({
        status: upstreamResponse.status,
        retryAfterMs: spotholeBackoffMsForResponse(upstreamResponse)
      });
      logApiHttpError({
        apiName: "Spothole",
        response: upstreamResponse,
        url: upstreamUrl,
        body: await readApiBody(upstreamResponse),
        retryAfterMs
      });
      sendJson(response, upstreamResponse.status === 429 ? 429 : 503, {
        ok: false,
        error: `Spothole returned HTTP ${upstreamResponse.status}. Pausing requests for ${Math.ceil(retryAfterMs / 1000)} seconds.`,
        retryAfterMs
      });
      return;
    }

    for (const spot of await upstreamResponse.json()) {
      const modeType = String(spot.mode_type || "").toUpperCase();
      if (requestedModeType !== "PHONE" && modeType === "PHONE") {
        if (!isPhoneInCwOnlyPortion(spot.freq)) {
          continue;
        }

        spotsById.set(spot.id || `${spot.dx_call}|${spot.freq}|${spot.time_iso}`, {
          ...spot,
          phoneInCwOnlyPortion: true,
          modeOverride: "CW"
        });
        continue;
      }

      spotsById.set(spot.id || `${spot.dx_call}|${spot.freq}|${spot.time_iso}`, spot);
    }
  }

  const spots = Array.from(spotsById.values());
  const visibleSpots = spots.filter(spot => !isQrtSpot(spot));
  sendJson(response, 200, await enrichPotaReferenceDetails(visibleSpots));
}

function handleConfig(response) {
  sendJson(response, 200, {
    cwTxOffsetHz: normalizeVfoOffsetHz(CW_TX_OFFSET_HZ),
    spotAgeSeconds: DEFAULT_SPOT_AGE_SECONDS,
    spotLimit: Math.min(Math.max(Math.trunc(DEFAULT_SPOT_LIMIT), 1), MAX_SPOT_LIMIT),
    scanDelaySeconds: DEFAULT_SCAN_DELAY_SECONDS,
    potaSpotTarget: POTA_SPOT_TARGET === "dxcluster" ? "dxcluster" : "pota"
  });
}

async function handleTune(request, response) {
  const rawBody = await getRequestBody(request);
  const body = rawBody ? JSON.parse(rawBody) : {};
  const cwTxOffsetHz = normalizeVfoOffsetHz(body.vfoOffsetHz ?? body.cwTxOffsetHz ?? CW_TX_OFFSET_HZ);
  const commands = buildTuneCommands({ freqHz: body.freq, mode: effectiveSpotMode(body), cwTxOffsetHz });
  const host = DEFAULT_COMMANDER_HOST;
  const port = DEFAULT_COMMANDER_PORT;

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    sendJson(response, 400, { ok: false, error: "Commander port must be between 1 and 65535." });
    return;
  }

  for (const command of commands) {
    await sendTcpCommand({ host, port, command, appName: "Commander" });
  }

  sendJson(response, 200, { ok: true, commands });
}

async function handleLog(request, response) {
  const rawBody = await getRequestBody(request);
  const body = rawBody ? JSON.parse(rawBody) : {};
  const host = DEFAULT_DXKEEPER_HOST;
  const port = DEFAULT_DXKEEPER_PORT;
  const command = buildDxKeeperLogCommand({ spot: body.spot || body });

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    sendJson(response, 400, { ok: false, error: "DXKeeper port must be between 1 and 65535." });
    return;
  }

  await sendTcpCommand({ host, port, command, appName: "DXKeeper" });
  sendJson(response, 200, { ok: true, command });
}

async function handleClusterSpot(request, response) {
  const rawBody = await getRequestBody(request);
  const body = rawBody ? JSON.parse(rawBody) : {};
  const spot = body.spot || body;

  if (isPotaSpot(spot) && POTA_SPOT_TARGET !== "dxcluster") {
    const payload = buildPotaSpotPayload({
      spot,
      comment: body.comment,
      spotter: body.spotter
    });

    let potaToken = "";
    try {
      potaToken = await getPotaBearerToken();
    } catch (error) {
      sendJson(response, 401, {
        ok: false,
        needsPotaToken: true,
        error: `Could not refresh POTA bearer token: ${error.message}`,
        payload
      });
      return;
    }

    if (!potaToken) {
      sendJson(response, 401, {
        ok: false,
        needsPotaToken: true,
        error: "POTA bearer token is not configured.",
        payload
      });
      return;
    }

    const result = await sendPotaSpot({ token: potaToken, payload });
    sendJson(response, 200, { ok: true, target: "POTA", payload, result });
    return;
  }

  const command = buildDxClusterSpotCommand({
    spot,
    comment: body.comment
  });
  const host = String(body.dxClusterHost || DXCLUSTER_HOST);
  const port = Number(body.dxClusterPort || DXCLUSTER_PORT);
  const username = String(body.dxClusterUsername || DXCLUSTER_USERNAME);

  if (!host) {
    sendJson(response, 400, {
      ok: false,
      error: "DXCluster host is not configured.",
      command
    });
    return;
  }

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    sendJson(response, 400, { ok: false, error: "DXCluster port must be between 1 and 65535.", command });
    return;
  }

  const output = await sendDxClusterCommand({ host, port, username, command });
  sendJson(response, 200, { ok: true, command, output });
}

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const safePath = path
    .normalize(decodeURIComponent(requestedPath))
    .replace(/^([/\\])+/, "")
    .replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream"
    });
    response.end(file);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

export async function routeRequest(request, response) {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "GET" && requestUrl.pathname === "/api/spots") {
      await handleSpots(request, response);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/config") {
      handleConfig(response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/tune") {
      await handleTune(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/log") {
      await handleLog(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/spot") {
      await handleClusterSpot(request, response);
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(request, response);
      return;
    }

    sendJson(response, 405, { ok: false, error: "Method not allowed." });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ParkHunter local server error: ${error.stack || error.message || error}`);
    sendJson(response, 500, { ok: false, error: error.message || "Unexpected server error." });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  http.createServer(routeRequest).listen(PORT, HOST, () => {
    console.log(`ParkHunter listening at http://${HOST}:${PORT}`);
  });
}
