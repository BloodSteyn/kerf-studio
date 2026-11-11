# Atomstack A5 bring-up checklist

For the A5 with endstops retrofitted at the **front-left** corner. Work through it in
order. Steps 1–6 involve no laser power at all; nothing burns until step 9.

Keep a hand near the power switch for step 5. That is the only step where the machine
moves without you having told it exactly where to go.

---

## 1. Capture the current settings

Connect in Kerf Studio, open the **Console**, and send:

```
$$
```

Copy the whole dump into a file and keep it. If anything goes wrong later this is how you
put the machine back exactly as it was.

**Record these four:**

| Setting | Meaning | Your value |
|---|---|---|
| `$22` | Homing cycle enabled | |
| `$23` | Homing direction mask | |
| `$130` | X max travel | |
| `$131` | Y max travel | |

Expect `$22=0` and `$23=0` before you start.

## 2. Enable homing and set the direction

With the **Atomstack A5** profile selected, Kerf Studio should offer these on connect in
the reconcile dialog. You can also send them by hand:

```
$22=1
$23=3
```

`$23=3` inverts both X and Y so homing seeks **negative** — toward your switches. Leaving
it at `0` sends the head the other way, into the far end of the rails.

Leave `$20` and `$21` alone for now. Hard limits on retrofit wiring can trip on
interference from the stepper cables, and you do not want to be diagnosing that and
homing at the same time.

**Verify it took:**

```
$$
```

Check `$22=1` and `$23=3` in the output. GRBL settings persist to EEPROM, so this only
needs doing once.

## 3. Test the switches before trusting them

Send `?` and look at the `Pn:` field in the status report. Press each switch by hand and
send `?` again.

- Pressing the X switch should make `Pn:X` appear.
- Pressing the Y switch should make `Pn:Y` appear.
- With nothing pressed there should be no `Pn:` field at all.

**If a switch shows as triggered when it is not pressed,** the wiring is inverted. Fix it
with `$5` (limit pin invert) rather than rewiring. **If a switch never shows,** it is not
connected to the pin GRBL is watching — stop here and sort the wiring out. Homing into a
switch the controller cannot see will drive the head into the frame at full force.

## 4. Jog clear

Jog both axes 20–30 mm away from the switches. Homing starts by seeking, and if the head
is already sitting on a switch the cycle can behave oddly.

## 5. The first homing cycle

Hand near the power switch. Press **Home**, or send:

```
$H
```

**What should happen:** both axes move toward the front-left, touch the switches, back
off by the pull-off distance, and the state goes to `Idle`.

**Kill the power immediately if** the head moves *away* from the switches, or if it
reaches a switch and keeps pushing. Away from the switches means `$23` did not take —
go back to step 2. Pushing through means the controller is not seeing that switch — go
back to step 3.

## 6. Read the machine position

This is the step that determines everything else. Send:

```
?
```

Read the `MPos:` values and compare:

| What you see | What it means | What to do |
|---|---|---|
| `MPos:0.000,0.000` or close to it | Firmware forces the origin at home. Your work area already runs `0..+W`. | Leave the work origin at `0, 0`. You are done with coordinates. |
| `MPos:-410.000,-400.000` or similar large negatives | Stock GRBL convention. Machine zero is at the far corner and the bed runs negative. | Continue to step 7. |

Either outcome is fine and both are fully supported. You just need to know which you have.

## 7. Set the work origin

Only needed if step 6 showed large negative numbers.

Jog the head to the **front-left corner of the usable bed** — where you want design
coordinate `0, 0` to be. Then open **Settings** and click **Set work origin to current
position**, and **Save**.

The position readout should now show roughly `X 0.00 Y 0.00` at that corner.

## 8. Check the corners, with the laser off

Jog to each corner of the bed in turn and compare the readout against the rulers on the
frame rails.

- Front-left should read about `0, 0`.
- Front-right should read about `$130, 0`.
- Back-left should read about `0, $131`.

**If a sign is flipped** — a corner reading negative where it should be positive — the
work origin is set to the wrong corner. Go back to step 7.

Then draw a rectangle somewhere in the middle of the canvas and press **Frame** with
*Fire laser at low power while framing* turned **off**. The head should trace a rectangle
in the position the canvas shows. This is the real test of the whole coordinate chain,
and it costs nothing if it is wrong.

## 9. First burn

Put scrap in. Something forgiving — 3 mm ply or cardboard.

Start conservative: the A5's starting values in the profile are a guess until you have
burned a test grid. Run a small square at low power first, confirm the size with calipers,
and only then trust the numbers.

**If the dimensions are off** — a 30 mm square measuring 29 or 31 — that is steps-per-mm
(`$100`/`$101`), not anything in this checklist. Kerf Studio deliberately never writes
those: they are calibration, and getting them wrong quietly ruins every job afterwards.
Calculate the correction by hand and send it from the Console.

---

## Optional, once homing is reliable

```
$20=1
$21=1
```

`$21` turns on hard limits, so a switch triggering mid-job halts the machine. `$20` turns
on soft limits, which refuse moves outside `$130`/`$131` before the machine moves at all.

Enable `$21` only after a few jobs have run without a spurious trigger, and `$20` only
once you have confirmed `$130` and `$131` match the real travel. Soft limits computed from
wrong travel values are worse than none, because they will reject legitimate jobs while
you look for the fault somewhere else.
