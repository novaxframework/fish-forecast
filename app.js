
// ============================================================
//  Fish Forecast — app.js  v2
//  Location selector + 7-day forecast + per-day grading
// ============================================================

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';

// ── Grading weights (total = 100) ────────────────────────────
const WEIGHTS = {
  pressure: 20,
  wind:     20,
  moon:     20,
  cloud:    15,
  temp:     15,
  precip:   10,
};

// ── Moon phase name + bonus ──────────────────────────────────
function moonPhaseName(phase) {
  if (phase < 0.04 || phase > 0.96) return { name: '🌑 New Moon',        bonus: 1.0  };
  if (phase < 0.13)                  return { name: '🌒 Waxing Crescent', bonus: 0.5  };
  if (phase < 0.25)                  return { name: '🌓 First Quarter',   bonus: 0.65 };
  if (phase < 0.37)                  return { name: '🌔 Waxing Gibbous',  bonus: 0.8  };
  if (phase < 0.55)                  return { name: '🌕 Full Moon',       bonus: 1.0  };
  if (phase < 0.63)                  return { name: '🌖 Waning Gibbous',  bonus: 0.75 };
  if (phase < 0.75)                  return { name: '🌗 Last Quarter',    bonus: 0.6  };
  if (phase < 0.88)                  return { name: '🌘 Waning Crescent', bonus: 0.45 };
  return { name: '🌑 New Moon', bonus: 1.0 };
}

// ── Moon phase from date (Meeus approximation) ───────────────
function getMoonPhase(date) {
  const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
  let yr = y, mo = m;
  if (mo <= 2) { yr--; mo += 12; }
  const A  = Math.floor(yr / 100);
  const B  = 2 - A + Math.floor(A / 4);
  const JD = Math.floor(365.25*(yr+4716)) + Math.floor(30.6001*(mo+1)) + d + B - 1524.5;
  const days = (JD - 2451549.5) % 29.53058867;
  return (days < 0 ? days + 29.53058867 : days) / 29.53058867;
}

// ── Solunar windows ──────────────────────────────────────────
function formatHour(h) {
  const hour = ((Math.round(h * 2) / 2) + 24) % 24;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const display = hour % 12 === 0 ? 12 : Math.floor(hour % 12);
  const mins = (hour % 1 === 0.5) ? ':30' : ':00';
  return display + mins + ' ' + suffix;
}
function getSolunarTimes(moonPhase, sunriseHour, sunsetHour) {
  const mid = (sunriseHour + sunsetHour) / 2;
  const windows = [
    { label: formatHour(sunriseHour-0.5)+' – '+formatHour(sunriseHour+1.5), type:'peak',  note:'Major (Sunrise)' },
    { label: formatHour(sunsetHour-1)  +' – '+formatHour(sunsetHour+0.5),   type:'peak',  note:'Major (Sunset)'  },
    { label: formatHour(mid-0.5)       +' – '+formatHour(mid+0.5),          type:'minor', note:'Minor (Midday)'  },
  ];
  if (moonPhase > 0.45 && moonPhase < 0.55)
    windows.push({ label:'10 PM – 12 AM', type:'peak', note:'Moon Overhead (Full)' });
  return windows;
}

// ── Weather icon from cloud + precip ────────────────────────
function weatherIcon(avgCloud, totalPrecip) {
  if (totalPrecip > 0.5) return '🌧️';
  if (totalPrecip > 0.1) return '🌦️';
  if (avgCloud > 75)     return '☁️';
  if (avgCloud > 40)     return '⛅';
  if (avgCloud > 10)     return '🌤️';
  return '☀️';
}

