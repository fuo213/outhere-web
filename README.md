# OutHere Web — Map Viewer

Web-based hiking map viewer for OutHere tiles. Displays Utah vector tiles (PMTiles) with layer controls, built on MapLibre GL JS.

## Quick Start

1. **Set your tile URL** in `config.js`:
   ```js
   const TILE_URL = "https://pub-YOUR_ACCOUNT_ID.r2.dev/utah/utah_hiking.pmtiles";
   ```

2. **Serve locally** (any static file server works):
   ```bash
   # Python
   python3 -m http.server 8080

   # Node
   npx serve .
   ```

3. Open `http://localhost:8080` in your browser.

## Local Development with PMTiles File

If you haven't deployed tiles to R2 yet, you can test with a local PMTiles file by running a local HTTP server that serves both the app and the tiles:

```bash
# Symlink or copy the PMTiles file into this directory
ln -s ../outhere/utah_maps/output/utah_hiking.pmtiles .

# Update config.js to use a relative URL
# const TILE_URL = "utah_hiking.pmtiles";

# Serve
python3 -m http.server 8080
```

## Deploy to Cloudflare Pages

This is a static site — no build step required.

### Via Dashboard

1. Push this repo to GitHub.
2. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) > Pages > Create a project.
3. Connect your GitHub repo.
4. Build settings:
   - **Build command**: (leave empty)
   - **Build output directory**: `.` (root)
5. Deploy.

### Via Wrangler CLI

```bash
npm install -g wrangler
wrangler pages deploy . --project-name outhere-web
```

## Project Structure

```
outhere-web/
├── index.html      # Entry point — loads MapLibre, PMTiles, styles, scripts
├── styles.css      # Full-screen map layout, header, layer panel, responsive
├── app.js          # Map initialization, style builder, layer controls, popups
├── config.js       # Tile URL, map center/bounds, layer group definitions
└── README.md       # This file
```

## Configuration

All configuration lives in `config.js`:

| Variable | Purpose |
|----------|---------|
| `TILE_URL` | URL to the PMTiles file on R2 (or local path) |
| `MAP_CONFIG.center` | Initial map center `[lng, lat]` |
| `MAP_CONFIG.zoom` | Initial zoom level |
| `MAP_CONFIG.maxBounds` | Restrict panning to Utah bounding box |
| `LAYER_GROUPS` | Layer toggle definitions with legend colors |

## Layers

The viewer displays six data layers from the OutHere tile pipeline:

| Layer | Source Layer | Description |
|-------|-------------|-------------|
| Trails | `trails` | Hiking trails colored by difficulty |
| Contours | `contours` | Elevation contour lines (12m/40ft interval for desert) |
| POIs | `pois` | Trailheads, summits, water sources, viewpoints |
| Water | `water` | Rivers, streams, lakes |
| Roads | `roads` | Roads for context |
| Protected Areas | `protected_areas` | National parks, wilderness areas |

## Dependencies

All loaded from CDN — no `npm install` needed:

- [MapLibre GL JS](https://maplibre.org) v4.7.1 — map rendering
- [PMTiles](https://github.com/protomaps/PMTiles) v3.2.1 — protocol handler for single-file vector tiles

## Related Repos

- **[outhere](../outhere/)** — Tile generation pipeline (OSM + USGS DEM processing)
- **[booot-landing](../booot-landing/)** — Marketing landing page at booot.org
- **[booot-signup-worker](../booot-signup-worker/)** — Email signup API (Cloudflare Worker)
