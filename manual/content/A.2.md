---
num: A.2
title: Debugging by bisection
---

When a large chip misbehaves, do not read the whole diagram. Put a probe
halfway along and ask one question: is the value here already wrong? That
halves the search. Repeat. Six probes will find a fault in a chip with sixty
components.

If the halfway point is correct and the output is wrong, you have eliminated
half your circuit without understanding any of it. That is the whole trick,
and it works just as well on the compiler in Part V as on the ALU in Part II.