// ── Grade a single day (given day offset 0-6) ────────────────
function gradeDay(weather, dayIndex) {
  const offset = dayIndex * 24;
  const sliceH = (arr, start, end) => arr.slice(offset+start, offset+end);

  // 1. Barometric pressure trend
  const pressures   = weather.hourly.surface_pressure;
  const morningAvg  = sliceH(pressures,6,12).reduce((a,b)=>a+b,0)/6;
  const prevAvg     = sliceH(pressures,0,6).reduce((a,b)=>a+b,0)/6;
  const delta       = morningAvg - prevAvg;
  const presScore   = delta> 1.5?1.0: delta> 0.5?0.85: delta>-0.5?0.65: delta>-1.5?0.4:0.2;
  const pressTrend  = delta>1?'Rising ↑':delta>0?'Slightly Rising ↗':delta<-1?'Falling ↓':'Stable →';
  const pressVal    = morningAvg.toFixed(1)+' hPa — '+pressTrend;

  // 2. Wind
  const winds    = sliceH(weather.hourly.windspeed_10m,6,18);
  const avgWind  = winds.reduce((a,b)=>a+b,0)/winds.length;
  const windScore= avgWind<5?1.0: avgWind<10?0.85: avgWind<15?0.65: avgWind<20?0.4:0.15;
  const windVal  = avgWind.toFixed(1)+' mph avg';

  // 3. Moon phase
  const date     = new Date();
  date.setDate(date.getDate() + dayIndex);
  const phase    = getMoonPhase(date);
  const moonInfo = moonPhaseName(phase);
  const moonVal  = moonInfo.name+' ('+(phase*100).toFixed(0)+'% cycle)';

  // 4. Cloud cover
  const clouds   = sliceH(weather.hourly.cloudcover,6,18);
  const avgCloud = clouds.reduce((a,b)=>a+b,0)/clouds.length;
  const cloudScore= (avgCloud>=30&&avgCloud<=80)?1.0: avgCloud>80?0.65: avgCloud>=10?0.7:0.5;
  const cloudVal = avgCloud.toFixed(0)+'% — '+(avgCloud>80?'Overcast':avgCloud>40?'Partly Cloudy ☁️':avgCloud>10?'Mostly Clear 🌤️':'Clear Sky ☀️');

  // 5. Temperature
  const temps    = sliceH(weather.hourly.temperature_2m,6,18);
  const avgTemp  = temps.reduce((a,b)=>a+b,0)/temps.length;
  const tempF    = (avgTemp*9/5)+32;
  const tempScore= (tempF>=55&&tempF<=75)?1.0:(tempF>=45&&tempF<55)?0.75:(tempF>75&&tempF<=85)?0.75:(tempF>=35&&tempF<45)?0.45:(tempF>85&&tempF<=95)?0.45:0.2;
  const tempVal  = tempF.toFixed(1)+'°F ('+avgTemp.toFixed(1)+'°C) avg daytime';

  // 6. Precipitation
  const precips     = sliceH(weather.hourly.precipitation,6,18);
  const totalPrecip = precips.reduce((a,b)=>a+b,0);
  const precipScore = totalPrecip===0?1.0: totalPrecip<0.1?0.85: totalPrecip<0.5?0.6: totalPrecip<1.0?0.35:0.1;
  const precipVal   = totalPrecip.toFixed(2)+'" expected';

  const scores = {
    pressure: Math.round(WEIGHTS.pressure * presScore),
    wind:     Math.round(WEIGHTS.wind     * windScore),
    moon:     Math.round(WEIGHTS.moon     * moonInfo.bonus),
    cloud:    Math.round(WEIGHTS.cloud    * cloudScore),
    temp:     Math.round(WEIGHTS.temp     * tempScore),
    precip:   Math.round(WEIGHTS.precip   * precipScore),
  };
  const total = Object.values(scores).reduce((a,b)=>a+b,0);
  const grade = total>=85?'A': total>=70?'B': total>=55?'C': total>=40?'D':'F';
  const label = grade==='A'?'🎣 Outstanding — Get out there!':
                grade==='B'?'👍 Good Conditions':
                grade==='C'?'😐 Fair — Worth a try':
                grade==='D'?'🌧️ Poor Conditions':'🚫 Stay Home Today';

  const sunriseHour = weather.daily?.sunrise?.[dayIndex]
    ? new Date(weather.daily.sunrise[dayIndex]).getHours()+new Date(weather.daily.sunrise[dayIndex]).getMinutes()/60 : 6.5;
  const sunsetHour  = weather.daily?.sunset?.[dayIndex]
    ? new Date(weather.daily.sunset[dayIndex]).getHours()+new Date(weather.daily.sunset[dayIndex]).getMinutes()/60 : 19.5;
  const solunarTimes = getSolunarTimes(phase, sunriseHour, sunsetHour);

  const maxTemp = weather.daily?.temperature_2m_max?.[dayIndex];
  const minTemp = weather.daily?.temperature_2m_min?.[dayIndex];
  const hiF = maxTemp != null ? ((maxTemp*9/5)+32).toFixed(0) : '—';
  const loF = minTemp != null ? ((minTemp*9/5)+32).toFixed(0) : '—';

  return {
    total, grade, label, scores, date,
    icon: weatherIcon(avgCloud, totalPrecip),
    hiF, loF,
    details: {
      pressure: { val: pressVal,   pts: scores.pressure, max: WEIGHTS.pressure },
      wind:     { val: windVal,    pts: scores.wind,     max: WEIGHTS.wind     },
      moon:     { val: moonVal,    pts: scores.moon,     max: WEIGHTS.moon     },
      cloud:    { val: cloudVal,   pts: scores.cloud,    max: WEIGHTS.cloud    },
      temp:     { val: tempVal,    pts: scores.temp,     max: WEIGHTS.temp     },
      precip:   { val: precipVal,  pts: scores.precip,   max: WEIGHTS.precip   },
    },
    solunarTimes,
  };
}

