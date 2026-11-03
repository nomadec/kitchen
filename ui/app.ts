// The page in the browser: four views, Pass, Orders, Stations and Activity, chosen by the location
// hash (`#pass`, `#orders`, `#stations`, `#activity`) so each is a link a phone can bookmark. The
// token is asked for once and kept in local storage, the owner read from the expeditor's /me.
// Everything that talks to bd serve is in the view modules; this file only draws.
import { activityView } from "./activity.ts";
import type { JournalEntry } from "./activity.ts";
import { ViewError } from "./client.ts";
import type { ClientDeps } from "./client.ts";
import { ordersView } from "./orders.ts";
import type { OrderGroup, OrderRow } from "./orders.ts";
import { passView } from "./passes.ts";
import type { Pass } from "./passes.ts";
import { stationsView } from "./stations.ts";
import type { StationPhase, StationRow } from "./stations.ts";

const TOKEN_KEY = "kitchen.token";

type View = "pass" | "orders" | "stations" | "activity";

/** What the browser holds once the token is in: the way to bd serve, and the owner every answer is written as. */
interface Session extends ClientDeps {
  owner: string;
}

const app = document.getElementById("app") as HTMLElement;
const meLine = document.getElementById("me") as HTMLElement;
const heading = document.querySelector("header h1") as HTMLElement;
const nav = document.querySelector("header nav") as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

function notice(text: string, kind: "notice" | "error" = "notice"): HTMLElement {
  return el("p", { class: kind === "error" ? "notice error" : "notice" }, text);
}


/** The owner the expeditor serves for: what every answer is written as. */
async function whoAmI(): Promise<{ owner: string; host: string }> {
  const response = await fetch("/me");
  if (!response.ok) throw new Error(`the expeditor did not say who it serves for (${response.status})`);
  return (await response.json()) as { owner: string; host: string };
}

function askForToken(message?: string): void {
  app.replaceChildren();
  if (message) app.append(notice(message, "error"));
  const input = el("input", { type: "password", name: "token", placeholder: "the token from serve.token", autocomplete: "off", required: "" });
  const form = el("form", { class: "token" }, input, el("button", { type: "submit" }, "Use token"));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    localStorage.setItem(TOKEN_KEY, input.value.trim());
    void render();
  });
  app.append(
    notice("Paste the bearer token the expeditor wrote to ~/.local/state/kitchen/serve.token on this host. It stays in this browser; the UI never holds the SQL credential (docs/ui.md)."),
    form,
  );
}

function passCard(pass: Pass, answer: (pass: Pass, word: string) => Promise<void>): HTMLElement {
  const input = el("input", { type: "text", name: "word", placeholder: "your word, e.g. ship", autocomplete: "off", required: "" });
  const button = el("button", { type: "submit" }, "Answer");
  const form = el("form", {}, input, button);
  const card = el(
    "article",
    { class: "pass", "data-pass": pass.id },
    el("h2", {}, pass.title),
    el("p", { class: "order" }, `${pass.order.title ?? "an order"} (${pass.order.id || "no order"}) · ${pass.id}${pass.laidBy ? ` · laid by ${pass.laidBy}` : ""}`),
    el("p", { class: "brief" }, pass.brief || "(no brief)"),
    form,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
      await answer(pass, input.value);
    } catch (error) {
      button.disabled = false;
      card.querySelector(".notice")?.remove();
      card.append(notice(error instanceof Error ? error.message : String(error), "error"));
    }
  });
  return card;
}

async function drawPasses(session: Session): Promise<Node[]> {
  const view = passView({ ...session, actor: session.owner });
  const passes = await view.list();
  if (passes.length === 0) return [el("p", { class: "empty" }, "No open pass: nothing waits on you.")];
  return passes.map((pass) =>
    passCard(pass, async (answered, word) => {
      await view.answer(answered, word);
      await render();
    }),
  );
}

const STATUS_WORDS: Record<string, string> = { in_progress: "In progress", open: "Open", blocked: "Blocked", deferred: "Deferred", closed: "Closed" };

function orderRow(order: OrderRow): HTMLElement {
  const phases = order.phases.map((phase) => `${phase.slug} (${phase.state} at ${phase.station})`).join(", ") || (order.status === "closed" ? "done" : "none laid");
  return el(
    "tr",
    { "data-order": order.id },
    el("td", {}, order.externalRef ? el("a", { href: order.externalRef, rel: "noreferrer" }, order.id) : order.id, " ", order.title),
    el("td", {}, order.class ?? ""),
    el("td", {}, order.recipe ? `${order.recipe} ${order.revision ?? ""}`.trim() : ""),
    el("td", {}, phases),
  );
}

function orderGroup(group: OrderGroup): HTMLElement {
  const head = el("tr", {}, el("th", {}, "Order"), el("th", {}, "Class"), el("th", {}, "Recipe"), el("th", {}, "Phase"));
  return el(
    "section",
    { class: "group", "data-status": group.status },
    el("h2", {}, `${STATUS_WORDS[group.status] ?? group.status} (${group.orders.length})`),
    el("table", {}, el("thead", {}, head), el("tbody", {}, ...group.orders.map(orderRow))),
  );
}

