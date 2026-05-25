import test from "node:test";
import assert from "node:assert/strict";
import {
  addHzOffset,
  adifField,
  buildDxClusterSpotCommand,
  buildDxClusterSpotNotes,
  buildDxKeeperLogCommand,
  buildPotaSpotPayload,
  buildQsxSplitCommand,
  buildSetFreqModeCommand,
  buildTuneCommands,
  hzToMhz,
  hzToCommanderKhz,
  isPotaSpot,
  isQrtSpot,
  normalizeCommanderMode,
  normalizeVfoOffsetHz
} from "../server.js";

test("builds ADIF fields with the correct value length", () => {
  assert.equal(adifField("command", "CmdSetFreqMode"), "<command:14>CmdSetFreqMode");
});

test("converts Spothole Hz frequencies to Commander kHz strings", () => {
  assert.equal(hzToCommanderKhz(7150500), "7150.5");
  assert.equal(hzToCommanderKhz(14060000), "14060");
});

test("converts Spothole Hz frequencies to DXKeeper MHz strings", () => {
  assert.equal(hzToMhz(7150500), "7.1505");
  assert.equal(hzToMhz(14060000), "14.06");
});

test("maps CW spots to a Commander set frequency and mode command", () => {
  assert.equal(
    buildSetFreqModeCommand({ freqHz: 7150500, mode: "CW" }),
    "<command:14>CmdSetFreqMode<parameters:57><xcvrfreq:6>7150.5<xcvrmode:2>CW<preservesplitanddual:1>N"
  );
});

test("builds a QSX split command for a 90 Hz CW TX offset", () => {
  assert.equal(addHzOffset(7150500, 90), 7150590);
  assert.equal(
    buildQsxSplitCommand({ txFreqHz: 7150590 }),
    "<command:11>CmdQSXSplit<parameters:59><xcvrfreq:7>7150.59<SuppressDual:1>Y<SuppressModeChange:1>N"
  );
});

test("adds the CW TX offset command only for CW spots", () => {
  assert.equal(buildTuneCommands({ freqHz: 7150500, mode: "CW" }).length, 2);
  assert.equal(buildTuneCommands({ freqHz: 14250000, mode: "SSB" }).length, 1);
});

test("allows a custom VFO offset from -5000 to 5000 Hz", () => {
  assert.equal(normalizeVfoOffsetHz(-5000), -5000);
  assert.equal(normalizeVfoOffsetHz("5000"), 5000);
  assert.throws(() => normalizeVfoOffsetHz(-5001), /VFO offset/);
  assert.throws(() => normalizeVfoOffsetHz(5001), /VFO offset/);
  assert.throws(() => normalizeVfoOffsetHz(90.5), /VFO offset/);
});

test("uses a custom CW TX offset when building tune commands", () => {
  const commands = buildTuneCommands({ freqHz: 7150500, mode: "CW", cwTxOffsetHz: -250 });
  assert.equal(commands.length, 2);
  assert.match(commands[1], /<xcvrfreq:7>7150.25/);
});

test("builds a DXKeeper log command with POTA ADIF fields", () => {
  const command = buildDxKeeperLogCommand({
    loggedAt: new Date("2026-05-22T14:03:04Z"),
    spot: {
      dx_call: "N0CALL",
      freq: 7150500,
      band: "40m",
      mode_type: "CW",
      sig: "POTA",
      sig_refs: [{ id: "US-1234", name: "Example Park" }],
      signalReport: "559",
      logComment: "559 WNY"
    }
  });

  assert.match(command, /^<command:3>log<parameters:\d+>/);
  assert.match(command, /<CALL:6>N0CALL/);
  assert.match(command, /<FREQ:6>7.1505/);
  assert.match(command, /<BAND:3>40M/);
  assert.match(command, /<RST_SENT:3>559/);
  assert.match(command, /<RST_RCVD:3>559/);
  assert.match(command, /<QSO_DATE:8>20260522/);
  assert.match(command, /<TIME_ON:6>140304/);
  assert.match(command, /<SIG:4>POTA/);
  assert.match(command, /<SIG_INFO:7>US-1234/);
  assert.match(command, /<POTA_REF:7>US-1234/);
  assert.match(command, /<COMMENT:7>559 WNY/);
  assert.match(command, /<EOR>$/);
});

test("builds DXCluster notes with POTA underscores", () => {
  const spot = {
    dx_call: "N0CALL",
    freq: 14062000,
    mode_type: "CW",
    sig: "POTA",
    sig_refs: [{ id: "US-6563" }]
  };

  assert.equal(buildDxClusterSpotNotes({ spot, comment: "559 WNY" }), "_POTA_ US-6563 CW 559 WNY");
  assert.equal(buildDxClusterSpotCommand({ spot, comment: "559 WNY" }), "DX 14062 N0CALL _POTA_ US-6563 CW 559 WNY");
});

test("builds DXCluster notes without underscores for SOTA and WWFF", () => {
  assert.equal(
    buildDxClusterSpotNotes({
      spot: { dx_call: "N0CALL", freq: 7032000, mode_type: "CW", sig: "SOTA", sig_refs: [{ id: "W2/WE-001" }] },
      comment: "599 WNY"
    }),
    "SOTA W2/WE-001 CW 599 WNY"
  );
  assert.equal(
    buildDxClusterSpotNotes({
      spot: { dx_call: "N0CALL", freq: 7032000, mode_type: "CW", sig: "WWFF", sig_refs: [{ id: "KFF-1234" }] },
      comment: "599 WNY"
    }),
    "WWFF KFF-1234 CW 599 WNY"
  );
});

test("builds a POTA spot API payload", () => {
  assert.equal(isPotaSpot({ sig: "POTA", sig_refs: [{ id: "US-6563" }] }), true);
  assert.deepEqual(
    buildPotaSpotPayload({
      timestamp: new Date("2024-05-23T14:32:00Z"),
      spotter: "n2epe",
      comment: "559 WNY",
      spot: {
        dx_call: "n0call",
        freq: 14062000,
        mode_type: "CW",
        sig: "POTA",
        sig_refs: [{ id: "US-6563" }]
      }
    }),
    {
      activator: "N0CALL",
      frequency: "14.062",
      mode: "CW",
      reference: "US-6563",
      comments: "559 WNY",
      spotter: "N2EPE",
      source: "ParkHunter - n2epe",
      timestamp: "2024-05-23T14:32:00.000Z"
    }
  );
});

test("normalizes SSB-style modes when a non-CW spot is passed in", () => {
  assert.equal(normalizeCommanderMode("SSB", 7200000), "LSB");
  assert.equal(normalizeCommanderMode("PHONE", 14250000), "USB");
});

test("detects QRT spots by comment or status text", () => {
  assert.equal(isQrtSpot({ comment: "QRT thanks hunters" }), true);
  assert.equal(isQrtSpot({ status: "qrt" }), true);
  assert.equal(isQrtSpot({ comment: "Calling CQ POTA" }), false);
});