// ── Geocode a query ──────────────────────────────────────────
async function geocode(query) {
  const url = GEOCODE_URL+'?name='+encodeURIComponent(query)+'&count=5&language=en&format=json';
  const res  = await fetch(url);
  const data = await res.json();
  if (!data.results?.length) throw new Error('Location not found. Try a different city or zip code.');
  const r = data.results[0];
  return {
    lat:  r.latitude,
    lon:  r.longitude,
    name: r.name + (r.admin1 ? ', '+r.admin1 : '') + (r.country_code ? ' '+r.country_code : ''),
  };
}

// ── Fetch 7 days of hourly weather ──────────────────────────
async function fetchWeather(lat, lon) {
  const params = new URLSearchParams({
    latitude:  lat,
    longitude: lon,
    hourly:    'temperature_2m,precipitation,cloudcover,windspeed_10m,surface_pressure',
    daily:     'sunrise,sunset,temperature_2m_max,temperature_2m_min',
    temperature_unit:   'celsius',
    windspeed_unit:     'mph',
    precipitation_unit: 'inch',
    timezone:           'auto',
    forecast_days:      7,
  });
  const res = await fetch(WEATHER_URL+'?'+params);
  if (!res.ok) throw new Error('Weather API error: '+res.status);
  return res.json();
}

// ── UI helpers ───────────────────────────────────────────────
function showLoader(on) {
  document.getElementById('loaderOverlay').classList.toggle('active', on);
}

function renderOutlookGrid(forecasts) {
  const grid = document.getElementById('outlookGrid');
  grid.innerHTML = '';
  const today = new Date();
  forecasts.forEach((f, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const dayName = i === 0 ? 'Today' : d.toLocaleDateString('en-US',{weekday:'short'});
    const dateNum = d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    const card = document.createElement('div');
    card.className = 'outlook-day' + (i===0?' today-card':'');
    card.dataset.index = i;
    card.innerHTML = `
      <div class="outlook-day-name">${dayName}</div>
      <div class="outlook-date-num">${dateNum}</div>
      <div class="outlook-icon">${f.icon}</div>
      <div class="outlook-grade grade-color-${f.grade}">${f.grade}</div>
      <div class="outlook-score">${f.total}/100</div>
      <div class="outlook-hi-lo">${f.hiF}° / ${f.loF}°</div>
    `;
    card.addEventListener('click', () => selectDay(i, forecasts));
    grid.appendChild(card);
  });
}

