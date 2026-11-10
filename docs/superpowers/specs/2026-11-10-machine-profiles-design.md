# Machine profiles and homing support

**Date:** 2026-11-10
**Status:** Approved, pending implementation

## Problem

Kerf Studio targets one machine, the Ortur Laser Master 2 Pro. The owner also runs an
Atomstack A5 (2021 model) with aftermarket endstops, and wants to add further lasers
later without editing source.

Two assumptions in the current code block that:

1. **Machine identity is scattered.** Work area, max spindle, baud, rapid and
   acceleration already live in `S.settings` and are editable, but the machine's name is
   hardcoded in three places: the header badge (`index.html:60`), the G-code header
   (`app.js:851`) and the Bambu import's starting values (`app.js:946`). There is no way
   to keep two machines' settings side by side and switch between them.

2. **The work area is assumed to start at machine zero.** Export emits `G90` with
   `G92.1` (`gcode.js:216`), so absolute jobs run in raw machine coordinates, and the
   position readout uses `MPos` directly. This is correct only when homing leaves machine
   zero at the front-left of the bed. Ortur firmware does that. Stock GRBL does not: its
   convention puts machine zero at the **max** corner and the whole envelope at negative
   coordinates. On a machine with that convention, an absolute job drives the head off
   the front-left corner into the hard stop.

A third, smaller problem: the settings dialog tells the user that `$130`/`$131` "are read
from the controller when you connect". Nothing in the codebase ever sends `$$`. The
statement is false.

## The Atomstack A5 specifically

Endstops are fitted at the **X-min / Y-min (front-left)** corner. `$23` is still at its
default of `0`, which seeks positive — away from the switches — so `$H` has never
completed. The machine-side fix is `$23=3`.

What `$23=3` does **not** settle is where `MPos` reads zero afterwards. That depends on
whether the board's firmware was built with `HOMING_FORCE_SET_ORIGIN`:

| Firmware | `MPos` at front-left after `$H` | Work envelope |
|---|---|---|
| `HOMING_FORCE_SET_ORIGIN` (typical laser vendor build) | `0, 0` | `0..+W` |
| Stock GRBL | `-$130, -$131` | `-W..0` |

This cannot be determined from inspection. The design therefore **measures** it rather
than inferring it.

## Design

### Machine profiles

A new module, `js/machines.js`, owns machine identity. Built-in profiles ship in code;
user-created profiles persist to `localStorage` under `kerf.machines`, so adding a laser
needs no source change.

```js
{
  id: 'atomstack-a5',
  name: 'Atomstack A5',
  bedW: 410, bedH: 400,          // provisional until the $$ dump confirms
  maxS: 1000, baud: 115200,
  rapid: 6000, accel: 2500,
  originOffset: { x: 0, y: 0 },  // measured, see below
  hasHoming: true,
  expect: { 22: 1, 23: 3 },      // required for homing to work at all
  suggest: { 20: 1, 21: 1 },     // offered, never pre-ticked
}
```

`expect` and `suggest` are deliberately separate. `expect` holds values without which the
profile cannot function — for the A5, homing enabled and seeking the right direction.
`suggest` holds values that are a good idea but carry risk: hard limits (`$21`) on a
retrofit whose switch wiring runs unshielded alongside stepper cables invite nuisance
alarms mid-job, and soft limits (`$20`) are only safe once `$130`/`$131` are known
accurate. Suggestions appear in the reconcile dialog unticked, with the risk stated.

A profile holds **machine facts only**. Job preferences — `jobOrigin`, `returnHome`,
`jogFeed`, `jogStep`, `lockAspect`, `overscan` and the frame settings — stay global,
because they describe how the owner likes to work rather than what is plugged in. If any
of them later prove to differ per machine, they move then, not now.

The active profile id persists under `kerf.machine`.

**Migration.** An existing `kerf.settings` with no `kerf.machine` beside it is adopted as
the Ortur profile, with the stored values as overrides. Existing users see no change.

### Coordinate handling

`originOffset` is the machine coordinate of the **front-left corner of the work area**.
It is `0,0` for the Ortur and for any firmware that forces the origin at home. It is
`-bedW, -bedH` for stock-GRBL homing to the min corner.

The offset is **measured, not configured**. A `Set work origin to current position`
button in the settings dialog stores the current `MPos` verbatim as the offset. The
workflow is: home, jog the head to the front-left corner of the usable bed, click.

Capturing `MPos` directly is deliberate. An earlier draft of this spec had the button
subtract the `$27` pull-off from the post-homing `MPos`, but that formula is only correct
for one of the two firmware conventions — under `HOMING_FORCE_SET_ORIGIN` it returns
`-$27` where the correct answer is `0`. Capturing the position the operator has jogged to
is firmware-agnostic, needs no knowledge of homing direction or pull-off, and works
equally well if the operator wants design origin somewhere other than the bed corner.
This is how LightBurn's user origin behaves, so it should also feel familiar.

