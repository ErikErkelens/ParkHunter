const spotsBody = document.querySelector("#spotsBody");
const spotRowTemplate = document.querySelector("#spotRowTemplate");
const refreshButton = document.querySelector("#refreshButton");
const railRefreshButton = document.querySelector("#railRefreshButton");
const statusText = document.querySelector("#railStatusText");
const lastUpdated = document.querySelector("#railLastUpdated");
const ageSelect = document.querySelector("#ageSelect");
const modeSelect = document.querySelector("#modeSelect");
const bandSelect = document.querySelector("#bandSelect");
const vfoOffsetHz = document.querySelector("#vfoOffsetHz");
const scanDelaySeconds = document.querySelector("#scanDelaySeconds");
const railScanButton = document.querySelector("#railScanButton");
const scanDialog = document.querySelector("#scanDialog");
const scanStation = document.querySelector("#scanStation");
const scanReference = document.querySelector("#scanReference");
const scanFrequency = document.querySelector("#scanFrequency");
const stopScanButton = document.querySelector("#stopScanButton");
const skipScanButton = document.querySelector("#skipScanButton");
const nextScanButton = document.querySelector("#nextScanButton");
const shortcutsDialog = document.querySelector("#shortcutsDialog");
const logDialog = document.querySelector("#logDialog");
const logForm = logDialog.querySelector("form");
const closeLogDialog = document.querySelector("#closeLogDialog");
const logDialogDetails = document.querySelector("#logDialogDetails");
const confirmLogButton = document.querySelector("#confirmLogButton");
const signalReportInput = document.querySelector("#signalReportInput");
const signalReportButtons = Array.from(document.querySelectorAll(".report-button"));
const spotCommentInput = document.querySelector("#spotCommentInput");
const spotAfterLogCheckbox = document.querySelector("#spotAfterLogCheckbox");
const MAX_SCANNABLE_FREQ_HZ = 54000000;
const DEFAULT_REFRESH_MS = 30000;

let refreshTimer;
let scanTimer;
let nextRefreshDelayMs = DEFAULT_REFRESH_MS;
let currentSpots = [];
let appConfig = {
  cwTxOffsetHz: 90,
  spotAgeSeconds: 1800,
  spotLimit: 500,
  scanDelaySeconds: 3
};
let logState = loadLogState();
let stationState = loadStationState();
let pendingLogSpot;
let scanState = { active: false, currentIndex: -1, currentSpot: undefined };
let selectedSpotKey = "";
let lastDefaultSpotComment = defaultSpotComment("559");

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function loadLogState() {
  try {
    const parsed = JSON.parse(localStorage.getItem("parkhunter.logState.v1") || "{}");
    if (parsed.utcDay === utcDayKey()) {
      return {
        utcDay: parsed.utcDay,
        exact: parsed.exact || {},
        bandsByCall: parsed.bandsByCall || {}
      };
    }
  } catch {
    // Ignore malformed local state and start a fresh UTC day.
  }

  return { utcDay: utcDayKey(), exact: {}, bandsByCall: {} };
}

function saveLogState() {
  localStorage.setItem("parkhunter.logState.v1", JSON.stringify(logState));
}

function refreshUtcLogState() {
  if (logState.utcDay !== utcDayKey()) {
    logState = { utcDay: utcDayKey(), exact: {}, bandsByCall: {} };
    saveLogState();
  }
}

function loadStationState() {
  try {
    const parsed = JSON.parse(localStorage.getItem("parkhunter.stationState.v1") || "{}");
    if (parsed.utcDay === utcDayKey()) {
      return {
        utcDay: parsed.utcDay,
        tunedKey: parsed.tunedKey || "",
        tried: parsed.tried || {}
      };
    }
  } catch {
    // Ignore malformed local state and start a fresh UTC day.
  }

  return { utcDay: utcDayKey(), tunedKey: "", tried: {} };
}

function saveStationState() {
  localStorage.setItem("parkhunter.stationState.v1", JSON.stringify(stationState));
}

function refreshUtcStationState() {
  if (stationState.utcDay !== utcDayKey()) {
    stationState = { utcDay: utcDayKey(), tunedKey: "", tried: {} };
    saveStationState();
  }
}