function selectDay(index, forecasts) {
  // Highlight selected card
  document.querySelectorAll('.outlook-day').forEach(c => c.classList.remove('selected'));
  const selected = document.querySelector(`.outlook-day[data-index="${index}"]`);
  if (selected) selected.classList.add('selected');

  const f   = forecasts[index];
  const today = new Date();
  const d   = new Date(today);
  d.setDate(today.getDate() + index);

  // Detail panel
  const panel = document.getElementById('detailPanel');
  panel.className = 'detail-panel grade-'+f.grade;
  document.getElementById('gradeLetter').textContent = f.grade;
  document.getElementById('gradeLabel').textContent  = f.label;
  document.getElementById('gradeScore').textContent  = f.total;
  document.getElementById('gradeDate').textContent   =
    (index===0?'Today, ':'')+d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
  document.getElementById('gradeLocation').textContent = '📍 ' + (window._locationName || '');

  // Condition rows
  ['pressure','wind','moon','cloud','temp','precip'].forEach(key => {
    const det = f.details[key];
    const pct = Math.round((det.pts/det.max)*100);
    document.getElementById('val-'+key).textContent = det.val;
    document.getElementById('pts-'+key).textContent = '+'+det.pts;
    document.getElementById('bar-'+key).style.width = pct+'%';
  });

  // Solunar chips
  const chips = document.getElementById('timeChips');
  chips.innerHTML = '';
  f.solunarTimes.forEach(w => {
    const chip = document.createElement('span');
    chip.className = 'time-chip '+(w.type==='peak'?'peak':'');
    chip.textContent = w.label+(w.note?' · '+w.note:'');
    chips.appendChild(chip);
  });
}

// ── Main forecast runner ─────────────────────────────────────
let _forecasts = [];

async function runForecast(lat, lon, locationName) {
  showLoader(true);
  window._locationName = locationName;
  try {
    const weather   = await fetchWeather(lat, lon);
    _forecasts = [];
    for (let i = 0; i < 7; i++) _forecasts.push(gradeDay(weather, i));
    renderOutlookGrid(_forecasts);
    selectDay(0, _forecasts);

    // Active banner
    const banner = document.getElementById('activeBanner');
    banner.style.display = 'flex';
    document.getElementById('activeBannerText').textContent = '📍 '+locationName;
    document.getElementById('activeBannerCoords').textContent =
      lat.toFixed(4)+'°, '+lon.toFixed(4)+'°';
  } catch(e) {
    alert('Error: '+e.message);
  } finally {
    showLoader(false);
  }
}

// ── Event listeners ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Search button
  document.getElementById('searchBtn').addEventListener('click', async () => {
    const q = document.getElementById('locationInput').value.trim();
    if (!q) return;
    clearPresets();
    showLoader(true);
    try {
      const loc = await geocode(q);
      await runForecast(loc.lat, loc.lon, loc.name);
    } catch(e) {
      showLoader(false);
      alert(e.message);
    }
  });

  // Enter key on input
  document.getElementById('locationInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('searchBtn').click();
  });

  // GPS button
  document.getElementById('geoBtn').addEventListener('click', () => {
    if (!navigator.geolocation) return alert('Geolocation not supported by your browser.');
    showLoader(true);
    clearPresets();
    navigator.geolocation.getCurrentPosition(
      async pos => {
        const { latitude: lat, longitude: lon } = pos.coords;
        // Reverse geocode using Open-Meteo (lat/lon → name)
        try {
          const res  = await fetch(GEOCODE_URL+'?name=&latitude='+lat+'&longitude='+lon+'&count=1&language=en&format=json');
          // Open-Meteo geocoding doesn't support reverse — use coords label
          await runForecast(lat, lon, 'My Location ('+lat.toFixed(2)+', '+lon.toFixed(2)+')');
        } catch(e) {
          await runForecast(lat, lon, 'My Location');
        }
      },
      err => { showLoader(false); alert('Could not get location: '+err.message); }
    );
  });

  // Preset buttons
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      clearPresets();
      btn.classList.add('active');
      const q = btn.dataset.loc;
      document.getElementById('locationInput').value = q;
      showLoader(true);
      try {
        const loc = await geocode(q);
        await runForecast(loc.lat, loc.lon, loc.name);
      } catch(e) {
        showLoader(false);
        alert(e.message);
      }
    });
  });

  function clearPresets() {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  }

  // Auto-run with geolocation on load (silent fail → no location selected)
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      async pos => {
        const { latitude: lat, longitude: lon } = pos.coords;
        await runForecast(lat, lon, 'My Location ('+lat.toFixed(2)+', '+lon.toFixed(2)+')');
      },
      () => {} // silent fail — user will use search/presets
    );
  }
});
