# NAND

A circuit editor for building a computer from nothing but NAND gates.

```bash
npm install
npm run dev
```

Then open http://localhost:5180.

---

## The manual

[`public/manual.html`](public/manual.html) is a build guide: thirty-nine stages,
in dependency order, each naming a part, its pins, why the machine needs it, and
how you will know it works. It deliberately does not give you the circuits.

It is served alongside the app at `/manual.html`, and the **Manual** button at
the bottom of the component library opens it. It has its own light/dark toggle,
independent of the editor's.

## The idea

Everything with logic in it is built out of one gate. NOT is a NAND with its
inputs tied together; AND is a NAND followed by a NOT; a flip-flop is two
NANDs feeding each other. You draw a circuit, name it, and it becomes a box you
can drop into the next circuit — all the way up to a CPU.

Unlike most teaching simulators, there is no built-in flip-flop. There does not
need to be: the simulator gives every NAND exactly one tick of propagation
delay, so a cross-coupled pair genuinely latches, for the same reason it does in
silicon.

## What is built in

| | |
|---|---|
| `Nand` | the one true gate — 1 bit, no settings, one tick of delay |
| `Clock` | square wave, period measured in ticks |
| `Toggle` | a switch you flip by clicking it |
| `Const` | a fixed 0 or 1, for tying an input high or low |
| `In` / `Out` | port markers that give the enclosing component its pins |
| `Probe` | a readout, in hex / binary / decimal / signed |
| `ROM` / `RAM` | backed by a real array, not by gates |

Nine primitives, and only one of them computes anything.

ROM and RAM are the one deliberate concession. A 16K-word memory built from
flip-flops would be roughly 2.4 million NAND gates, and real hardware does not
build it that way either — an SRAM cell is six transistors, not a netlist. Build
a register file out of NANDs once to prove you can, then use the primitive for
the real machine.

## Two editors, one component

Next to the component's name is a **Schematic / Text** switch. Both edit the
same thing — the schematic is canonical and the text is a second way in, not a
second source of truth.

```
# Not

in  a
out y

g1 : Nand(a = a, b = a)

y = g1.y
```

- `in name[width]` / `out name[width]` declare the component's pins.
- `label : Type(pin = source, ...)` places a part. Settings for the
  parameterised built-ins go in the same brackets — `c : Clock(period = 24)` —
  which is unambiguous because no primitive has a setting and a pin sharing a
  name.
- `target = source` connects things, where either side may be sliced:
  `out[7..0] = lo.result`. Driving separate ranges of one input is how you
  merge signals onto a bus.

**Order lives in the text, position lives on the canvas, and neither touches
the other.** Pin order and statement order come from the order things are
written, so reordering lines sticks. Where a box sits is pure presentation —
which is why there is an **Arrange schematic** button (in the inspector, or on
the canvas right-click menu) that redraws the whole picture without altering a
single character of the text. Reorder pins from the
schematic side with the arrows in a port marker's inspector.

The text saves itself, exactly as the schematic does — there is no Apply
button. Half a second after you stop typing, what you wrote becomes the
component.

Two properties make that safe. **Labels are identity**: a part whose label you
did not change keeps its id, its position on the canvas and any properties the
text does not mention, so a one-line edit never rearranges a schematic you laid
out by hand. And **nothing is committed until it parses** — a half-written line
is simply not saved, the last good version stands, and the problems are listed
with line numbers underneath until you finish it. The footer says which of the
two you are looking at.

Edits that change the text without changing the circuit — a comment, a blank
line, a column of spaces lined up — are recognised as such and cost neither an
undo step nor a recompile.

Newly typed parts are placed automatically, in columns by depth, so a component
written from scratch reads left to right when you switch back.

The text side is CodeMirror, for one feature above all: **several cursors at
once**. Renaming a signal that appears in eight lines is the commonest edit
there is here, and `Cmd/Ctrl D` puts a cursor on each occurrence so one keystroke
changes them all — and one undo puts them all back. `Alt`-click adds a cursor
anywhere, `Alt`-drag selects a column.

It is the only real dependency in the project and it is three times the size of
everything else, so it is fetched in its own chunk when the app goes idle rather
than before the first paint. The schematic never waits for it.

The one thing text does not carry is memory contents, because a ROM's program
is data rather than structure — it survives by identity, and you edit it from
the schematic.