function formatTime(spot) {
  const timestamp = spot.time_iso || (spot.time ? new Date(spot.time * 1000).toISOString() : "");
  if (!timestamp) {
    return "";
  }

  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC"
  }).format(new Date(timestamp));
}

function formatFrequency(freqHz) {
  const mhz = Number(freqHz) / 1000000;
  return Number.isFinite(mhz) ? `${mhz.toFixed(5)} MHz` : "";
}

function isValidSpotFrequency(freqHz) {
  const numericFreq = Number(freqHz);
  return Number.isFinite(numericFreq) && numericFreq > 0 && numericFreq <= MAX_SCANNABLE_FREQ_HZ;
}

function isPhoneInCwOnlyPortion(spot) {
  return Boolean(spot.phoneInCwOnlyPortion);
}

function effectiveSpotMode(spot) {
  return spot.modeOverride || (isPhoneInCwOnlyPortion(spot) ? "CW" : (spot.mode || spot.mode_type || "CW"));
}

function logCommentForSpot(spot, comment) {
  const cleanComment = String(comment || "").trim();
  if (!isPhoneInCwOnlyPortion(spot) || /^CW\b/i.test(cleanComment)) {
    return cleanComment;
  }

  return ["CW", cleanComment].filter(Boolean).join(" ");
}

function cleanSignalReport(report) {
  const normalized = String(report || "").trim();
  return normalized || "599";
}

function defaultSpotComment(report) {
  return `${cleanSignalReport(report)} WNY`;
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    const config = await response.json();
    if (!response.ok) {
      throw new Error(config.error || `HTTP ${response.status}`);
    }

    appConfig = { ...appConfig, ...config };
  } catch (error) {
    setStatus(`Could not load configuration defaults: ${error.message}`, true);
  }

  vfoOffsetHz.value = String(appConfig.cwTxOffsetHz);
  scanDelaySeconds.value = String(appConfig.scanDelaySeconds);
  if (Array.from(ageSelect.options).some(option => option.value === String(appConfig.spotAgeSeconds))) {
    ageSelect.value = String(appConfig.spotAgeSeconds);
  }
}

function selectSignalReport(report) {
  const cleanReport = cleanSignalReport(report);
  signalReportInput.value = cleanReport;
  signalReportButtons.forEach(button => {
    button.classList.toggle("selected-report", button.dataset.report === cleanReport);
    button.setAttribute("aria-pressed", button.dataset.report === cleanReport ? "true" : "false");
  });

  if (!spotCommentInput.value.trim() || spotCommentInput.value === lastDefaultSpotComment) {
    lastDefaultSpotComment = defaultSpotComment(cleanReport);
    spotCommentInput.value = lastDefaultSpotComment;
  }
}

function cleanVfoOffsetHz() {
  const offset = Number(vfoOffsetHz.value || appConfig.cwTxOffsetHz);
  if (!Number.isInteger(offset) || offset < -5000 || offset > 5000) {
    throw new Error("VFO offset must be a whole number from -5000 to 5000 Hz.");
  }

  return offset;
}

function cleanScanDelayMs() {
  const delaySeconds = Number(scanDelaySeconds.value || appConfig.scanDelaySeconds);
  if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 300) {
    throw new Error("Scan delay must be a whole number from 1 to 300 seconds.");
  }

  return delaySeconds * 1000;
}