The transform applies at exactly two boundaries:

- **Emit.** `Writer._xy()` in `gcode.js` already subtracts a per-job origin (`this.ox`,
  `this.oy`) to support "start from current position". The machine offset folds into that
  same subtraction rather than adding a parallel mechanism. Exported `.gcode` therefore
  carries true machine coordinates and stays correct in any other sender.
- **Read.** A single `headPos()` helper in `app.js` reverses the offset for the position
  readout (`app.js:1103`), the canvas head marker (`app.js:309`) and the status bar.

**The offset must be suppressed when `origin === 'current'`.** In that mode the emitted
coordinates are relative to wherever the head already is, following a `G92 X0 Y0`, so
adding a machine offset would displace the job by the width of the bed. Concretely:
`offX = (opt.origin === 'current') ? 0 : profile.originOffset.x`.

Call sites requiring the transform:

| Site | Change |
|---|---|
| `gcode.js` `Writer` | fold offset into `_xy()`, absolute mode only |
| `gcode.js` `frame()` | offset `b.minx/maxx/miny/maxy` in the `G90` branch only; the `G91` branch is relative and needs none |
| `app.js` `goOrigin` | `G90 G0 X0 Y0` becomes `X{off.x} Y{off.y}` |
| `app.js` position readout | via `headPos()` |
| `app.js:880` bounds check | compare in design space, unchanged, but the warning must use profile bed size |

Relative jogs (`$J=G91`, `grbl.js:224`) need no transform.

### Reading and reconciling controller settings

`grbl.js` already emits a `setting` event for each `$N=v` line it sees (`grbl.js:180`).
Nothing consumes it and nothing ever sends `$$`. The work is to use what is there.

On connect, after the GRBL welcome banner:

1. Send `$$` and collect `setting` events until `ok`.
2. Store the map on the `Grbl` instance and expose it.
3. Adopt the machine's real `$30`, `$130`, `$131` into the live session. This makes the
   settings dialog's existing claim true.
4. Diff the remainder against the profile's `expect`.

Mismatches open a reconcile dialog with one row per value, offering **keep machine** or
**write profile value**.

Safety rules, which are not negotiable:

- Nothing is written without an explicit click. There is no auto-apply.
- Every previous value is logged to the console before the write, so it can be reverted
  by hand.
- `$100`–`$102` (steps/mm) are excluded from reconciliation entirely. They are
  calibration, not configuration, and rewriting them silently destroys dimensional
  accuracy.
- `$22=0` while the profile sets `hasHoming` is called out explicitly, because that is
  the A5's current state.

### UI

- The static `Ortur LM2 Pro` badge (`index.html:60`) becomes a profile picker, with
  **Add machine…** and **Duplicate current** at the foot of the list. Switching reloads
  the work area and redraws the bed.
- The settings dialog gains: profile name, the `originOffset` pair with its **Set origin
  from current position** button, and a `hasHoming` toggle that shows or hides the Home
  button.
- `machineName` in the G-code header follows the active profile.
- The Bambu import's Ortur starting values become per-profile.

## Testing

The app has no test framework and no build step. Pure functions get a small harness;
anything touching Web Serial or the DOM is verified on hardware.

**Unit, headless:** profile load/save/migration round-trips; `toMachine`/`fromMachine`
inverse property; offset correctly suppressed under `origin: 'current'`; `$$` dump
parsing including malformed lines; reconcile diff logic.

**Hardware, in sequence.** Homing an untested retrofit is the one genuinely risky step,
so verification comes before any cutting:

1. Connect. Capture the full `$$` dump and save it.
2. Write `$23=3`. Confirm it reads back.
3. Jog both axes clear of the switches.
4. Run `$H` with a hand on the power switch.
5. Read `?`. Record `MPos`. **This determines which firmware column applies.**
6. Calibrate the origin with the new button.
7. Jog to each bed corner and confirm the readout matches the frame rulers.
8. Frame a job at zero power. Confirm the rectangle lands where the canvas shows it.
9. Only then, cut scrap.

Regression check on the Ortur after every change: its `originOffset` is `0,0`, so
exported G-code must be **byte-identical** to what the current code produces. That is the
cheapest proof the transform is a no-op in the unchanged case.

## Out of scope

- A full `$` settings editor. Considered and rejected as disproportionate.
- Z axis, rotary and air assist.
- Per-machine layer presets beyond the Bambu import values.
- Automatic firmware detection. The measurement approach makes it unnecessary.
