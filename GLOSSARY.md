# Glossary

## Kitchen

The runtime: one shared work graph, the phases and stations registered on it, the expeditor that starts stations, and the pass where humans decide. Kitchen holds no recipe of its own; every recipe is registered into it.

## Order

One unit of work from a source to its outcome. An order names the repositories it touches, carries a class, and walks a path of phases and passes. Umka called this a unit.

## Recipe

A bundle of phases that one plugin registers in one act. The space holds one phase graph, and an edge may lead from a phase of one recipe to a phase of another. Umka called this the phase registry.

## Revision

One version of a registered recipe, named by a short hash of its content. Re-registering a recipe creates a new revision and marks the old one superseded. An order pins the latest revision of its recipe at intake, and pins another recipe's latest revision when an edge crosses into it, so re-registering never changes the path of an order already walking.

## Phase

One step of work: the skill it runs, the model it wants, what it needs, its budget, how many rounds it may run in one order, what it produces, and the rules for which phases may follow. A phase is registered into the space and worked by one station in one turn.

## Entry phase

The phase whose `entry` lists the class an order enters with. Intake lays it first, from the recipe and not from a rule inside Kitchen. A recipe has one entry phase per class it claims, and an entry phase has no prose needs.

## Turn

One phase of one order, worked in one fresh session, ending in a result line.

## Take

The claim a turn holds on its order for as long as it runs, under the station actor, so that one order has at most one turn at a time on any host. The expeditor takes the order before it claims the phase and releases the take when the turn ends. A phase whose order is taken waits for the next tick; a phase on an attended station is labelled `waiting` instead and starts on the human's word.

## Pass

A point where a human decides before the order continues. A pass holds a brief and closes with the human's word. It is laid only when a human is needed. Umka called this a checkpoint.

## Brief

The short description a station writes for a pass: what was done, what is asked, and the choices.

## Station

A registered, prepared place where turns run: a host, the repositories checked out there, the plugins and tooling present, the models it can launch, how many turns it runs at once, and whether a human sits there. A station is owned by one person. A phase goes to a station that offers what the phase and its order need.

## Expeditor

The resident process on a host that watches the work graph, starts the stations registered on that host when a phase is ready for them, keeps their leases alive, and evaluates the typed waits. An attended station starts a turn only on the human's word. Umka called this the tick.

## Source

Where orders come from: a tracker, a file, or free text. A polled source is registered into the space with its cursor and is polled by its owner's expeditor.

## Tick

One pass of the expeditor over the work graph.

## Shared space

A space every member and every station can read and write: a database on a Dolt SQL server every host of the team points at. The team has one.

## Local space

A space of one host's own: an embedded beads workspace under that host's config, with no server to join and no credential. Every command and the UI work against it as against a shared space; a second host cannot point at it, and a station handoff across hosts needs a shared space.

## Host

A machine that runs one expeditor and the stations registered on it.

## Launch spec

The part of a station that says how to start a turn: provider, the models it can launch, how it signs in, what it loads, where each repository is checked out, how many turns it may run at once, and its budget per turn. Secrets are named, never held.

## Space

One work graph: the beads database an order, a station and a pass live in. A host has one space, shared or local.

## Registration

The human act of adding a recipe, a station or a source to a space. A running station cannot register anything.

## Path

The sequence of phases one order walks through the graph. A path is read from the graph, not registered. An order may walk several paths in its life.

## Class

What an order currently is: unsorted (from a source that sorts nothing), a question, an idea, a proposal, a spec, a ticket or a bug. The turn that moves an order onto another path updates its class.

## Turn driver

The one plugin Kitchen ships. In a station's session it reads the phase, runs its skill, reconciles, judges the rules for what follows, lays the next phases and ends with the result line.

## Umka recipe

The first recipe: Umka's phases, registered into a kitchen from the Umka plugin.

## Actor

Who made a write. A person writes as their name. A turn writes as the owner and the station, and the expeditor as the owner and the word expeditor. A pass closes only under a person's name. The actor rules are cooperative and not a security boundary; ADR 0003 says where that limit lies.
