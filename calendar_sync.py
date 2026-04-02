#!/usr/bin/env python3
"""
Fish Forecast — Calendar Sync
================================
Fetches today's weather via Open-Meteo, grades fishing conditions
using the same logic as app.js, then creates/updates a Google Calendar
event with:
  Title : 🎣 Fishing Forecast: A | Best: 6:00 AM–8:00 AM, 5:00 PM–7:00 PM
  Detail: Full condition breakdown + solunar windows

Setup:
  1. pip install google-api-python-client google-auth-httplib2 google-auth-oauthlib requests
  2. Place credentials.json in this directory (download from Google Cloud Console)
  3. Run once to authorize: python calendar_sync.py --auth
     → Opens a URL in your browser, paste the code back in the terminal
  4. Schedule daily (GitHub Actions workflow or cron)

Env vars (optional):
  FISH_LAT        Latitude  (default: 30.2555)
  FISH_LON        Longitude (default: -88.0849)
  FISH_LOCATION   Display name (default: Dauphin Island, AL)
  CALENDAR_ID     Google Calendar ID (default: primary)
  GOOGLE_TOKEN    Full token.json contents as a string (for GitHub Actions secrets)

Cron example (6 AM daily):
  0 6 * * * cd /path/to/fish-forecast && python calendar_sync.py
"""

import os
import sys
import math
import json
import argparse
from datetime import date, datetime

# ── Optional Google imports ──────────────────────────────────
try:
    from googleapiclient.discovery import build
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request
    GOOGLE_AVAILABLE = True
except ImportError:
    GOOGLE_AVAILABLE = False

try:
    import requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False

# ── Config ───────────────────────────────────────────────────
SCOPES = ['https://www.googleapis.com/auth/calendar']
TOKEN_FILE  = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'token.json')
CREDS_FILE  = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'credentials.json')
# Set CALENDAR_ID to the calendar's ID (not its name).
# To find it: Google Calendar → Settings → [calendar name] → Calendar ID
# It looks like: abc123xyz@group.calendar.google.com
# Set via env var:  set CALENDAR_ID=your_calendar_id_here
CALENDAR_ID = os.environ.get('CALENDAR_ID', 'primary')
LAT         = float(os.environ.get('FISH_LAT',  '30.2555'))
LON         = float(os.environ.get('FISH_LON',  '-88.0849'))
LOCATION    = os.environ.get('FISH_LOCATION', 'Dauphin Island, AL')

WEIGHTS = {
    'pressure': 20,
    'wind'    : 20,
    'moon'    : 20,
    'cloud'   : 15,
    'temp'    : 15,
    'precip'  : 10,
}

GRADE_COLOR = {'A': '2', 'B': '9', 'C': '5', 'D': '6', 'F': '11'}


# ── Moon phase (Meeus approximation) ─────────────────────────
def get_moon_phase(d: date) -> float:
    y, m, day = d.year, d.month, d.day
    yr, mo = (y, m) if m > 2 else (y - 1, m + 12)
    A  = yr // 100
    B  = 2 - A + A // 4
    JD = (math.floor(365.25 * (yr + 4716)) + math.floor(30.6001 * (mo + 1))
          + day + B - 1524.5)
    days = (JD - 2451549.5) % 29.53058867
    if days < 0:
        days += 29.53058867
    return days / 29.53058867


def moon_phase_name(phase: float):
    if phase < 0.04 or phase > 0.96: return '🌑 New Moon',        1.00
    if phase < 0.13:                  return '🌒 Waxing Crescent', 0.50
    if phase < 0.25:                  return '🌓 First Quarter',   0.65
    if phase < 0.37:                  return '🌔 Waxing Gibbous',  0.80
    if phase < 0.55:                  return '🌕 Full Moon',       1.00
    if phase < 0.63:                  return '🌖 Waning Gibbous',  0.75
    if phase < 0.75:                  return '🌗 Last Quarter',    0.60
    if phase < 0.88:                  return '🌘 Waning Crescent', 0.45
    return '🌑 New Moon', 1.00