function spotTimestamp(spot) {
  if (spot.time_iso) {
    const parsed = Date.parse(spot.time_iso);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (spot.time) {
    const numericTime = Number(spot.time);
    return Number.isFinite(numericTime) ? numericTime * 1000 : 0;
  }

  return 0;
}

function prepareSpots(spots) {
  const latestByCall = new Map();

  for (const spot of spots) {
    const call = normalizeCall(spot.dx_call);
    if (!call) {
      continue;
    }

    const current = latestByCall.get(call);
    if (!current || spotTimestamp(spot) > spotTimestamp(current)) {
      latestByCall.set(call, spot);
    }
  }

  return Array.from(latestByCall.values()).sort((left, right) => {
    const leftFreq = Number(left.freq);
    const rightFreq = Number(right.freq);

    if (Number.isFinite(leftFreq) && Number.isFinite(rightFreq) && leftFreq !== rightFreq) {
      return leftFreq - rightFreq;
    }

    return normalizeCall(left.dx_call).localeCompare(normalizeCall(right.dx_call));
  });
}

function normalizeCall(call) {
  return String(call || "").trim().toUpperCase();
}

function normalizeBand(band) {
  return String(band || "").trim().toUpperCase();
}

function loggedKey(spot) {
  return [normalizeCall(spot.dx_call), Number(spot.freq), normalizeBand(spot.band)].join("|");
}

function isWorkedSpot(spot) {
  const call = normalizeCall(spot.dx_call);
  const band = normalizeBand(spot.band);
  if (!call || !band) {
    return Boolean(logState.exact[loggedKey(spot)]);
  }

  return Boolean(logState.exact[loggedKey(spot)]) || (logState.bandsByCall[call] || []).includes(band);
}

function describeReference(spot) {
  if (!spot.sig_refs || spot.sig_refs.length === 0) {
    return spot.comment || "";
  }

  return spot.sig_refs.map(ref => [ref.id, ref.name].filter(Boolean).join(" - ")).join(", ");
}

function firstTextValue(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function describeStateProvince(spot) {
  return firstTextValue(
    spot.locationDesc,
    spot.location_desc,
    spot.dx_state,
    spot.dx_province,
    spot.dx_subdivision,
    spot.dx_region,
    spot.dx_admin1,
    spot.state,
    spot.province,
    spot.subdivision,
    spot.region,
    spot.admin1,
    spot.location?.state,
    spot.location?.province,
    spot.location?.subdivision,
    spot.location?.region,
    spot.location?.admin1,
    spot.dx_location?.state,
    spot.dx_location?.province,
    spot.dx_location?.subdivision,
    spot.dx_location?.region,
    spot.dx_location?.admin1
  );
}

function renderCallCell(cell, spot) {
  cell.replaceChildren();
  const callText = spot.dx_call || "";

  const call = document.createElement("div");
  call.textContent = callText;
  cell.append(call);

  if (spot.dx_name) {
    const name = document.createElement("div");
    name.className = "activator-name";
    name.textContent = spot.dx_name;
    cell.append(name);
  }
}

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.classList.toggle("error", isError);
}

function updateScanButtons() {
  const label = scanState.active ? "Scanning..." : "Scan";
  railScanButton.textContent = label;
  railScanButton.disabled = scanState.active;
}

function renderEmpty(message) {
  spotsBody.replaceChildren();
  selectedSpotKey = "";
  const row = document.createElement("tr");
  row.className = "empty-row";
  const cell = document.createElement("td");
  cell.colSpan = 9;
  cell.textContent = message;
  row.append(cell);
  spotsBody.append(row);
}

async function tuneCommander(spot) {
  const offsetHz = cleanVfoOffsetHz();
  const response = await fetch("/api/tune", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      freq: spot.freq,
      mode: effectiveSpotMode(spot),
      vfoOffsetHz: offsetHz
    })
  });
  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  stationState.tunedKey = loggedKey(spot);
  saveStationState();
  renderStationState();
  return offsetHz;
}

async function tuneSpot(spot, button) {
  if (button) {
    button.disabled = true;
  }
  setStatus(`Tuning ${spot.dx_call} on ${formatFrequency(spot.freq)}...`);

  try {
    const offsetHz = await tuneCommander(spot);
    setStatus(`Commander tuned to ${spot.dx_call} on ${formatFrequency(spot.freq)} with CW TX ${offsetHz >= 0 ? "+" : ""}${offsetHz} Hz.`);
  } catch (error) {
    setStatus(`Could not tune Commander: ${error.message}`, true);
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

function markSpotLogged(spot) {
  refreshUtcLogState();
  const call = normalizeCall(spot.dx_call);
  const band = normalizeBand(spot.band);

  if (!call || !band) {
    return;
  }

  logState.exact[loggedKey(spot)] = true;
  logState.bandsByCall[call] = Array.from(new Set([...(logState.bandsByCall[call] || []), band])).sort();
  saveLogState();
}

function markSpotTried(spot) {
  refreshUtcStationState();
  stationState.tried[loggedKey(spot)] = true;
  saveStationState();
  renderStationState();
}

async function logSpot(spot) {
  const signalReport = cleanSignalReport(signalReportInput.value);
  const spotComment = logCommentForSpot(spot, spotCommentInput.value.trim() || defaultSpotComment(signalReport));
  setStatus(`Logging ${spot.dx_call} on ${formatFrequency(spot.freq)}...`);

  const response = await fetch("/api/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      spot: {
        ...spot,
        signalReport,
        logComment: spotComment
      }
    })
  });
  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  markSpotLogged(spot);
  renderLoggedState();
  return payload;
}

