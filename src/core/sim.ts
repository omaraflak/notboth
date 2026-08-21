import type { Netlist } from './compile';

/**
 * Event-driven simulator with uniform unit delay.
 *
 * Every NAND takes exactly one tick to propagate. That uniformity is what
 * makes a NAND feedback loop latch deterministically -- it is the reason an
 * SR latch built from two cross-coupled NANDs actually works here -- and it
 * also keeps the event queue a flat FIFO ring instead of a priority queue.
 *
 * Gates are only re-evaluated when one of their inputs changed, so an idle
 * hundred-thousand-gate machine costs nothing per tick.
 */
export class Simulator {
  readonly nl: Netlist;
  readonly net: Uint8Array;

  private queue: Int32Array;
  private inQueue: Uint8Array;
  private qLen = 0;

  private chgNet: Int32Array;
  private chgVal: Uint8Array;

  /** RAM/ROM contents, one array per memory node. */
  private memData: Int32Array[] = [];
  private memPrevClk: Uint8Array;
  private memDirty: Uint8Array;
  private dirtyMems: number[] = [];
  private memFanoutStart: Int32Array;
  private memFanout: Int32Array;

  private clockPhase: Uint8Array;
  private clockHalf: Int32Array;

  tick = 0;
  /** Set when a settle() run hit its iteration cap: the circuit oscillates. */
  unstable = false;

  constructor(nl: Netlist) {
    this.nl = nl;
    this.net = new Uint8Array(nl.netCount);
    this.queue = new Int32Array(Math.max(1, nl.gateCount));
    this.inQueue = new Uint8Array(Math.max(1, nl.gateCount));

    let memBits = 0;
    for (const m of nl.mems) memBits += m.data.length;
    const chgCap = Math.max(1, nl.gateCount + memBits + nl.clocks.length + 64);
    this.chgNet = new Int32Array(chgCap);
    this.chgVal = new Uint8Array(chgCap);

    this.memPrevClk = new Uint8Array(nl.mems.length);
    this.memDirty = new Uint8Array(nl.mems.length);
    for (const m of nl.mems) {
      const words = 1 << m.addrWidth;
      const arr = new Int32Array(words);
      for (let i = 0; i < Math.min(words, m.contents.length); i++) arr[i] = m.contents[i] | 0;
      this.memData.push(arr);
    }

    // CSR index: net -> memories that read it.
    const counts = new Int32Array(nl.netCount + 1);
    const inputsOf = (i: number): number[] => {
      const m = nl.mems[i];
      const list = [...m.addr];
      if (m.kind === 'RAM') { list.push(...m.din, m.load, m.clk); }
      return list.filter((n) => n >= 0);
    };
    for (let i = 0; i < nl.mems.length; i++) for (const n of inputsOf(i)) counts[n]++;
    this.memFanoutStart = new Int32Array(nl.netCount + 1);
    let acc = 0;
    for (let n = 0; n < nl.netCount; n++) { this.memFanoutStart[n] = acc; acc += counts[n]; }
    this.memFanoutStart[nl.netCount] = acc;
    const cursor = this.memFanoutStart.slice(0, nl.netCount);
    this.memFanout = new Int32Array(acc);
    for (let i = 0; i < nl.mems.length; i++) {
      for (const n of inputsOf(i)) this.memFanout[cursor[n]++] = i;
    }

    this.clockPhase = new Uint8Array(nl.clocks.length);
    this.clockHalf = new Int32Array(nl.clocks.length);
    nl.clocks.forEach((c, i) => { this.clockHalf[i] = Math.max(1, Math.floor(c.period / 2)); });

    this.reset();
  }

  reset() {
    this.tick = 0;
    this.unstable = false;
    this.net.fill(0);
    this.qLen = 0;
    this.inQueue.fill(0);

    const nl = this.nl;
    // Queue every gate first. writeNets() below wakes gates through the same
    // guarded path, so seeding the queue up front keeps each gate in it once.
    for (let g = 0; g < nl.gateCount; g++) { this.queue[this.qLen++] = g; this.inQueue[g] = 1; }

    for (let i = 0; i < nl.constNets.length; i++) this.net[nl.constNets[i]] = nl.constVals[i];
    for (const t of nl.toggles) this.writeNets(t.nets, t.value);

    for (let i = 0; i < nl.mems.length; i++) {
      const m = nl.mems[i];
      const words = 1 << m.addrWidth;
      this.memData[i].fill(0);
      for (let a = 0; a < Math.min(words, m.contents.length); a++) this.memData[i][a] = m.contents[a] | 0;
      this.memPrevClk[i] = 0;
    }
    this.clockPhase.fill(0);
    this.memDirty.fill(1);
    this.dirtyMems = nl.mems.map((_, i) => i);
  }

