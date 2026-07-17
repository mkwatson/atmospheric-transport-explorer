# Atmosphere

A client-only, interactive view of NOAA GFS surface wind over the contiguous United States.

The map opens at the national scale, animates the wind field, and lets people drag, rotate, zoom, play or scrub through forecast time. Selecting any point adds a deliberately labeled kinematic backward trace using the same gridded field.

## Architecture

- MapLibre GL JS renders the map and direct manipulation.
- OpenFreeMap supplies the keyless OpenStreetMap basemap.
- Open-Meteo supplies keyless NOAA GFS hourly wind values as JSON.
- `mapbox-exif-layer` renders GPU particles from a small browser-generated velocity texture.
- Zod parses the external forecast response once at the network boundary.
- Pure functions in `app/wind.ts` handle vectors, interpolation, texture values, and trajectory integration.

There is no application backend, database, authentication, API key, or secret. The Cloudflare Worker is only the Sites hosting adapter.

## Commands

```bash
npm install
npm run dev
npm run verify
```

## Scientific scope

Particles visualize an interpolated forecast wind field. The selected-point line is a browser-computed kinematic estimate, not an observation, dispersion simulation, source-apportionment result, or HYSPLIT trajectory.
