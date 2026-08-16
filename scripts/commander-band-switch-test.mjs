import net from "node:net";

const HOST = process.env.COMMANDER_HOST || "127.0.0.1";
const PORT = Number(process.env.COMMANDER_PORT || 52002);
const PAUSE_MS = Number(process.env.PAUSE_MS || 5000);
const SEND_QSX = process.env.SEND_QSX === "1";
const DXLAB_STYLE = process.env.DXLAB_STYLE === "1";
const CW_TX_OFFSET_HZ = Number(process.env.CW_TX_OFFSET_HZ || 90);

const spots = [
  { label: "20m", khz: "14060", mode: "CW" },
  { label: "40m", khz: "7060", mode: "CW" }
];

function adifField(name, value) {
  const text = String(value);
  return `<${name}:${text.length}>${text}`;
}

function setFreqModeCommand({ khz, mode }) {
  const parameters = [
    adifField("xcvrfreq", khz),
    adifField("xcvrmode", mode),
    adifField("preservesplitanddual", "N")
  ].join("");

  return `${adifField("command", "CmdSetFreqMode")}${adifField("parameters", parameters)}`;
}

function qsxSplitCommand({ khz, includeSuppressModeChange = true }) {
  const txKhz = (Number(khz) + CW_TX_OFFSET_HZ / 1000).toFixed(3).replace(/\.?0+$/, "");
  const parameters = [
    adifField("xcvrfreq", txKhz),
    adifField("SuppressDual", DXLAB_STYLE ? "N" : "Y"),
    includeSuppressModeChange ? adifField("SuppressModeChange", "N") : ""
  ].join("");

  return `${adifField("command", "CmdQSXSplit")}${adifField("parameters", parameters)}`;
}

function sendCommanderCommand(command) {
  return sendCommanderCommands([command]);
}

function sendCommanderCommands(commands) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to Commander at ${HOST}:${PORT}.`));
    }, 3500);

    socket.on("connect", () => {
      writeNextCommand(0);
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

    function writeNextCommand(index) {
      if (index >= commands.length) {
        socket.end();
        return;
      }

      socket.write(commands[index], () => writeNextCommand(index + 1));
    }
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let stopped = false;
process.on("SIGINT", () => {
  stopped = true;
  console.log("\nStopping after current command...");
});

console.log(`Switching Commander between 14.060 MHz and 7.060 MHz CW every ${PAUSE_MS / 1000}s.`);
console.log(SEND_QSX ? `Sending CmdQSXSplit with ${CW_TX_OFFSET_HZ} Hz CW TX offset.` : "Sending CmdSetFreqMode only.");
console.log(DXLAB_STYLE ? "Using DXLabTest-style QSX parameters on one TCP connection." : "Using ParkHunter-style command connections.");
console.log("Press Ctrl+C to stop.");

for (let index = 0; !stopped; index += 1) {
  const spot = spots[index % spots.length];
  const commands = [setFreqModeCommand(spot)];
  if (SEND_QSX) {
    commands.push(qsxSplitCommand({ ...spot, includeSuppressModeChange: !DXLAB_STYLE }));
  }
  console.log(`${new Date().toLocaleTimeString()} ${spot.label} ${spot.khz} kHz ${spot.mode}`);
  if (DXLAB_STYLE) {
    await sendCommanderCommands(commands);
  } else {
    for (const command of commands) {
      await sendCommanderCommand(command);
    }
  }
  await wait(PAUSE_MS);
}
