---
num: A.1
title: When it will not settle
---

A circuit that reports oscillating is telling you something specific: some
loop of gates has no stable answer. Three usual causes. You have accidental
feedback — a signal reaching backwards into something that feeds it. You have
a genuine latch that started symmetric, in which case it is behaving correctly
and needs a defined initial state. Or your clock is faster than the logic it
drives, so the next edge arrives before the last one has finished propagating.

Slow the clock right down first. Most of the time the answer becomes obvious
the moment you can watch it happen.