**Comments do survive.** The text is regenerated from the schematic every time
it is shown, so a comment kept by line number would vanish the moment you drew
anything. They are kept by *what they were written about* instead — the part,
the port, or the connection they sit above — which is the same trick as labels
carrying identity. Draw a gate on the canvas and your notes are still where
you left them, above the right lines. A note on something you delete goes with
it; a note at the top or the bottom of the file stays there.

## Arranging a schematic

Position is presentation — it has no effect on what a circuit does — so
**Arrange schematic** is free to redraw everything. It is the standard layered
graph drawing, which is also just how a schematic is read:

- **Columns by depth.** A part sits in the column after the deepest thing
  feeding it, so signals flow left to right. Outputs get a column of their own
  at the right.
- **Order follows the wires.** Each column is sorted by where the parts feeding
  it ended up, swept forwards and backwards until it settles. This is the
  barycentre heuristic, and it is the difference between rows that line up with
  what drives them and a random stack.
- **Long wires get a lane.** A wire that skips a column would otherwise be
  drawn straight through whatever is standing there, so a slot is reserved for
  it in each column it crosses. The parts move apart to make room.

Feedback loops have no "first" gate, so they are laid out by breaking the tie
rather than by recursing forever. A latch is supposed to look like that.

## Buses

A pin is as many bits wide as you say, up to 32 — set **Bits** in a port
marker's inspector, or write `in a[16]` in the text view — and one wire carries
all of them. Select a wire and edit its bit range to slice a bus apart
(`out[3..0]`), or drive different ranges of the same input pin from different
sources to merge signals back together — there is no separate splitter
component because wire endpoints already do the job.

Dragging from a bus claims the lowest bits nothing has taken yet, so wiring
sixteen gates to a sixteen-bit input walks up the bus one drag at a time
instead of landing on bit zero every time. The same goes the other way: wiring
gate outputs into a wide `Out` fills it bit by bit. A gap left by a deleted
wire is taken back before the count moves on, and once a pin is full it starts
over at the bottom — which is what fan-out from a one-bit pin needs.

Buses exist only in the editor. At compile time the whole hierarchy is flattened
to single-bit nets and bare NAND gates, so nothing about them costs anything at
run time.

## Working with components

- **Click a component to place it**, exactly like a built-in. Double-click it —
  or right-click and choose *Edit this component* — to open it for editing.
- **Make a component out of a selection** — select some gates and right-click,
  or use the *Make component* button in the inspector, or press `Cmd/Ctrl G`. Wires that crossed the selection
  boundary become the new component's pins, and an instance drops back into the
  hole it left. The circuit behaves identically afterwards.
- **Instances are references.** Fix a bug in `ALU` and every circuit using it is
  fixed. There is no id to manage and nothing to re-link.
- **Replace all uses** swaps every instance of one component for another, matching
  pins by name, and tells you up front which wires will not survive.
- **Deleting a component that is in use** offers to replace it instead.
- Components live in folders. Drag one onto a folder to move it.

## Tests

Every component can carry a table of input vectors and expected outputs, run
from the inspector or the component's menu. Vectors reference pins by id, so
renaming a port never breaks them; if a column ever fails to match a pin, the
runner says which one rather than quietly failing. Arrow keys move between
cells and Enter steps down a row, so a truth table can be typed without
reaching for the mouse.

This is not optional equipment. By the time the library has thirty components, a
single wrong wire inside an adder is invisible from the outside and will surface
as "my CPU computes the wrong thing." Truth tables find it in seconds. Write
them as you go.

## Running the machine

The power button compiles the whole hierarchy and starts the clock. The speed
slider runs from one tick per second — slow enough to watch a carry ripple
across an adder — up to as many ticks as a frame allows. Step advances exactly
one tick.

Wires light up when they carry current. Colour is yours to choose; brightness
belongs to the simulator.

Wires are routed together rather than one at a time, against a map of what the
schematic has already committed to. Every run remembers which *signal* put it
there, and space is only contested between different signals — everything
driven by the same pin shares a trunk, because overlapping there is honest.
**So two lines running along each other always means one signal**, and where a
branch leaves a trunk mid-run there is a junction dot; a crossing without a dot
is two signals passing, not joining.

Parts go into the same map, as space to keep out of, which means routing around
a gate and routing around another signal are the same search. A run with
nowhere clear to go steps off its own row rather than being drawn on top of
something: two extra bends is a smaller price than two wires that look like
one.

If a circuit oscillates — a NAND driving its own input, or a latch with no
defined initial state — the status bar says so rather than hanging.

## Loading a program

