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

- Routes: two bundled samples (Eastrail from Best Buy in Bellevue over the NE 8th St bridge and along the Cross Kirkland Corridor to Totem Lake, 13.0 km, flat; Fremont to Issaquah on the Burke-Gilman, Sammamish River and East Lake Sammamish Trails, 59.7 km, mostly flat) or any GPX / TCX file
- The road grade is sent to the trainer (FTMS simulation or FE-C track resistance), scaled by a difficulty setting
- Speed modes: power based (power, grade, weight and drag), trainer speed, replay of recorded pace, manual
- Vertical resistance bar: drag (or ±1 %) for a fixed trainer resistance, Auto to follow the road grade again
- Reverse: ride the route backwards, or Turn around mid-ride (U-turn button on the right-hand bar)
- Drag or tap the elevation profile to jump to any point on the route
- OpenStreetMap buildings beside the trail (extruded footprints), plus simple models and name signs for landmarks such as shelters and historic railcars; a banner names each landmark as you reach it. The sample routes bundle this data (`samples/*.osm.json`, made with `node tools/bake-osm.mjs <gpx> <out.json>`); uploaded routes query the Overpass API once per ride
- Live sky (default): the sun and moon are placed from the real date, time and position, so the light, sky colour, sunrise / sunset glow, night (stars) and moonlight (by phase and height) follow the real world; cloud cover, haze, rain, snow and fog come from Open-Meteo for wherever the rider is, refreshed every 15 minutes. Settings can switch to an always-clear afternoon. For testing, `?time=2026-12-21T16:30` and `?weather=rain|snow|fog|overcast`
- Distant skyline out to ~120 km (hills, Cascades, Olympics, Rainier) from coarse elevation tiles, with Earth curvature and a seasonal snow line
- Land-cover demo (imagery option "Hosted aerial photo + land cover"): around the Kirkland pavilion, USDA NAIP aerial photos are classified with near-infrared and OpenStreetMap into grass, forest floor, dirt, paved and water; the ground up close uses tiling textures for each class and trees stand where the map shows canopy. Data in `samples/landcover/`, textures in `ride/textures/`
- Bridges and tunnels from OpenStreetMap: bridges the route runs over are levelled and drawn with railings and trestles; roads and railways crossing over the route (e.g. I-405 over the Cross Kirkland Corridor) get a concrete deck, parapets, piers and shade on the trail; trail tunnels and underpasses get a tube, portals and an embankment. A banner names each one ("Under I 405"). Where OpenStreetMap has nothing, bridges are still inferred from the elevation profile. Baked into the sample files with `node tools/bake-osm.mjs <gpx> <out.json> --crossings`
- Drag the 3D view to look left, right, up or down; pinch (or mouse wheel) to change the field of view; double tap to look ahead again
- Full screen: on phones, Start ride goes full screen and locks landscape; the button at the top of the right-hand bar toggles it
- Keeps the screen on during a ride (Screen Wake Lock)
- Installable: Add to Home screen opens Ride 3D full screen in landscape
- Heart rate strap support, TCX export of the ride (power, cadence, heart rate)

Data sources: imagery from Esri World Imagery, Sentinel-2 cloudless (EOX) or USDA NAIP (public domain), elevation from AWS Terrain Tiles,
weather from Open-Meteo, ground textures from ambientCG (CC0),
sample route geometry, buildings and landmarks from OpenStreetMap contributors (ODbL). three.js r185 (MIT) is vendored in `ride/vendor/three`.

## Tests

```bash
node --test test/*.test.js
```