async function spotStation(spot) {
  const signalReport = cleanSignalReport(signalReportInput.value);
  const spotComment = logCommentForSpot(spot, spotCommentInput.value.trim() || defaultSpotComment(signalReport));
  setStatus(`Spotting ${spot.dx_call}...`);

  try {
    const response = await fetch("/api/spot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        spot: {
          ...spot,
          mode: effectiveSpotMode(spot),
          spotComment
        },
        comment: spotComment
      })
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      if (payload.command) {
        throw new Error(`${payload.error || `HTTP ${response.status}`} Command: ${payload.command}`);
      }
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    if (payload.target === "POTA") {
      setStatus(`Spotted to POTA: ${payload.payload.activator} ${payload.payload.reference} ${payload.payload.frequency} ${payload.payload.mode}`);
    } else {
      setStatus(`Spotted to DXCluster: ${payload.command}`);
    }
    return payload;
  } catch (error) {
    setStatus(`Could not spot: ${error.message}`, true);
    throw error;
  }
}

async function logAndMaybeSpot(spot) {
  const originalText = confirmLogButton.textContent;
  confirmLogButton.disabled = true;
  confirmLogButton.textContent = spotAfterLogCheckbox.checked ? "Logging + Spotting" : "Logging";

  try {
    await logSpot(spot);

    if (spotAfterLogCheckbox.checked) {
      const spotPayload = await spotStation(spot);
      if (spotPayload.target === "POTA") {
        setStatus(`Logged and spotted to POTA: ${spotPayload.payload.activator} ${spotPayload.payload.reference}`);
      } else {
        setStatus(`Logged and spotted to DXCluster: ${spotPayload.command}`);
      }
    } else {
      setStatus(`Logged ${spot.dx_call} in DXKeeper.`);
    }

    logDialog.close();
  } catch (error) {
    setStatus(`Could not complete log action: ${error.message}`, true);
  } finally {
    confirmLogButton.disabled = false;
    confirmLogButton.textContent = originalText;
  }
}

function openLogDialog(spot) {
  pendingLogSpot = spot;
  logDialogDetails.textContent = `${spot.dx_call || "Unknown call"} - ${formatFrequency(spot.freq)} - ${spot.band || "unknown band"} - ${describeReference(spot)}`;
  selectSignalReport("559");
  lastDefaultSpotComment = defaultSpotComment(signalReportInput.value);
  spotCommentInput.value = lastDefaultSpotComment;
  spotAfterLogCheckbox.checked = true;

  if (typeof logDialog.showModal === "function") {
    logDialog.showModal();
    spotCommentInput.focus();
    spotCommentInput.select();
  } else {
    logAndMaybeSpot(spot);
  }
}

function renderWorkedBadges(cell, spot) {
  const call = normalizeCall(spot.dx_call);
  const bands = logState.bandsByCall[call] || [];
  const key = loggedKey(spot);
  cell.replaceChildren();

  const wrap = document.createElement("div");
  wrap.className = "worked-bands";

  for (const band of bands) {
    const badge = document.createElement("span");
    badge.className = "worked-badge";
    badge.textContent = band;
    wrap.append(badge);
  }

  if (stationState.tunedKey === key) {
    const tunedBadge = document.createElement("span");
    tunedBadge.className = "state-badge tuned-badge";
    tunedBadge.textContent = "Tuned";
    wrap.append(tunedBadge);
  }

  if (stationState.tried[key]) {
    const triedBadge = document.createElement("span");
    triedBadge.className = "state-badge tried-badge";
    triedBadge.textContent = "Tried";
    wrap.append(triedBadge);
  }

  if (isPhoneInCwOnlyPortion(spot)) {
    const phoneBadge = document.createElement("span");
    phoneBadge.className = "state-badge phone-badge";
    phoneBadge.textContent = "Phone";
    wrap.append(phoneBadge);
  }

  if (wrap.childElementCount) {
    cell.append(wrap);
  }
}

function renderLoggedState() {
  refreshUtcLogState();
  renderStationState();
}

