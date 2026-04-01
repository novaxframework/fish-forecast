/**
 * Fish Forecast — Daily Scheduler
 * Runs at 6:00 AM every day, grades fishing conditions,
 * and appends the result to daily-log.json
 *
 * Usage: node scheduler.js
 * Requires: node-cron, node-fetch
 */

import cron from 'node-cron';
import fetch from 'node-fetch';
import fs   from 'fs';

const LAT = process.env.FORECAST_LAT || '39.9526';  // Default: Philadelphia
const LON = process.env.FORECAST_LON || '-75.1652';
const LOG_FILE = './daily-log.json';

// ── Reuse grading logic (server-side version) ─────────────────
function getMoonPhase(date) {
  const year = date.getFullYear(), month = date.getMonth() + 1, day = date.getDate();
  let y = year, m = month;
  if (m <= 2) { y--; m += 12; }
  const A  = Math.floor(y / 100);
  const B  = 2 - A + Math.floor(A / 4);
  const JD = Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + B - 1524.5;
  const d  = (JD - 2451549.5) % 29.53058867;
  return (d < 0 ? d + 29.53058867 : d) / 29.53058867;
}

function moonBonus(phase) {
  if (phase < 0.04 || phase > 0.96) return 1.0;
  if (phase < 0.25) return 0.6;
  if (phase < 0.37) return 0.8;
  if (phase < 0.55) return 1.0;
  if (phase < 0.63) return 0.75;
  return 0.5;
}

async function fetchWeather(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat, longitude: lon,
    hourly: 'temperature_2m,precipitation,cloudcover,windspeed_10m,surface_pressure',
    temperature_unit: 'celsius', windspeed_unit: 'mph',
    precipitation_unit: 'inch', timezone: 'auto', forecast_days: 2
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  return res.json();
}

function grade(weather, date) {
  const p  = weather.hourly.surface_pressure;
  const delta = (p.slice(6,12).reduce((a,b)=>a+b,0)/6) - (p.slice(0,6).reduce((a,b)=>a+b,0)/6);
  const pScore = delta > 1.5 ? 20 : delta > 0.5 ? 17 : delta > -0.5 ? 13 : delta > -1.5 ? 8 : 4;

  const winds = weather.hourly.windspeed_10m.slice(6,18);
  const avgW  = winds.reduce((a,b)=>a+b,0)/winds.length;
  const wScore = avgW < 5 ? 20 : avgW < 10 ? 17 : avgW < 15 ? 13 : avgW < 20 ? 8 : 3;

  const phase  = getMoonPhase(date);
  const mScore = Math.round(20 * moonBonus(phase));

  const clouds = weather.hourly.cloudcover.slice(6,18);
  const avgC   = clouds.reduce((a,b)=>a+b,0)/clouds.length;
  const cScore = avgC >= 30 && avgC <= 80 ? 15 : avgC > 80 ? 10 : avgC >= 10 ? 11 : 8;

  const temps = weather.hourly.temperature_2m.slice(6,18);
  const avgT  = (temps.reduce((a,b)=>a+b,0)/temps.length * 9/5) + 32;
  const tScore = avgT >= 55 && avgT <= 75 ? 15 : avgT >= 45 ? 11 : avgT >= 35 ? 7 : 3;

  const precip = weather.hourly.precipitation.slice(6,18).reduce((a,b)=>a+b,0);
  const prScore = precip === 0 ? 10 : precip < 0.1 ? 8 : precip < 0.5 ? 6 : precip < 1 ? 3 : 1;

  const total = pScore + wScore + mScore + cScore + tScore + prScore;
  const g = total >= 85 ? 'A' : total >= 70 ? 'B' : total >= 55 ? 'C' : total >= 40 ? 'D' : 'F';

  return {
    date: date.toISOString().split('T')[0],
    score: total, grade: g,
    avgTempF: avgT.toFixed(1),
    avgWindMph: avgW.toFixed(1),
    precipIn: precip.toFixed(2),
    cloudPct: avgC.toFixed(0),
    moonPhase: (phase * 100).toFixed(0) + '%',
    pressureDelta: delta.toFixed(2),
  };
}

async function runDailyGrade() {
  console.log('[FishForecast] Running daily grade at', new Date().toISOString());
  try {
    const weather = await fetchWeather(LAT, LON);
    const result  = grade(weather, new Date());
    console.log(`[FishForecast] Grade: ${result.grade} (${result.score}/100) — ${result.date}`);

    const log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    log.entries.unshift(result);
    if (log.entries.length > 365) log.entries = log.entries.slice(0, 365);
    log.lastUpdated = new Date().toISOString();
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));

    console.log('[FishForecast] Log updated ✅');
    return result;
  } catch (err) {
    console.error('[FishForecast] Error:', err.message);
  }
}

// ── Schedule: every day at 6:00 AM ───────────────────────────
cron.schedule('0 6 * * *', runDailyGrade, { timezone: 'America/New_York' });
console.log('[FishForecast] Scheduler started — runs daily at 6:00 AM ET');

// Run immediately on startup too
runDailyGrade();

export { runDailyGrade, grade };