# ── Solunar windows ───────────────────────────────────────────
def fmt_hour(h: float) -> str:
    h = round(h * 2) / 2 % 24
    suffix = 'PM' if h >= 12 else 'AM'
    hour12 = 12 if h % 12 == 0 else int(h % 12)
    mins   = ':30' if h % 1 == 0.5 else ':00'
    return f'{hour12}{mins} {suffix}'


def solunar_windows(phase: float, sunrise_h: float, sunset_h: float) -> list:
    mid = (sunrise_h + sunset_h) / 2
    windows = [
        f'{fmt_hour(sunrise_h - 0.5)}-{fmt_hour(sunrise_h + 1.5)} (Major — Sunrise)',
        f'{fmt_hour(sunset_h  - 1.0)}-{fmt_hour(sunset_h  + 0.5)} (Major — Sunset)',
        f'{fmt_hour(mid - 0.5)}-{fmt_hour(mid + 0.5)} (Minor — Midday)',
    ]
    if 0.45 < phase < 0.55:
        windows.append('10:00 PM-12:00 AM (Moon Overhead — Full Moon)')
    return windows


# ── Fetch weather from Open-Meteo ─────────────────────────────
def fetch_weather(lat: float, lon: float) -> dict:
    if not REQUESTS_AVAILABLE:
        print('ERROR: requests not installed. Run: pip install requests')
        sys.exit(1)
    url    = 'https://api.open-meteo.com/v1/forecast'
    params = {
        'latitude'          : lat,
        'longitude'         : lon,
        'hourly'            : 'temperature_2m,precipitation,cloudcover,windspeed_10m,surface_pressure',
        'daily'             : 'sunrise,sunset,temperature_2m_max,temperature_2m_min',
        'temperature_unit'  : 'celsius',
        'windspeed_unit'    : 'mph',
        'precipitation_unit': 'inch',
        'timezone'          : 'auto',
        'forecast_days'     : 7,
    }
    r = requests.get(url, params=params, timeout=10)
    r.raise_for_status()
    return r.json()