function renderStationState() {
  refreshUtcLogState();
  refreshUtcStationState();

  for (const row of spotsBody.querySelectorAll("tr[data-logged-key]")) {
    const spot = JSON.parse(row.dataset.spot);
    const key = row.dataset.loggedKey;
    const isTuned = stationState.tunedKey === key;
    const isTried = Boolean(stationState.tried[key]);
    row.classList.toggle("logged-exact", isWorkedSpot(spot));
    row.classList.toggle("tuned-exact", isTuned);
    row.classList.toggle("tried-exact", isTried);
    row.classList.toggle("selected-row", selectedSpotKey === key);
    row.querySelector(".tried-checkbox").checked = isTried;
    renderWorkedBadges(row.querySelector("[data-cell='worked']"), spot);
  }
}

function spotIndexByKey(key) {
  return currentSpots.findIndex(spot => loggedKey(spot) === key);
}

function selectedSpot() {
  return currentSpots[spotIndexByKey(selectedSpotKey)];
}

function scrollSelectedSpotIntoView() {
  if (!selectedSpotKey) {
    return;
  }

  const row = spotsBody.querySelector(`tr[data-logged-key="${CSS.escape(selectedSpotKey)}"]`);
  row?.scrollIntoView({ block: "nearest" });
}

function selectSpotByIndex(index, { scroll = true } = {}) {
  if (!currentSpots.length) {
    selectedSpotKey = "";
    renderStationState();
    return undefined;
  }

  const boundedIndex = Math.max(0, Math.min(index, currentSpots.length - 1));
  const spot = currentSpots[boundedIndex];
  selectedSpotKey = loggedKey(spot);
  renderStationState();

  if (scroll) {
    scrollSelectedSpotIntoView();
  }

  return spot;
}

async function moveSelection(direction) {
  if (!currentSpots.length) {
    return;
  }

  const currentIndex = spotIndexByKey(selectedSpotKey);
  const nextIndex = currentIndex === -1
    ? (direction < 0 ? currentSpots.length - 1 : 0)
    : Math.max(0, Math.min(currentIndex + direction, currentSpots.length - 1));
  const spot = selectSpotByIndex(nextIndex);
  if (spot) {
    await tuneSpot(spot);
  }
}

function openShortcutsDialog() {
  if (typeof shortcutsDialog.showModal === "function") {
    shortcutsDialog.showModal();
  }
}

function isScannableSpot(spot) {
  const key = loggedKey(spot);
  return isValidSpotFrequency(spot.freq) && !isWorkedSpot(spot) && !stationState.tried[key];
}

function tunedSpotIndex() {
  refreshUtcStationState();
  if (!stationState.tunedKey) {
    return -1;
  }

  return currentSpots.findIndex(spot => loggedKey(spot) === stationState.tunedKey);
}

function findNextScannableIndex(startIndex, { includeStart = false } = {}) {
  refreshUtcLogState();
  refreshUtcStationState();

  if (!currentSpots.length) {
    return -1;
  }

  const normalizedStart = startIndex >= 0 ? startIndex : currentSpots.length - 1;

  for (let step = includeStart ? 0 : 1; step <= currentSpots.length; step += 1) {
    const index = (normalizedStart + step) % currentSpots.length;
    if (isScannableSpot(currentSpots[index])) {
      return index;
    }
  }

  return -1;
}

function updateScanDialog(spot) {
  scanStation.textContent = spot.dx_call || "Unknown";
  scanReference.textContent = describeReference(spot) || "No reference";
  scanFrequency.textContent = [formatFrequency(spot.freq), spot.band].filter(Boolean).join(" - ");
}

function clearScanTimer() {
  clearTimeout(scanTimer);
  scanTimer = undefined;
}

function scheduleScanAdvance() {
  clearScanTimer();
  scanTimer = setTimeout(() => {
    advanceScan({ markTried: false });
  }, cleanScanDelayMs());
}

function stopScan(message = "Scan stopped.") {
  clearScanTimer();
  scanState = { active: false, currentIndex: -1, currentSpot: undefined };
  updateScanButtons();
  if (scanDialog.open) {
    scanDialog.close();
  }
  setStatus(message);
}

