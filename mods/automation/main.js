// Automations: starts coding agents and scripts when their Trigger fires, in tabs of a space
// of their own, and keeps a history of every Run. The panel and the dialog are the same view;
// every copy runs the engine, and only the holder of the lease fires and follows Runs.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, TextareaState } from "gpui-base";
import { theme, appHome, checking, props, closeOverlay, pickFolder, settings as appSettings } from "herdr";
import { loadSettings } from "./settings.js";
import { store, automationError } from "./store.js";
import { createEngine } from "./engine.js";
import { isActive } from "./runs.js";
import { host, io, lease } from "./host.js";
import { repoRoot } from "./shell.js";
import { TEXT } from "./views/ui.js";
import { header, list } from "./views/list.js";
import { detail } from "./views/detail.js";
import { form, formTrigger } from "./views/form.js";

const DEFAULT_SETTINGS = {
  agent: "claude",
  space: "Automations",
  worktreeRetention: "7d",
  historyRetention: "30d",
  notifications: "failures",
  gitPollInterval: "5m",
  agentTimeout: "60m",
  scriptTimeout: "10m",
};
const TICK_MS = 5000;
const HISTORY_DAYS = 30;
const STEPS = ["check", "pre", "post"];
const FIELDS = ["name", "folder", "model", "args", "prompt", "command", "minutes", "at", "cron", "timeout", "catchUp", "base", ...STEPS.flatMap((k) => [k, `${k}Timeout`])];
// The run files the panel shows for an ended Run, in pipeline order.
const OUTPUTS = [["Check", "check.txt"], ["Check (stderr)", "check.err.txt"], ["Pre-script", "pre.txt"], ["Pre-script (stderr)", "pre.err.txt"],
  ["Terminal (last 200 lines)", "tail.txt"], ["Post-script", "post.txt"], ["Post-script (stderr)", "post.err.txt"], ["Result file", "result.md"]];

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "automation";
const cleaned = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export default class Automation extends View {
  init(_props, cx) {
    this.overlay = props()?.overlay ?? null;
    this.settings = DEFAULT_SETTINGS;
    this.problems = [];
    this.store = store(`${appHome()}/data/automation`, io);
    this.doc = { paused: false, automations: [], problems: [] };
    this.state = { checked: {}, runs: {}, last: {} };
    this.history = [];
    this.screen = { name: "list" };
    this.form = null;
    this.ask = null;
    this.output = null;
    this.error = null;
    this.mono = appSettings()?.font_family ?? null;
    this.engine = createEngine({ store: this.store, host, lease, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, settings: () => this.settings });
    cx.spawn(async (cx) => {
      ({ settings: this.settings, problems: this.problems } = await loadSettings("automation", DEFAULT_SETTINGS));
      await this.reload();
      cx.notify();
    });
    if (checking()) return;
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
  }

  async close() {
    this.engine.release();
  }

  tick(cx) {
    cx.spawn(async (cx) => {
      try { await this.engine.tick(); this.error = null; } catch (e) { this.error = `The engine stopped a tick: ${e?.message ?? e}`; }
      // While a Run goes on, its elapsed time changes on screen.
      if ((await this.reload()) || Object.keys(this.state.runs).length) cx.notify();
    });
  }

  /** Reads the files again; resolves whether anything shown changed. */
  async reload() {
    const before = JSON.stringify([this.doc, this.state, this.history]);
    try {
      this.doc = await this.store.readAutomations();
      this.state = await this.store.readState();
      if (this.screen.name === "detail") this.history = await this.store.readHistory(HISTORY_DAYS);
    } catch (e) {
      this.error = `Cannot read the data folder: ${e?.message ?? e}`;
    }
    return before !== JSON.stringify([this.doc, this.state, this.history]);
  }

  // Every change goes through the files, then the screen reads them again.
  act(cx, work) {
    cx.spawn(async (cx) => {
      try { await work(); } catch (e) { this.error = e?.message ?? String(e); }
      await this.reload();
      cx.notify();
    });
  }

  show(screen, cx) {
    this.screen = screen;
    this.output = null;
    this.ask = null;
    this.history = [];
    if (cx) this.act(cx, async () => {});
  }

  going(id) { return Object.values(this.state.runs).find((r) => r.automation === id && isActive(r)) ?? null; }
  tabOpen(run) { return Boolean(run?.tab) && host.tabOpen(run.tab); }
  goTo(run) {
    host.goToTab(run.space, run.tab);
    this.closeDialog();
  }
  closeDialog() { if (this.overlay) closeOverlay(this.overlay); }

  togglePaused(cx) { this.act(cx, () => this.store.updateAutomations((d) => ({ ...d, paused: !d.paused }))); }
  toggleEnabled(a, cx) {
    this.act(cx, () => this.store.updateAutomations((d) => ({ ...d, automations: d.automations.map((x) => (x?.id === a.id ? { ...x, enabled: x.enabled === false } : x)) })));
  }
  runNow(a, cx) {
    this.act(cx, async () => {
      const r = await this.engine.runNow(a);
      if (r?.status === "skipped") this.error = `${a.name} is still going: this Run was skipped.`;
    });
  }
  stop(runId, cx) { this.act(cx, () => this.engine.stop(runId)); }
  remove(a, cx) {
    this.ask = null;
    this.show({ name: "list" });
    this.act(cx, () => this.store.updateAutomations((d) => ({ ...d, automations: d.automations.filter((x) => x?.id !== a.id) })));
  }

  /** A history row: its tab while it is open, else what the Run saved and its worktree. */
  openRun(e, cx) {
    if (this.tabOpen(e)) return this.goTo(e);
    this.act(cx, async () => {
      const sections = await Promise.all(OUTPUTS.map(async ([title, name]) => [title, await this.store.readRunFile(e.run, name).catch(() => null)]));
      this.output = {
        run: e.run, name: e.name, reason: e.reason ? `${e.status}: ${e.reason}` : e.status, branch: e.branch, path: e.worktree,
        sections: sections.filter(([, text]) => text?.trim()),
        worktree: await this.engine.worktree(e.run),
      };
    });
  }

  /** Open a tab here: a shell in the Run's worktree, in the Automations space. */
  openHere(o, cx) {
    this.act(cx, async () => this.goTo(await host.openTab({ space: this.settings.space, name: o.name, folder: o.worktree.path })));
  }

  /** Remove worktree; a dirty one only after the person said yes (`confirmed`). */
  removeWorktree(o, confirmed, cx) {
    if (o.worktree.dirty && !confirmed) { this.ask = { worktree: o.run }; return; }
    this.ask = null;
    this.act(cx, async () => {
      await this.engine.removeWorktree(o.run);
      if (this.output === o) this.output = { ...o, worktree: null };
    });
  }

  openForm(a, cx) {
    this.closeForm(cx);
    const tr = a?.trigger ?? { type: "schedule", preset: "daily", at: "09:00" };
    const text = (value, placeholder) => InputState.new({ value: value ?? "", placeholder });
    const catchUp = a?.catchUp === undefined ? "" : a.catchUp === "" || a.catchUp === false ? "none" : a.catchUp;
    this.form = {
      id: a?.id ?? null, original: a ?? null,
      kind: a?.kind ?? "agent", agent: a?.agent ?? this.settings.agent, agents: [], agentsError: null,
      preset: tr.type === "manual" ? "manual" : tr.preset, days: tr.days ?? [1, 2, 3, 4, 5], enabled: a?.enabled !== false, error: "",
      name: text(a?.name, "What it does"),
      folder: text(a?.folder, "/path/to/folder"),
      model: text(a?.model, "The agent's default"),
      args: text(a?.args?.join(" "), "--flag value"),
      prompt: TextareaState.new({ value: a?.prompt ?? "", placeholder: "The first message for the agent" }),
      command: TextareaState.new({ value: a?.command ?? "", placeholder: "make test" }),
      minutes: text(tr.minutes ? String(tr.minutes) : "15", "15"),
      at: text(tr.at ?? "09:00", "09:00"),
      cron: text(tr.cron ?? "0 9 * * 1-5", "0 9 * * 1-5"),
      timeout: text(a?.timeout ? String(a.timeout) : "", "From the settings"),
      catchUp: text(catchUp, "Default: 2h daily, none otherwise"),
      // null: the default, a worktree for an agent in a git repository.
      workspace: a?.workspace ?? null, isRepo: null,
      base: text(a?.base, "The remote's default branch"),
      requireResult: a?.requireResult === true,
    };
    for (const k of STEPS) {
      const s = a?.[k];
      this.form[`${k}Mode`] = s?.file ? "file" : "inline";
      this.form[k] = text(s?.file ?? s?.inline, "Shell text, or a file path");
      this.form[`${k}Timeout`] = text(s?.timeout ? String(s.timeout) : "", "60");
    }
    this.screen = { name: "form", back: this.screen };
    this.form.name.focus();
    const f = this.form;
    cx.spawn(async (cx) => {
      try { f.agents = await host.knownAgents(); } catch (e) { f.agentsError = `Cannot list the agents: ${e?.message ?? e}`; }
      cx.notify();
    });
    this.checkRepo(cx);
  }

  // Whether the form's folder is a git repository, which decides if a worktree is offered.
  checkRepo(cx) {
    const f = this.form, folder = f.folder.value().trim();
    if (!folder) return;
    cx.spawn(async (cx) => {
      const isRepo = Boolean(await repoRoot(host.exec, folder));
      if (this.form === f && f.folder.value().trim() === folder) f.isRepo = isRepo;
      cx.notify();
    });
  }

  closeForm(cx) {
    const f = this.form;
    if (!f) return;
    this.form = null;
    if (this.screen.name === "form") this.screen = this.screen.back ?? { name: "list" };
    // Released late because closing can run inside a field's own event.
    cx.timer.after(300, () => { for (const k of FIELDS) f[k].release(); });
  }

  pickFolder(cx) {
    const f = this.form;
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Choose" }).catch(() => null);
      if (folder && this.form === f) {
        f.folder.set_value(folder);
        f.isRepo = null;
        this.checkRepo(cx);
      }
      cx.notify();
    });
  }

  save(cx) {
    const f = this.form;
    const v = (k) => f[k].value().trim();
    const agent = f.kind === "agent";
    const timeout = v("timeout"), catchUp = v("catchUp");
    if (timeout && !(Number(timeout) > 0)) { f.error = "The timeout is a number of minutes above 0."; return; }
    const a = cleaned({
      ...f.original,
      id: f.id ?? `${slug(v("name"))}-${Date.now().toString(36)}`,
      name: v("name"), kind: f.kind, folder: v("folder"), trigger: formTrigger(f), enabled: f.enabled,
      agent: agent ? f.agent : undefined,
      model: agent && v("model") ? v("model") : undefined,
      args: agent && v("args") ? v("args").split(/\s+/) : undefined,
      prompt: agent ? f.prompt.value() : undefined,
      command: agent ? undefined : f.command.value(),
      timeout: timeout ? Number(timeout) : undefined,
      catchUp: catchUp === "" ? undefined : /^(none|0)$/i.test(catchUp) ? "" : catchUp,
      workspace: f.workspace ?? undefined,
      base: f.workspace !== "folder" && v("base") ? v("base") : undefined,
      requireResult: f.requireResult || undefined,
      ...Object.fromEntries(STEPS.map((k) => {
        const body = v(k), secs = v(`${k}Timeout`);
        return [k, body ? cleaned({ [f[`${k}Mode`]]: body, timeout: secs ? Number(secs) : undefined }) : undefined];
      })),
    });
    const error = automationError(a);
    if (error) { f.error = `This Automation ${error}.`; return; }
    cx.spawn(async (cx) => {
      if (a.workspace === "worktree" && !(await repoRoot(host.exec, a.folder))) {
        f.error = "The folder is not a git repository, so a Run cannot have a worktree. Choose Folder.";
        return cx.notify();
      }
      if (this.form !== f) return;
      const id = a.id;
      this.closeForm(cx);
      this.screen = { name: "detail", id };
      this.act(cx, () => this.store.updateAutomations((d) => ({
        ...d,
        automations: d.automations.some((x) => x?.id === id) ? d.automations.map((x) => (x?.id === id ? a : x)) : [...d.automations, a],
      })));
    });
  }

  render() {
    const t = theme();
    const notices = [this.error, ...this.problems, ...this.doc.problems].filter(Boolean);
    const body = this.screen.name === "form" && this.form ? form(this, t) : this.screen.name === "detail" ? detail(this, t) : list(this, t);
    return v_flex().id("root").size_full().bg(t.surface).text_size(TEXT.body).text_color(t.foreground)
      .child(header(this, t))
      .when(notices.length > 0, (el) => el.child(v_flex().flex_none().mx(8).mt(8).px(8).py(4).gap(2).rounded(6).bg(t.raised)
        .children(notices.map((n) => div().text_size(TEXT.note).text_color(t.blocked).child(n)))))
      .child(v_flex().id("body").flex_1().min_h(0).overflow_y_scrollbar().child(body));
  }
}
