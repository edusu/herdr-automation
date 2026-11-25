// The agent-status and git Triggers: what a look at the agents or at a repository means.
// Pure apart from the git commands, which come in through `exec` and shell.js.
import { head, remoteCommit } from "./shell.js";
import { RUN_LABEL } from "./runs.js";

// "done" also covers "idle": an agent finishing while someone looks at it goes straight to idle.
const statusOf = (s) => (s === "blocked" ? "blocked" : s === "done" || s === "idle" ? "done" : s === "working" ? "working" : null);

const inside = (folder, root) => {
  const r = root.replace(/\/+$/, "");
  return folder === r || folder.startsWith(`${r}/`);
};

/** Whether agent `agent` (`{folder, app, program}`) passes the filters of `automation`'s agent-status Trigger. */
export function agentMatches(automation, agent) {
  const tr = automation.trigger;
  if (tr.inFolder && !(agent.folder && inside(agent.folder, automation.folder))) return false;
  return !tr.app || tr.app === agent.app || tr.app === agent.program;
}

/**
 * One look at the agents: `{seen, firings}`. `seen` maps each agent terminal to its last
 * `{status, turn}` (status "working", "blocked" or "done"); pass the previous one back next
 * time, or null when the engine starts, so statuses already present never fire. `agents` are
 * `{address, status, turn, app, program, space, folder, labels}`, `turn` being the terminal's
 * count of turns: a turn shorter than the time between two looks never shows as "working", but
 * the count has grown. An agent a Run started (its terminal
 * has the Run label) fires nothing, so Automations cannot start each other. Each firing is
 * `{automation, agent, status}`.
 */
export function agentFirings({ seen, agents, automations }) {
  const next = new Map(), firings = [];
  for (const agent of agents) {
    const now = statusOf(agent.status);
    if (!now) continue;
    const turn = agent.turn ?? null;
    next.set(agent.address, { status: now, turn });
    const before = seen?.get(agent.address);
    if (!before || now === "working" || (before.status === now && !(now === "done" && turn > before.turn))) continue;
    if (agent.labels?.[RUN_LABEL]) continue;
    for (const a of automations)
      if (a.trigger.type === "agent" && a.trigger.status === now && agentMatches(a, agent)) firings.push({ automation: a, agent, status: now });
  }
  return { seen: next, firings };
}

/**
 * Where a git Trigger's ref is now: `{commit, branch}` of the checkout for a local one, or the
 * commit of `branch` ("origin/main") on the remote for a remote one. Rejects with the reason.
 */
export async function gitHead(exec, automation) {
  const tr = automation.trigger;
  if (tr.source === "remote") return { commit: await remoteCommit(exec, automation.folder, tr.branch), branch: tr.branch };
  const h = await head(exec, automation.folder);
  if (!h.commit) throw new Error(`${automation.folder} is not a git repository with a commit`);
  return h;
}

/**
 * Whether a git Trigger fires on `now` (`{commit, branch}`) after `last` (the one recorded, or
 * undefined): the new commit, or null. The first look and a change of branch only record.
 */
export function gitFiring(last, now) {
  if (!last?.commit || last.branch !== now.branch || last.commit === now.commit) return null;
  return now.commit;
}
