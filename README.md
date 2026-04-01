# 🎣 Fish Forecast

> Daily fishing condition grading tool — powered by Open-Meteo weather data

## Live Demo
Deployed on Vercel (see deployment URL)

## Grading Algorithm

| Factor | Weight | Ideal Condition |
|--------|--------|-----------------|
| Barometric Pressure | 20 pts | Rising pressure |
| Wind Speed | 20 pts | < 10 mph |
| Moon Phase | 20 pts | New or Full moon |
| Cloud Cover | 15 pts | 30–80% overcast |
| Temperature | 15 pts | 55–75°F |
| Precipitation | 10 pts | No rain |
| **Total** | **100 pts** | |

**Grades:** A (85+) · B (70–84) · C (55–69) · D (40–54) · F (<40)

## Features
- 🌤️ Real-time weather via [Open-Meteo](https://open-meteo.com) (free, no API key)
- 🌕 Moon phase + solunar time windows
- 📅 5-day fishing outlook
- 📍 Search by city/zip or use GPS
- 🕐 Best times to fish (solunar periods)
- 📊 Daily log (365 days history)
- ⏰ Auto-runs every morning at 6 AM

## Setup

```bash
npm install
node scheduler.js        # Start daily scheduler
node grade-cli.js        # CLI grade for default location
node grade-cli.js 40.71 -74.00   # CLI with custom coords
```

## Deploy
```bash
vercel --prod
```

Set environment variables on Vercel:
- `FORECAST_LAT` — your home latitude
- `FORECAST_LON` — your home longitude