async function tuneScanSpot(index) {
  const spot = currentSpots[index];
  if (!spot) {
    stopScan("No more unworked, untried spots to scan.");
    return;
  }

  scanState.currentIndex = index;
  scanState.currentSpot = spot;
  selectSpotByIndex(index);
  updateScanDialog(spot);
  setStatus(`Scanning ${spot.dx_call} on ${formatFrequency(spot.freq)}...`);

  try {
    await tuneCommander(spot);
    setStatus(`Scanning ${spot.dx_call} on ${formatFrequency(spot.freq)}.`);
    scheduleScanAdvance();
  } catch (error) {
    clearScanTimer();
    setStatus(`Could not tune scan spot: ${error.message}`, true);
  }
}

async function advanceScan({ markTried = false } = {}) {
  if (!scanState.active) {
    return;
  }

  clearScanTimer();

  if (markTried && scanState.currentSpot) {
    markSpotTried(scanState.currentSpot);
  }

  const nextIndex = findNextScannableIndex(scanState.currentIndex);
  if (nextIndex === -1) {
    stopScan("No more unworked, untried spots to scan.");
    return;
  }

  await tuneScanSpot(nextIndex);
}

async function startScan() {
  try {
    cleanScanDelayMs();
    const tunedIndex = tunedSpotIndex();
    const firstIndex = findNextScannableIndex(tunedIndex);
    if (firstIndex === -1) {
      setStatus("No unworked, untried spots available to scan.", true);
      return;
    }

    scanState = { active: true, currentIndex: -1, currentSpot: undefined };
    updateScanButtons();
    if (typeof scanDialog.showModal === "function") {
      scanDialog.showModal();
    }
    await tuneScanSpot(firstIndex);
  } catch (error) {
    scanState = { active: false, currentIndex: -1, currentSpot: undefined };
    updateScanButtons();
    setStatus(`Could not start scan: ${error.message}`, true);
  }
}

function renderSpots(spots) {
  spotsBody.replaceChildren();

  if (!spots.length) {
    renderEmpty(`No matching ${modeSelect.value === "PHONE" ? "phone" : "CW"} xOTA spots found in this time window.`);
    return;
  }

  for (const spot of spots) {
    const row = spotRowTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.loggedKey = loggedKey(spot);
    row.dataset.spot = JSON.stringify(spot);
    row.querySelector("[data-cell='time']").textContent = formatTime(spot);
    renderCallCell(row.querySelector("[data-cell='call']"), spot);
    row.querySelector("[data-cell='freq']").textContent = formatFrequency(spot.freq);
    row.querySelector("[data-cell='band']").textContent = spot.band || "";
    row.querySelector("[data-cell='region']").textContent = describeStateProvince(spot);
    row.querySelector("[data-cell='ref']").textContent = describeReference(spot);
    row.querySelector("[data-cell='spotter']").textContent = spot.de_call || "";
    row.addEventListener("click", event => {
      if (event.target.closest("button, input, label")) {
        return;
      }

      selectedSpotKey = row.dataset.loggedKey;
      renderStationState();
      tuneSpot(spot);
    });
    row.querySelector(".log-button").addEventListener("click", () => openLogDialog(spot));
    row.querySelector(".tried-checkbox").addEventListener("change", event => {
      refreshUtcStationState();
      stationState.tried[row.dataset.loggedKey] = event.currentTarget.checked;
      if (!event.currentTarget.checked) {
        delete stationState.tried[row.dataset.loggedKey];
      }
      saveStationState();
      renderStationState();
    });
    spotsBody.append(row);
  }

  if (!selectedSpotKey || !spots.some(spot => loggedKey(spot) === selectedSpotKey)) {
    selectedSpotKey = loggedKey(spots[0]);
  }
  renderStationState();
}

