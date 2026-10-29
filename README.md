# Trainer BLE Test

A single-page Web Bluetooth test for smart bike trainers and power meters.

- Connects over FTMS (Fitness Machine Service), then FE-C over BLE, then Cycling Power (read-only)
- Shows live power, cadence and speed
- ERG mode: sets a target power through the FTMS control point or FE-C page 49
- Resistance mode: fixed resistance 0-100 % through FTMS or FE-C page 48
- Logs services, control point responses and errors

Open in Chrome on Android (or desktop Chrome / Edge): https://my-design-studio-llc.github.io/trainer-ble-test/

Web Bluetooth is not available in Safari, Firefox or on iOS.
