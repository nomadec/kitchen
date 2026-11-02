# Glossary

## Kitchen

The factory: the shared work graph, the stations registered on it, the expeditor that starts them, and the pass where humans decide. The delivery loop is one recipe that runs inside it.

## Order

One unit of work from a source to its outcome. An order holds a sequence of phases and the passes between them. Umka called this a unit.

## Recipe

A graph of phases and passes that an order follows, with the rules for which phase follows which. Umka called this the phase registry.

## Phase

One step of a recipe, worked by one station in one turn. A phase is either worked without a human present or with one.

## Turn

One phase of one order, worked in one fresh session, ending in a result line.

## Pass

A point in a recipe where a human decides before the order continues. A pass holds a brief and closes with the human's word. Umka called this a checkpoint.

## Brief

The short description a station writes for a pass: what was done, what is asked, and the choices.

## Station

A registered agent role: what it can do, when to call it, who owns it, and how to start it. A station is cold until the expeditor starts it for a phase.

## Expeditor

The resident process on a host that watches the work graph, starts the stations registered on that host when a phase is ready for them, and keeps their leases alive. Umka called this the tick.

## Source

Where an order comes from: a tracker issue, a file, or free text.

## Tick

One pass of the expeditor over the work graph.

## Team space

The work graph every member and every station can read and write.

## Host

A machine that runs one expeditor and the stations registered on it.

## Launch spec

The part of a station that says how to start it: host, provider, model, how it signs in, what it loads, where it works, how many turns it may run at once, and its budget per turn. Secrets are named, never held.

## Router

The phase at intake that grades an order, picks the model tier for it, and assigns its first phase to a station.

## Space

One work graph: the beads database an order, a station and a pass live in. Kitchen has one team space.

## Delivery

The first recipe: the Umka phases carried over as they are.