# ── Grade today ───────────────────────────────────────────────
def grade_today(weather: dict, today: date, day_index: int = 0) -> dict:
    h    = weather['hourly']
    avg  = lambda arr, a, b: sum(arr[a:b]) / max(len(arr[a:b]), 1)
    sumv = lambda arr, a, b: sum(arr[a:b])

    # Each day occupies 24 hourly slots; offset by day_index
    base = day_index * 24

    # 1. Pressure trend (6-12 vs 0-6) for this day
    pressures   = h['surface_pressure']
    morning_avg = avg(pressures, base + 6, base + 12)
    prev_avg    = avg(pressures, base + 0, base + 6)
    delta       = morning_avg - prev_avg
    press_score = (1.0 if delta > 1.5 else 0.85 if delta > 0.5
                   else 0.65 if delta > -0.5 else 0.40 if delta > -1.5 else 0.20)
    press_trend = ('Rising' if delta > 1 else 'Slightly Rising' if delta > 0
                   else 'Falling' if delta < -1 else 'Stable')
    press_val   = f'{morning_avg:.1f} hPa — {press_trend}'

    # 2. Wind (6-18)
    avg_wind    = avg(h['windspeed_10m'], base + 6, base + 18)
    wind_score  = (1.0 if avg_wind < 5 else 0.85 if avg_wind < 10
                   else 0.65 if avg_wind < 15 else 0.40 if avg_wind < 20 else 0.15)
    wind_val    = f'{avg_wind:.1f} mph avg'

    # 3. Moon
    phase            = get_moon_phase(today)
    moon_name, bonus = moon_phase_name(phase)
    moon_val         = f'{moon_name} ({phase * 100:.0f}% cycle)'

    # 4. Cloud cover (6-18)
    avg_cloud   = avg(h['cloudcover'], base + 6, base + 18)
    cloud_score = (1.0 if 30 <= avg_cloud <= 80
                   else 0.65 if avg_cloud > 80
                   else 0.70 if avg_cloud >= 10 else 0.50)
    cloud_label = ('Overcast' if avg_cloud > 80
                   else 'Partly Cloudy' if avg_cloud > 40
                   else 'Mostly Clear' if avg_cloud > 10 else 'Clear Sky')
    cloud_val   = f'{avg_cloud:.0f}% — {cloud_label}'

    # 5. Temperature (6-18)
    avg_c       = avg(h['temperature_2m'], base + 6, base + 18)
    temp_f      = avg_c * 9 / 5 + 32
    temp_score  = (1.0 if 55 <= temp_f <= 75
                   else 0.75 if (45 <= temp_f < 55 or 75 < temp_f <= 85)
                   else 0.45 if (35 <= temp_f < 45 or 85 < temp_f <= 95)
                   else 0.20)
    temp_val    = f'{temp_f:.1f}F ({avg_c:.1f}C) avg daytime'

    # 6. Precipitation (6-18)
    total_precip = sumv(h['precipitation'], base + 6, base + 18)
    precip_score = (1.0 if total_precip == 0
                    else 0.85 if total_precip < 0.1
                    else 0.60 if total_precip < 0.5
                    else 0.35 if total_precip < 1.0 else 0.10)
    precip_val   = f'{total_precip:.2f}" expected'

    scores = {
        'pressure': round(WEIGHTS['pressure'] * press_score),
        'wind'    : round(WEIGHTS['wind']     * wind_score),
        'moon'    : round(WEIGHTS['moon']     * bonus),
        'cloud'   : round(WEIGHTS['cloud']    * cloud_score),
        'temp'    : round(WEIGHTS['temp']     * temp_score),
        'precip'  : round(WEIGHTS['precip']   * precip_score),
    }
    total = sum(scores.values())
    grade = ('A' if total >= 85 else 'B' if total >= 70
             else 'C' if total >= 55 else 'D' if total >= 40 else 'F')

    d    = weather.get('daily', {})
    hi_c = d.get('temperature_2m_max', [None] * 7)[day_index]
    lo_c = d.get('temperature_2m_min', [None] * 7)[day_index]
    hi_f = f'{hi_c * 9/5 + 32:.0f}F' if hi_c is not None else '--'
    lo_f = f'{lo_c * 9/5 + 32:.0f}F' if lo_c is not None else '--'

    def parse_hour(s):
        if not s: return None
        dt = datetime.fromisoformat(s)
        return dt.hour + dt.minute / 60

    sunrise_str = d.get('sunrise', [None] * 7)[day_index]
    sunset_str  = d.get('sunset',  [None] * 7)[day_index]
    sunrise_h   = parse_hour(sunrise_str) or 6.5
    sunset_h    = parse_hour(sunset_str)  or 19.5
    windows     = solunar_windows(phase, sunrise_h, sunset_h)

    return {
        'grade'  : grade,
        'total'  : total,
        'scores' : scores,
        'details': {
            'pressure': press_val,
            'wind'    : wind_val,
            'moon'    : moon_val,
            'cloud'   : cloud_val,
            'temp'    : temp_val,
            'precip'  : precip_val,
        },
        'hi_f'   : hi_f,
        'lo_f'   : lo_f,
        'windows': windows,
    }


# ── Build calendar event ──────────────────────────────────────
def build_event(result: dict, forecast_date: date) -> dict:
    g       = result['grade']
    total   = result['total']
    windows = result['windows']
    details = result['details']
    scores  = result['scores']

    best_times = ', '.join(w.split('(')[0].strip() for w in windows[:2])
    title = f'🎣 Fishing Forecast: {g} | Best: {best_times}'

    grade_labels = {
        'A': 'Outstanding — Get out there!',
        'B': 'Good Conditions',
        'C': 'Fair — Worth a try',
        'D': 'Poor Conditions',
        'F': 'Stay Home Today',
    }

    lines = [
        f'Location  : {LOCATION}',
        f'Grade     : {g}  ({total}/100) — {grade_labels.get(g, "")}',
        f'Hi / Lo   : {result["hi_f"]} / {result["lo_f"]}',
        '',
        'Best Times to Fish:',
    ]
    for w in windows:
        lines.append(f'  - {w}')

    lines += [
        '',
        'Condition Breakdown:',
        f'  Pressure  : {details["pressure"]}  [{scores["pressure"]}/{WEIGHTS["pressure"]} pts]',
        f'  Wind      : {details["wind"]}  [{scores["wind"]}/{WEIGHTS["wind"]} pts]',
        f'  Moon      : {details["moon"]}  [{scores["moon"]}/{WEIGHTS["moon"]} pts]',
        f'  Cloud     : {details["cloud"]}  [{scores["cloud"]}/{WEIGHTS["cloud"]} pts]',
        f'  Temp      : {details["temp"]}  [{scores["temp"]}/{WEIGHTS["temp"]} pts]',
        f'  Precip    : {details["precip"]}  [{scores["precip"]}/{WEIGHTS["precip"]} pts]',
        '',
        'Generated by Fish Forecast — Nova Agent',
    ]

    today_str = forecast_date.isoformat()
    return {
        'summary'    : title,
        'description': '\n'.join(lines),
        'start'      : {'date': today_str},
        'end'        : {'date': today_str},
        'colorId'    : GRADE_COLOR.get(g, '1'),
        'reminders'  : {
            'useDefault': False,
            'overrides' : [{'method': 'popup', 'minutes': 0}],
        },
    }


