/**
 * Fish Forecast — CLI Grade Tool
 * Usage: node grade-cli.js [lat] [lon]
 * Example: node grade-cli.js 39.95 -75.16
 */

import fetch from 'node-fetch';

const LAT = process.argv[2] || process.env.FORECAST_LAT || '39.9526';
const LON = process.argv[3] || process.env.FORECAST_LON || '-75.1652';

async function main() {
  console.log(`\n🎣 Fish Forecast CLI — ${new Date().toDateString()}\n`);
  console.log(`📍 Coordinates: ${LAT}, ${LON}\n`);

  const params = new URLSearchParams({
    latitude: LAT, longitude: LON,
    hourly: 'temperature_2m,precipitation,cloudcover,windspeed_10m,surface_pressure',
    temperature_unit: 'celsius', windspeed_unit: 'mph',
    precipitation_unit: 'inch', timezone: 'auto', forecast_days: 2
  });

  try {
    const res     = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    const weather = await res.json();

    const p      = weather.hourly.surface_pressure;
    const delta  = (p.slice(6,12).reduce((a,b)=>a+b,0)/6) - (p.slice(0,6).reduce((a,b)=>a+b,0)/6);
    const winds  = weather.hourly.windspeed_10m.slice(6,18);
    const avgW   = (winds.reduce((a,b)=>a+b,0)/winds.length).toFixed(1);
    const temps  = weather.hourly.temperature_2m.slice(6,18);
    const avgTF  = ((temps.reduce((a,b)=>a+b,0)/temps.length * 9/5) + 32).toFixed(1);
    const precip = weather.hourly.precipitation.slice(6,18).reduce((a,b)=>a+b,0).toFixed(2);

    console.log('Condition Summary:');
    console.log(`  🌡️  Pressure delta : ${delta.toFixed(2)} hPa`);
    console.log(`  💨  Avg wind       : ${avgW} mph`);
    console.log(`  🌡️  Avg temp       : ${avgTF}°F`);
    console.log(`  🌧️  Precipitation  : ${precip}"`);
    console.log('\nRun the web app for full grade breakdown.');
  } catch (e) {
    console.error('Error:', e.message);
  }
}

main();
