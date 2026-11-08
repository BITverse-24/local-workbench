**Chat type:** work

**Files to attach:**
- `sensor-telemetry.csv`

Analyze the attached multi-station sensor telemetry log:
1. For each station (STATION-A, STATION-B, STATION-C, STATION-D), compute:
   - Total reading count
   - Average temperature (°C) rounded to 2 decimal places using `round(avg(...), 2)`
   - Average pressure (psi) rounded to 2 decimal places
   - Median vibration (g) using `median(...)`
   - Minimum and maximum temperature (°C)
2. Identify all anomalies where `temperature_c > 85.0` (High Temp) OR `vibration_g > 4.5` (High Vibration).
3. Export an `anomaly-register.csv` with columns: `timestamp,station_id,temperature_c,pressure_psi,vibration_g,reason`.
4. State the total number of detected anomalies and list which station had the highest peak temperature.
