# Trainer BLE Test

Web Bluetooth pages for smart bike trainers. Static files only, served by GitHub Pages; no backend.

Use Chrome on Android, or desktop Chrome / Edge. Web Bluetooth is not available in Safari, Firefox or on iOS.

## Connection test

https://my-design-studio-llc.github.io/trainer-ble-test/

- Connects over FTMS (Fitness Machine Service), then FE-C over BLE, then Cycling Power (read-only)
- Shows live power, cadence and speed
- ERG mode: sets a target power through the FTMS control point or FE-C page 49
- Resistance mode: fixed resistance 0-100 % through FTMS or FE-C page 48
- Logs services, control point responses and errors

## Ride 3D

https://my-design-studio-llc.github.io/trainer-ble-test/ride/

Ride a real route through a 3D scene built in the browser from satellite imagery and terrain tiles.

- Routes: the bundled sample (Cross Kirkland Corridor, South Kirkland to Totem Lake, 9.4 km, flat) or any GPX / TCX file
- The road grade is sent to the trainer (FTMS simulation or FE-C track resistance), scaled by a difficulty setting
- Speed modes: power based (power, grade, weight and drag), trainer speed, replay of recorded pace, manual
- Vertical resistance bar: drag (or ±1 %) for a fixed trainer resistance, Auto to follow the road grade again
- Full screen: on phones, Start ride goes full screen and locks landscape; the button at the top of the right-hand bar toggles it
- Heart rate strap support, TCX export of the ride (power, cadence, heart rate)

Data sources: imagery from Esri World Imagery or Sentinel-2 cloudless (EOX), elevation from AWS Terrain Tiles,
sample route geometry from OpenStreetMap contributors (ODbL). three.js r185 (MIT) is vendored in `ride/vendor/three`.

## Tests

```bash
node --test test/*.test.js
```
