# Ohio Rentals — Fleet & Rental Tracker

A simple, self-contained web app for tracking an equipment rental fleet. No
server, no install — open `index.html` in any modern browser and start using it.
All data is saved in your browser's local storage.

## What it does

- **Equipment list** — every piece of equipment with its unit ID, type, current
  location/customer, when it's due back, and maintenance status.
- **Rentals** — schedule new rentals with destination, time out, and scheduled
  time in. Edit or check in any rental.
- **Pre-rental & return checklists** — every rental has a customizable
  checklist for going out and coming back. Items can be edited, added, removed.
- **Schedule view** — Gantt-style timeline showing what's out, what's coming up,
  filterable by equipment and date range. Lets you see when a piece (or
  another piece of the same type) becomes available.
- **Maintenance** — flag equipment as down, write up what's wrong, mark it
  serviced. Service history is kept. Equipment with upcoming maintenance shows
  on the dashboard.
- **Conflict warnings** — if you try to schedule a piece that's already booked,
  the app warns you before saving.
- **Dashboard** — at-a-glance counts (Available, Out, Scheduled, Overdue,
  Needs Maintenance, Checklists Due) plus an "Attention Needed" list.
- **Backup / restore** — Export all data as JSON, import it on another device
  or browser.

## Getting started

1. Open `index.html` in Chrome, Edge, Firefox, or Safari.
2. The app starts with a few sample pieces of equipment so you can see the
   layout. Edit/delete them and add your own.
3. Click **+ Add Equipment** to add real fleet items.
4. Click **+ New Rental** (or the **Rent** button on a row) to schedule a job.
5. When the equipment comes back, open the rental and click **Check In Now**,
   or use the **Check In** button on the Rentals table.

## Where data is stored

In your browser's `localStorage` under the key `ohio-rentals:v1`. To move data
to another device or share it with the office, use **Export** to download a
JSON backup, then **Import** it on the other device.

> Note: clearing your browser cache for this site will erase the data. Export
> regularly if you depend on it.

## Files

- `index.html` — markup and views
- `styles.css` — styling
- `app.js` — all logic (data, render, forms)
