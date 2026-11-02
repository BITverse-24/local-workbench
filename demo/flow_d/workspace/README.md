# FieldOps Work Orders

A small browser app for an operations team. It shows work orders, filters by status and search text, and lets an operator change a work order's status.

## Run

Run `npm test` to run the project checks. To use the app, run `python3 -m http.server 4173` from this directory and open `http://localhost:4173`.

## Project map

- `src/seed.js` holds the starter work orders.
- `src/storage.js` reads and writes browser storage.
- `src/work-orders.js` filters and updates work orders.
- `src/app.js` connects the page controls to the data modules.
- `tests/` checks filtering and storage behavior with Node's built-in test runner.
