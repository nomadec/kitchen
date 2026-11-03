// The Pass view in the browser: the token asked for once and kept in local storage, the owner read
// from the expeditor's /me, every open pass with its order, brief and an answer box, and the word
// posted as the close. Everything that talks to bd serve is in passes.ts; this file only draws.
import { passView, PassViewError } from "./passes.ts";
import type { Pass } from "./passes.ts";

const TOKEN_KEY = "kitchen.token";

const app = document.getElementById("app") as HTMLElement;
const meLine = document.getElementById("me") as HTMLElement;

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

async function render(): Promise<void> {
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
  meLine.textContent = `answering as ${me.owner} on ${me.host}`;
  const view = passView({ fetch: (input, init) => fetch(input, init), token, actor: me.owner });
  app.replaceChildren(notice("Loading the open passes…"));
  let passes: Pass[];
  try {
    passes = await view.list();
  } catch (error) {
    if (error instanceof PassViewError && error.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      askForToken(error.message);
      return;
    }
    app.replaceChildren(notice(error instanceof Error ? error.message : String(error), "error"), el("button", { type: "button" }, "Retry"));
    app.querySelector("button")?.addEventListener("click", () => void render());
    return;
  }
  app.replaceChildren();
  if (passes.length === 0) {
    app.append(el("p", { class: "empty" }, "No open pass: nothing waits on you."));
  }
  for (const pass of passes) {
    app.append(
      passCard(pass, async (answered, word) => {
        await view.answer(answered, word);
        await render();
      }),
    );
  }
  const refresh = el("button", { type: "button" }, "Refresh");
  refresh.addEventListener("click", () => void render());
  app.append(el("p", {}, refresh));
}

void render();