async function drawOrders(session: Session): Promise<Node[]> {
  const groups = await ordersView(session).list();
  if (groups.length === 0) return [el("p", { class: "empty" }, "No order yet: run kitchen order add, or register a source.")];
  return groups.map(orderGroup);
}

/** `kitchen-20.2 build · order kitchen-20 (Stale cookie)`: a phase at a station, running or waiting. */
const phaseLine = (phase: StationPhase) => `${phase.id} ${phase.title} · order ${phase.order}`;

function stationCard(station: StationRow): HTMLElement {
  const facts = el(
    "p",
    { class: "facts" },
    `${station.attended ? "attended" : "unattended"} · owner ${station.owner} · host ${station.host} · ${station.running.length} of ${station.cap} running`,
  );
  const running = station.running.length
    ? el("ul", { class: "running" }, ...station.running.map((phase) => el("li", {}, phaseLine(phase))))
    : el("p", { class: "empty" }, "Working on nothing.");
  const card = el("article", { class: "station", "data-station": station.title }, el("h2", {}, station.title), facts, el("p", { class: "offers" }, station.offers), el("h3", {}, "Working on"), running);
  if (station.attended) {
    card.append(
      el("h3", {}, "Waiting for you"),
      station.waiting.length
        ? el("ul", { class: "waiting" }, ...station.waiting.map((phase) => el("li", {}, phaseLine(phase), el("br"), el("code", {}, phase.command))))
        : el("p", { class: "empty" }, "No phase waits here."),
    );
  }
  return card;
}

async function drawStations(session: Session): Promise<Node[]> {
  const stations = await stationsView(session).list();
  if (stations.length === 0) return [el("p", { class: "empty" }, "No station registered: run kitchen station add.")];
  return stations.map(stationCard);
}

function eventRow(event: JournalEntry): HTMLElement {
  return el(
    "tr",
    { "data-seq": String(event.seq) },
    el("td", {}, event.at.replace("T", " ").replace(/Z$/, "")),
    el("td", {}, event.actor),
    el("td", {}, event.op),
    el("td", {}, `${event.bead} ${event.title}`),
    el("td", {}, event.detail),
  );
}

async function drawActivity(session: Session): Promise<Node[]> {
  const events = await activityView(session).latest();
  if (events.length === 0) return [el("p", { class: "empty" }, "Nothing in the journal yet.")];
  const head = el("tr", {}, el("th", {}, "When"), el("th", {}, "Who"), el("th", {}, "What"), el("th", {}, "Bead"), el("th", {}, "Detail"));
  return [el("table", { class: "events" }, el("thead", {}, head), el("tbody", {}, ...events.map(eventRow)))];
}

/** The four views by the hash that opens each, in the nav's order; the first is the page's default. */
const VIEWS: Record<View, { title: string; draw: (session: Session) => Promise<Node[]> }> = {
  pass: { title: "Pass", draw: drawPasses },
  orders: { title: "Orders", draw: drawOrders },
  stations: { title: "Stations", draw: drawStations },
  activity: { title: "Activity", draw: drawActivity },
};

/** The view the hash names; the Pass view for no hash or one that names nothing. */
function currentView(): View {
  const name = location.hash.replace(/^#/, "");
  return name in VIEWS ? (name as View) : "pass";
}

function drawNav(view: View): void {
  nav.replaceChildren(...Object.entries(VIEWS).map(([name, { title }]) => el("a", { href: `#${name}`, ...(name === view ? { "aria-current": "page" } : {}) }, title)));
  heading.textContent = VIEWS[view].title;
  document.title = `Kitchen · ${VIEWS[view].title}`;
}

async function render(): Promise<void> {
  const view = currentView();
  drawNav(view);
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    askForToken();
    return;
  }
  let me;
  try {
    me = await whoAmI();
  } catch (error) {
    app.replaceChildren(notice(error instanceof Error ? error.message : String(error), "error"));
    return;
  }
  meLine.textContent = `${me.owner} on ${me.host}`;
  const session: Session = { fetch: (input, init) => fetch(input, init), token, owner: me.owner };
  app.replaceChildren(notice(`Loading ${VIEWS[view].title.toLowerCase()}…`));
  try {
    app.replaceChildren(...(await VIEWS[view].draw(session)));
  } catch (error) {
    if (error instanceof ViewError && error.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      askForToken(error.message);
      return;
    }
    app.replaceChildren(notice(error instanceof Error ? error.message : String(error), "error"), el("button", { type: "button" }, "Retry"));
    app.querySelector("button")?.addEventListener("click", () => void render());
    return;
  }
  const refresh = el("button", { type: "button" }, "Refresh");
  refresh.addEventListener("click", () => void render());
  app.append(el("p", {}, refresh));
}

window.addEventListener("hashchange", () => void render());
void render();