async function loadSpots() {
  refreshUtcLogState();
  refreshUtcStationState();
  refreshButton.disabled = true;
  railRefreshButton.disabled = true;
  setStatus("Loading spots...");

  try {
    const params = new URLSearchParams({
      max_age: ageSelect.value,
      mode_type: modeSelect.value,
      limit: String(appConfig.spotLimit || 500)
    });

    if (bandSelect.value) {
      params.set("band", bandSelect.value);
    }

    const response = await fetch(`/api/spots?${params}`);
    const spots = await response.json();

    if (!response.ok) {
      const error = new Error(spots.error || `HTTP ${response.status}`);
      error.retryAfterMs = Number(spots.retryAfterMs);
      throw error;
    }

    const preparedSpots = prepareSpots(spots);
    currentSpots = preparedSpots;
    renderSpots(preparedSpots);
    const modeLabel = modeSelect.value === "PHONE" ? "phone" : "CW";
    setStatus(`${preparedSpots.length} latest ${modeLabel} spot${preparedSpots.length === 1 ? "" : "s"} from POTA, WWFF, and SOTA.`);
    lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    nextRefreshDelayMs = DEFAULT_REFRESH_MS;
  } catch (error) {
    currentSpots = [];
    renderEmpty("Spot loading failed.");
    setStatus(`Could not load spots: ${error.message}`, true);
    nextRefreshDelayMs = Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
      ? error.retryAfterMs
      : DEFAULT_REFRESH_MS;
  } finally {
    refreshButton.disabled = false;
    railRefreshButton.disabled = false;
  }
}

function scheduleRefresh(delayMs = DEFAULT_REFRESH_MS) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    loadSpots().finally(() => {
      scheduleRefresh(nextRefreshDelayMs);
    });
  }, Math.max(DEFAULT_REFRESH_MS, Number(delayMs) || DEFAULT_REFRESH_MS));
}

function isTypingTarget(target) {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || target?.isContentEditable;
}

function hasOpenDialog() {
  return logDialog.open || scanDialog.open || shortcutsDialog.open;
}

function handleKeydown(event) {
  if (logDialog.open) {
    const reportButton = signalReportButtons.find(button => button.dataset.hotkey === event.key);
    if (reportButton) {
      event.preventDefault();
      selectSignalReport(reportButton.dataset.report);
      return;
    }

    if (event.key === "Enter" && pendingLogSpot && !confirmLogButton.disabled) {
      event.preventDefault();
      logAndMaybeSpot(pendingLogSpot);
      return;
    }
  }

  if (event.defaultPrevented || isTypingTarget(event.target)) {
    return;
  }

  if (event.key === "?") {
    event.preventDefault();
    openShortcutsDialog();
    return;
  }

  if (shortcutsDialog.open || logDialog.open) {
    return;
  }

  if (scanDialog.open) {
    if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      advanceScan({ markTried: true });
    } else if (event.key === " ") {
      event.preventDefault();
      advanceScan({ markTried: false });
    }
    return;
  }

  if (hasOpenDialog()) {
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveSelection(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveSelection(-1);
  } else if (event.key.toLowerCase() === "l") {
    event.preventDefault();
    const spot = selectedSpot();
    if (spot) {
      openLogDialog(spot);
    }
  } else if (event.key.toLowerCase() === "s") {
    event.preventDefault();
    startScan();
  }
}

refreshButton.addEventListener("click", loadSpots);
railRefreshButton.addEventListener("click", loadSpots);
ageSelect.addEventListener("change", loadSpots);
modeSelect.addEventListener("change", loadSpots);
bandSelect.addEventListener("change", loadSpots);
railScanButton.addEventListener("click", startScan);
stopScanButton.addEventListener("click", () => stopScan());
skipScanButton.addEventListener("click", () => {
  advanceScan({ markTried: true });
});
nextScanButton.addEventListener("click", () => {
  advanceScan({ markTried: false });
});
confirmLogButton.addEventListener("click", () => {
  if (pendingLogSpot) {
    logAndMaybeSpot(pendingLogSpot);
  }
});
signalReportButtons.forEach(button => {
  button.addEventListener("click", () => {
    selectSignalReport(button.dataset.report);
  });
});
logForm.addEventListener("submit", event => {
  event.preventDefault();
  if (pendingLogSpot && !confirmLogButton.disabled) {
    logAndMaybeSpot(pendingLogSpot);
  }
});
closeLogDialog.addEventListener("click", () => {
  logDialog.close();
});
spotCommentInput.addEventListener("input", () => {
  if (!spotCommentInput.value.trim()) {
    lastDefaultSpotComment = defaultSpotComment(signalReportInput.value);
  }
});
logDialog.addEventListener("close", () => {
  pendingLogSpot = undefined;
});
scanDialog.addEventListener("close", () => {
  if (scanState.active) {
    stopScan();
  }
});
document.addEventListener("keydown", handleKeydown);

await loadConfig();
loadSpots();
scheduleRefresh();