# ── Google Calendar auth ──────────────────────────────────────
def get_credentials(force_reauth=False):
    """
    Auth strategy (in priority order):
      1. GOOGLE_TOKEN env var — full token JSON as a string (for GitHub Actions)
      2. token.json file — cached from a previous --auth run
      3. credentials.json — triggers interactive OAuth via console URL+code paste
    """
    creds = None

    # ── Strategy 1: env var (GitHub Actions / CI) ─────────────
    token_env = os.environ.get('GOOGLE_TOKEN')
    if token_env and not force_reauth:
        try:
            token_data = json.loads(token_env)
            creds = Credentials.from_authorized_user_info(token_data, SCOPES)
            print('   Auth: using GOOGLE_TOKEN env var')
        except Exception as e:
            print(f'   Warning: GOOGLE_TOKEN env var invalid ({e}), falling back to file')
            creds = None

    # ── Strategy 2: token.json file ───────────────────────────
    if not creds and os.path.exists(TOKEN_FILE) and not force_reauth:
        try:
            creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
            print(f'   Auth: using cached token ({TOKEN_FILE})')
        except Exception as e:
            print(f'   Warning: token.json invalid ({e}), re-authenticating')
            creds = None

    # ── Refresh if expired ────────────────────────────────────
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            print('   Auth: token refreshed')
            # Save refreshed token back to file
            with open(TOKEN_FILE, 'w') as f:
                f.write(creds.to_json())
        except Exception as e:
            print(f'   Warning: token refresh failed ({e}), re-authenticating')
            creds = None

    # ── Strategy 3: interactive OAuth via console ─────────────
    if not creds or not creds.valid:
        if not os.path.exists(CREDS_FILE):
            print('\n❌ ERROR: credentials.json not found.')
            print('   Download from: Google Cloud Console → APIs & Services → Credentials')
            print(f'   Expected at: {CREDS_FILE}')
            sys.exit(1)

        print('\n🔐 Google Calendar authorization required.')
        print('   Opening OAuth flow...\n')

        flow = InstalledAppFlow.from_client_secrets_file(CREDS_FILE, SCOPES)

        # Try run_local_server first (opens browser automatically).
        # If that fails (SSH/headless), fall back to manual copy-paste.
        try:
            creds = flow.run_local_server(port=0)
        except Exception:
            # Manual fallback: print URL, user pastes code back
            import webbrowser
            auth_url, _ = flow.authorization_url(prompt='consent')
            print('\n  Could not open browser automatically.')
            print('  Open this URL in your browser:\n')
            print(f'  {auth_url}\n')
            code = input('  Paste the authorization code here: ').strip()
            flow.fetch_token(code=code)
            creds = flow.credentials

        # Save token for future runs
        with open(TOKEN_FILE, 'w') as f:
            f.write(creds.to_json())
        print(f'\n✅ Token saved to {TOKEN_FILE}')
        print('   Copy token.json contents into GOOGLE_TOKEN secret for GitHub Actions.')
        print(f'   Contents:\n{creds.to_json()}\n')

    return creds