Select a ROM, press **Edit program**, and paste or load machine code. Hex,
binary and decimal all work, `//` comments are ignored, and a program dropped in
while the machine is running takes effect without a reset.

Writing the assembler that produces those words is a separate project, and
arguably the better half of the fun.

## Keyboard

| | |
|---|---|
| Pan / zoom | space-drag or scroll / `Cmd`-scroll |
| Fit to circuit | `Shift F` |
| Wire | drag output pin → input pin |
| Unwire | drag away from the input pin being fed |
| Place a component | click it in the library, then click the grid |
| Edit a component | double-click it in the library, or its box on the canvas |
| Make a component | select parts, then right-click — or `Cmd/Ctrl G` |
| Switch editor | Schematic / Text, next to the component name |
| Add a cursor at the next occurrence | `Cmd/Ctrl D`, then type to change them all |
| Add a cursor above / below | `Cmd/Ctrl Alt` `↑` / `↓` |
| Add a cursor anywhere | `Alt`-click; `Alt`-drag for a column |
| Select every occurrence at once | `Cmd/Ctrl Shift L` |
| Find | `Cmd/Ctrl F` |
| Comment out | `Cmd/Ctrl /` |
| Move / copy a line | `Alt` `↑``↓` / `Shift Alt` `↑``↓` |
| Select all / copy / paste / duplicate | `Cmd/Ctrl` + `A` / `C` / `V` / `D` |
| Undo / redo | `Cmd/Ctrl Z` / `Shift Cmd/Ctrl Z` |
| Power on/off | `Cmd/Ctrl Enter` |
| Nudge selection | arrow keys |
| Place several | hold `Shift` while placing |

## Storage

Projects live in the browser's IndexedDB and save as you work. Nothing is
uploaded anywhere; there is no server behind this. Export any project to JSON
from the projects dialog to back it up or put it in git.

On startup the app asks the browser for *persistent* storage, because the
default is best-effort: Safari clears script-written storage after seven days
without a visit, and any browser may clear it under disk pressure. Browsers
grant the request at their own discretion, so an export is still the only real
backup — and since storage is per-origin, work done on `localhost` does not
follow you to the deployed site.

## Deploying

The build is entirely static, so any static host will do. On Cloudflare Pages:

| | |
|---|---|
| Build command | `npm run build` |
| Output directory | `dist` |
| Node version | from `.nvmrc` (22) |

No environment variables, no functions, no database.

## Layout of the code

```
src/core/     no DOM anywhere in here, and fully unit-tested
  types.ts      the data model
  primitives.ts the nine built-ins
  project.ts    components, folders, replace-all-uses
  compile.ts    hierarchy -> flat NAND netlist, via union-find
  sim.ts        event-driven simulator, uniform unit delay
  autolayout.ts arranging a schematic: columns, order, and lanes
  extract.ts    selection -> new component
  hdl.ts        component <-> text, round-tripping identity and layout
  layout.ts     box geometry and wire routing (pure, so it is testable)
  testbench.ts  the vector runner
  storage.ts    IndexedDB, import/export

src/ui/       canvas renderer and panels; no framework
  editor.ts     CodeMirror, behind a facade so it can load on demand
  hdl-lang.ts   syntax highlighting for the text form
src/style.css every colour in the app, light and dark, in two blocks
```

To reskin the app, edit the two palette blocks at the top of `style.css`. The
canvas reads the same custom properties, so nothing else needs to change.

```bash
npm test          # 92 correctness tests, under a second
npm run test:perf # 15 stress tests, about ten seconds
npm run test:all
npm run build
```

The stress suite exists to catch *algorithmic* regressions rather than to
benchmark a laptop, so its assertions are mostly about how a cost scales rather
than about absolute milliseconds. The compiler really did go quadratic once —
a linear scan per wire endpoint, seven seconds to compile 20,000 gates — and
that is the class of bug those tests are there to catch.

Representative output:

```
compile     3,000 gates (137/ms) -> 60,000 gates (85/ms)
throughput  69.7M gate-updates/sec, 5,000 gates all flipping
idle cost   11 ns/tick with 50,000 settled gates
footprint   20.0 bytes per gate
edit loop   82ms worst-case recompile of a 10,000-gate circuit
memory      2,000 clocked writes into a 65,536-word RAM in 5ms
sequential  200 NAND-built flip-flops, 199 clock cycles in 8ms
```

That third line is the one that matters: work is proportional to activity, not
to circuit size. A large but quiescent machine costs essentially nothing per
tick, which is what makes a NAND-built computer practical to run at all.