  /** One unit of simulated time. */
  step(freezeClocks = false) {
    const nl = this.nl;
    const { gA, gB, gY } = nl;
    const net = this.net;
    let cLen = 0;

    // 1. Re-evaluate every gate whose input moved last tick.
    const n = this.qLen;
    for (let i = 0; i < n; i++) {
      const g = this.queue[i];
      this.inQueue[g] = 0;
      const v = 1 - (net[gA[g]] & net[gB[g]]);
      if (v !== net[gY[g]]) { this.chgNet[cLen] = gY[g]; this.chgVal[cLen] = v; cLen++; }
    }
    this.qLen = 0;

    // 2. Memories. Reads are asynchronous; RAM writes on the rising clk edge.
    if (this.dirtyMems.length) {
      const pending = this.dirtyMems;
      this.dirtyMems = [];
      for (const mi of pending) {
        this.memDirty[mi] = 0;
        const m = nl.mems[mi];
        const data = this.memData[mi];
        if (m.kind === 'RAM') {
          const clk = net[m.clk];
          if (clk === 1 && this.memPrevClk[mi] === 0 && net[m.load] === 1) {
            data[this.readNets(m.addr)] = this.readNets(m.din) | 0;
          }
          this.memPrevClk[mi] = clk;
        }
        const word = data[this.readNets(m.addr)] | 0;
        for (let b = 0; b < m.data.length; b++) {
          const v = (word >>> b) & 1;
          if (v !== net[m.data[b]]) { this.chgNet[cLen] = m.data[b]; this.chgVal[cLen] = v; cLen++; }
        }
      }
    }

    // 3. Clocks.
    this.tick++;
    if (!freezeClocks) {
      for (let i = 0; i < nl.clocks.length; i++) {
        if (this.tick % this.clockHalf[i] !== 0) continue;
        const v = this.clockPhase[i] ^ 1;
        this.clockPhase[i] = v;
        const netIdx = nl.clocks[i].net;
        if (net[netIdx] !== v) { this.chgNet[cLen] = netIdx; this.chgVal[cLen] = v; cLen++; }
      }
    }

    // 4. Apply atomically, then wake whatever reads the changed nets.
    for (let i = 0; i < cLen; i++) {
      const netIdx = this.chgNet[i];
      net[netIdx] = this.chgVal[i];
      this.wake(netIdx);
    }
  }

  private wake(netIdx: number) {
    const { fanoutStart, fanout } = this.nl;
    for (let k = fanoutStart[netIdx], end = fanoutStart[netIdx + 1]; k < end; k++) {
      const g = fanout[k];
      if (!this.inQueue[g]) { this.inQueue[g] = 1; this.queue[this.qLen++] = g; }
    }
    for (let k = this.memFanoutStart[netIdx], end = this.memFanoutStart[netIdx + 1]; k < end; k++) {
      const mi = this.memFanout[k];
      if (!this.memDirty[mi]) { this.memDirty[mi] = 1; this.dirtyMems.push(mi); }
    }
  }

  get busy(): boolean {
    return this.qLen > 0 || this.dirtyMems.length > 0;
  }

  run(ticks: number, freezeClocks = false) {
    for (let i = 0; i < ticks; i++) this.step(freezeClocks);
  }

  /**
   * Run until nothing is left to propagate. Returns false if the cap was hit,
   * which means the circuit oscillates (a NAND driving its own input, say).
   */
  settle(maxTicks = 10000, freezeClocks = true): boolean {
    for (let i = 0; i < maxTicks; i++) {
      if (!this.busy) return true;
      this.step(freezeClocks);
    }
    const stable = !this.busy;
    if (!stable) this.unstable = true;
    return stable;
  }

  /* -------------------------------------------------------------- *
   * Reading and driving
   * -------------------------------------------------------------- */

  readNets(nets: number[]): number {
    let v = 0;
    for (let i = 0; i < nets.length; i++) if (this.net[nets[i]]) v |= 1 << i;
    return v >>> 0;
  }

  /** Force nets to a value and wake their readers. */
  writeNets(nets: number[], value: number) {
    for (let i = 0; i < nets.length; i++) {
      const v = (value >>> i) & 1;
      const netIdx = nets[i];
      if (this.net[netIdx] !== v) { this.net[netIdx] = v; this.wake(netIdx); }
    }
  }

  setToggle(index: number, value: number) {
    const t = this.nl.toggles[index];
    if (!t) return;
    t.value = value >>> 0;
    this.writeNets(t.nets, t.value);
  }

  memWord(index: number, addr: number): number {
    return this.memData[index]?.[addr] ?? 0;
  }

  /** Replace a memory's contents in place, e.g. after editing a ROM. */
  loadMemory(index: number, words: number[]) {
    const data = this.memData[index];
    if (!data) return;
    data.fill(0);
    for (let i = 0; i < Math.min(data.length, words.length); i++) data[i] = words[i] | 0;
    if (!this.memDirty[index]) { this.memDirty[index] = 1; this.dirtyMems.push(index); }
  }

  memSnapshot(index: number): Int32Array | undefined {
    return this.memData[index];
  }
}