def find_existing_event(service, today_str: str, calendar_id: str = 'primary'):
    events = service.events().list(
        calendarId   = calendar_id,
        timeMin      = today_str + 'T00:00:00Z',
        timeMax      = today_str + 'T23:59:59Z',
        singleEvents = True,
        q            = 'Fishing Forecast',
    ).execute()
    items = events.get('items', [])
    return items[0] if items else None


# ── Main ──────────────────────────────────────────────────────
def get_calendar_id(service):
    """
    Find the 'Fish Forecast' calendar by name.
    Falls back to CALENDAR_ID env var, then 'primary'.
    """
    # If user explicitly set CALENDAR_ID env var (not default 'primary'), use it
    if os.environ.get('CALENDAR_ID') and os.environ.get('CALENDAR_ID') != 'primary':
        return os.environ['CALENDAR_ID']

    # Search for a calendar named 'Fish Forecast'
    calendars = service.calendarList().list().execute()
    for cal in calendars.get('items', []):
        if 'fish forecast' in cal.get('summary', '').lower():
            print(f'   Found calendar: {cal["summary"]} ({cal["id"]})')
            return cal['id']

    # Not found — create it
    print('   Creating Fish Forecast calendar...')
    new_cal = service.calendars().insert(body={
        'summary' : 'Fish Forecast',
        'timeZone': 'America/Chicago',
    }).execute()
    print(f'   ✅ Created calendar: {new_cal["id"]}')
    print(f'   Tip: set CALENDAR_ID={new_cal["id"]} to skip auto-detect next time')
    return new_cal['id']


def run(dry_run=False, force_reauth=False):
    today = date.today()
    print(f'\n🎣 Fish Forecast Calendar Sync — {datetime.now().strftime("%Y-%m-%d %H:%M")}')
    print(f'   Location : {LOCATION} ({LAT}, {LON})')
    print(f'   Fetching 7-day weather...')

    weather = fetch_weather(LAT, LON)

    if dry_run:
        print('\n[DRY RUN] 7-day forecast preview:\n')
        for i in range(7):
            from datetime import timedelta
            forecast_date = today + timedelta(days=i)
            result = grade_today(weather, forecast_date, day_index=i)
            event  = build_event(result, forecast_date)
            label  = 'TODAY' if i == 0 else forecast_date.strftime('%a %b %d')
            print(f'  {label}: {event["summary"]}')
        print()
        return

    if not GOOGLE_AVAILABLE:
        print('\n❌ ERROR: Google API libraries not installed.')
        print('   Run: pip install google-api-python-client google-auth-httplib2 google-auth-oauthlib')
        sys.exit(1)

    creds      = get_credentials(force_reauth=force_reauth)
    service    = build('calendar', 'v3', credentials=creds)
    calendar_id = get_calendar_id(service)
    print(f'   Calendar ID: {calendar_id}')

    from datetime import timedelta
    results = []
    for i in range(7):
        forecast_date = today + timedelta(days=i)
        result = grade_today(weather, forecast_date, day_index=i)
        event  = build_event(result, forecast_date)
        label  = 'Today' if i == 0 else forecast_date.strftime('%a %b %d')

        # Find existing event for this date
        existing = find_existing_event(service, forecast_date.isoformat(), calendar_id)

        if existing:
            updated = service.events().update(
                calendarId=calendar_id, eventId=existing['id'], body=event
            ).execute()
            print(f'   ✅ {label}: Updated — {result["grade"]} ({result["total"]}/100)')
        else:
            created = service.events().insert(
                calendarId=calendar_id, body=event
            ).execute()
            print(f'   ✅ {label}: Created — {result["grade"]} ({result["total"]}/100)')

        results.append(result)

    print(f'\n🎣 Done — 7 events written to Fish Forecast calendar')
    return results


def main():
    parser = argparse.ArgumentParser(description='Fish Forecast -> Google Calendar')
    parser.add_argument('--dry-run', action='store_true',
                        help='Preview without writing to calendar')
    parser.add_argument('--auth',    action='store_true',
                        help='Force re-authentication (ignores cached token)')
    args = parser.parse_args()
    run(dry_run=args.dry_run, force_reauth=args.auth)


if __name__ == '__main__':
    main()
