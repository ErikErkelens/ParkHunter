# ParkHunter

ParkHunter lists and scans recent CW POTA, WWFF, and SOTA spots from the Spothole API.
It uses DXLab Suite Commander to tune the radio and DXKeeper to log contacts.
After logging, ParkHunter can spot POTA contacts directly to the POTA website or spot non-POTA contacts to a DXCluster.
Written by and for n2epe - Erik. 

## Run

```powershell
npm.cmd start
```

Open <http://127.0.0.1:3000>.

## Environment

Local settings live in `.env.local`, which is ignored by Git. A typical setup:

```text
HOST=127.0.0.1
PORT=3000

COMMANDER_HOST=127.0.0.1
COMMANDER_PORT=52002
DXKEEPER_HOST=127.0.0.1
DXKEEPER_PORT=52001

CW_TX_OFFSET_HZ=90
SPOT_AGE_SECONDS=1800
SCAN_DELAY_SECONDS=3

QRZ_USERNAME=your-callsign
QRZ_PASSWORD=your-qrz-xml-password-or-key

DXCLUSTER_HOST=your.cluster.host
DXCLUSTER_PORT=7300
DXCLUSTER_USERNAME=your-callsign

POTA_SPOT_TARGET=pota
POTA_SPOTTER_CALLSIGN=your-callsign
POTA_SPOT_SOURCE=ParkHunter - your-callsign
POTA_BEARER_TOKEN=your-pota-jwt
POTA_REFRESH_TOKEN=your-pota-refresh-token
POTA_COGNITO_CLIENT_ID=7hluqct0n2nckib7i7sd5753oa
POTA_COGNITO_REGION=us-east-2
```

Required for tuning and logging:

- `COMMANDER_HOST` / `COMMANDER_PORT`: DXLab Commander TCP command service. With DXLab's default Base Port `52000`, Commander listens on `52002`.
- `DXKEEPER_HOST` / `DXKEEPER_PORT`: DXKeeper TCP command service. With DXLab's default Base Port `52000`, DXKeeper listens on `52001`.

Useful operating defaults:

- `CW_TX_OFFSET_HZ`: CW transmit offset used for Commander's split command. Default `90`.
- `SPOT_AGE_SECONDS`: initial spot age filter. Default `1800`, or 30 minutes. Accepted UI values are `900`, `1800`, and `3600`.
- `SCAN_DELAY_SECONDS`: scan auto-advance delay. Default `3`.

Optional spot enrichment:

- `QRZ_USERNAME` / `QRZ_PASSWORD`: sent to QRZ only to obtain a QRZ XML session key. ParkHunter passes the session key to Spothole so Spothole can enrich spot data without receiving the QRZ password.

Optional spotting:

- `DXCLUSTER_HOST` / `DXCLUSTER_PORT` / `DXCLUSTER_USERNAME`: used for DXCluster spotting. If `DXCLUSTER_HOST` is not set, ParkHunter defaults to `dx.cqspot.com` on port `1234`.
- `POTA_SPOT_TARGET`: `pota` posts POTA spots directly to the POTA API. `dxcluster` sends POTA spots to the configured DXCluster instead.
- `POTA_*`: required only when `POTA_SPOT_TARGET=pota` and you want direct POTA spotting.

POTA token setup:

POTA does not currently provide a dedicated personal API-token screen for this workflow. The practical way to get the direct-spotting tokens is from a browser session where you are already signed in to <https://pota.app/>.

1. Open <https://pota.app/> and sign in.
2. Open browser developer tools.
3. Go to Application, then Storage, then Local storage or IndexedDB for `https://pota.app`.
4. Find the Cognito auth entries for the logged-in user.
5. Copy the access token into `POTA_BEARER_TOKEN`.
6. Copy the refresh token into `POTA_REFRESH_TOKEN`.
7. Leave `POTA_COGNITO_CLIENT_ID=7hluqct0n2nckib7i7sd5753oa` and `POTA_COGNITO_REGION=us-east-2` unless POTA changes its login application.

Treat the bearer and refresh tokens like passwords. Keep them only in `.env.local`, do not commit them, and replace them if you sign out of POTA, revoke sessions, or direct POTA spotting starts returning authentication errors.

Cache and API politeness:

- `POTA_REFERENCE_CACHE_TTL_MS`: refresh interval for `.cache/pota-references.json`, which stores POTA `locationDesc`, grid, latitude, and longitude from live POTA spots. Default 10 minutes.
- `SPOTHOLE_RATE_LIMIT_BACKOFF_MS`: fallback pause after Spothole returns `429` without `Retry-After`. Default 10 minutes.
- `SPOTHOLE_ERROR_BACKOFF_MS`: pause after other Spothole HTTP or network errors. Default 2 minutes.

## DXLab Setup

In Commander, open the Network Service window and enable TCP command acceptance.
ParkHunter sends `CmdSetFreqMode` to tune the radio, then sends `CmdQSXSplit` for CW spots with the configured transmit offset.

In DXKeeper, enable the Network Service.
The Log action sends DXKeeper a `log` TCP message with an ADIF record containing call, signal reports, frequency, band, mode, UTC date/time, and xOTA fields. POTA logs include `POTA_REF`, `SIG=POTA`, and `SIG_INFO=<reference>`.

## Scanning

The Scan button tunes through the current spot list, starting after the currently tuned row and wrapping back to the top at the end.
Scan skips spots already logged for the current UTC day, spots marked tried, spots with invalid frequencies, and spots above the 6m band.
Skip marks the current spot tried before advancing; Next advances without marking; Stop closes the scan dialog.

ParkHunter remembers logs and tried spots in browser local storage for the current UTC day. A row is crossed out when that callsign has already been logged on that band.

## Keyboard Shortcuts

- `Up` / `Down`: select and tune the previous or next spot
- `L`: log the selected spot
- `3` / `4` / `5` / `7` / `9`: in the log dialog, choose `339` / `449` / `559` / `579` / `999`
- `S`: start scan from the main screen; skip current spot in the scan dialog
- `Space`: next spot in the scan dialog
- `?`: show shortcuts

## Acknowledgements

ParkHunter depends on Spothole's free spot aggregation API. Spothole is written by Ian Renton, MØTRT, and contributors. See the [Spothole site](https://spothole.app/), [About page](https://spothole.app/about), and [API documentation](https://spothole.app/apidocs).

ParkHunter controls and logs through DXLab Suite, written by Dave Bernstein, AA6YQ. See the [DXLab Suite site](https://dxlabsuite.com/) and [DXLab wiki](https://www.dxlabsuite.com/dxlabwiki/).

## Test

```powershell
npm.cmd test
```
