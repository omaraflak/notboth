---
num: A.3
title: Library hygiene
---

Name parts after what they do, not how they work: `Mux16`, not
`BigSelectThing`. Group them into folders by Part as you go, so the list stays
navigable when it reaches forty entries.

When you improve a chip, edit it in place rather than making `Adder2` — every
circuit using it picks up the fix. And if you do end up with a genuinely
better rewrite alongside the original, swap the old one out wholesale rather
than rewiring by hand; that way the tool can tell you which connections will
not survive before anything breaks.
