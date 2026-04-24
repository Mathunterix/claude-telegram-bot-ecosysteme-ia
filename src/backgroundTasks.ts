/**
 * backgroundTasks.ts — S12 : simulation de Task `run_in_background` pour le SDK V1.
 *
 * Probleme : le SDK `@anthropic-ai/claude-agent-sdk` ne supporte pas encore
 * explicitement `run_in_background: true` sur le Task tool. Du coup quand
 * Claude lance un sous-agent (deep-search, explore, etc.), notre `session.
 * sendMessageStreaming()` bloque jusqu'a la fin de l'execution, et l'utilisateur
 * ne peut pas parler au bot pendant ce temps.
 *
 * Solution : intercepter le Task tool dans `canUseTool`. Si l'input contient
 * `run_in_background: true` (signal du modele), on :
 *   1. Deny le Task cote SDK (il ne s'execute pas dans la session principale)
 *   2. Spawn une query() separee via Promise fire-and-forget qui execute
 *      un agent equivalent avec la meme `description` + `subagent_type`
 *   3. Retourne a l'agent principal un message "Task launched, notifier
 *      quand complete", ce qui libere la session principale pour continuer
 *      a dialoguer avec l'utilisateur
 *   4. Quand le Promise en background se termine, on envoie le resultat
 *      directement a l'utilisateur via `bot.api.sendMessage()`
 *
 * Limites de cette V1 :
 *   - Le resultat du background task n'est pas automatiquement reinjecte
 *     dans la session principale. L'utilisateur doit le relire manuellement.
 *     Mitigation : /tasks liste les background et permet de les consulter.
 *   - Un crash du bot pendant un background task perd le travail en cours.
 *   - Limite de concurrence : max ECOSYS_MAX_BG_TASKS (defaut 3) tasks en
 *     parallele pour eviter l'OOM.
 */

import { randomUUID } from "crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { getBotRef } from "./botRef";
import {
  WORKING_DIR,
  SAFETY_PROMPT,
  MCP_SERVERS,
  ALLOWED_PATHS,
} from "./config";

const MAX_BG_TASKS = parseInt(process.env.ECOSYS_MAX_BG_TASKS || "3", 10);
const TASK_TIMEOUT_MS = parseInt(
  process.env.ECOSYS_BG_TASK_TIMEOUT_MS || "600000", // 10 min
  10,
);

export type BackgroundTaskState =
  | "running"
  | "completed"
  | "failed"
  | "timeout";

export type BackgroundTask = {
  id: string;
  sessionKey: string;
  chatId: number;
  threadId?: number;
  description: string;
  subagentType?: string;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  state: BackgroundTaskState;
  resultPreview?: string;
  abort: AbortController;
};

const tasks = new Map<string, BackgroundTask>();

export function listTasks(sessionKey?: string): BackgroundTask[] {
  const all = Array.from(tasks.values());
  return sessionKey ? all.filter((t) => t.sessionKey === sessionKey) : all;
}

export function getTask(id: string): BackgroundTask | undefined {
  return tasks.get(id);
}

/** Number of currently running tasks (regardless of session). */
export function runningCount(): number {
  let n = 0;
  for (const t of tasks.values()) if (t.state === "running") n++;
  return n;
}

/**
 * Build the prompt sent to the background subagent. The model requested a
 * Task with a description + subagent_type; we translate that into a one-shot
 * query() with the description as the user message. The subagent prompt is
 * loaded from the project's agents config if it exists; otherwise we rely
 * on the description alone.
 */
function buildPromptForBackground(
  description: string,
  subagentType: string | undefined,
): string {
  const base = description?.trim() || "Execute the task described.";
  if (subagentType) {
    return `[Background task delegated from main session]\n\nSubagent type: ${subagentType}\n\nTask:\n${base}`;
  }
  return `[Background task delegated from main session]\n\n${base}`;
}

export type StartBackgroundTaskInput = {
  sessionKey: string;
  chatId: number;
  threadId?: number;
  description: string;
  subagentType?: string;
  originalPrompt?: string;
  modelOverride?: string | null;
};

/**
 * Spawn a background task. Fire-and-forget : we do NOT await the result here,
 * the Promise runs in the background and notifies the user via bot.api when done.
 * Returns the task id so the caller can mention it in its reply to the model.
 */
export function startBackgroundTask(
  input: StartBackgroundTaskInput,
): string | null {
  if (runningCount() >= MAX_BG_TASKS) {
    return null; // caller should tell Claude / user
  }

  const id = randomUUID().slice(0, 8);
  const abort = new AbortController();
  const task: BackgroundTask = {
    id,
    sessionKey: input.sessionKey,
    chatId: input.chatId,
    threadId: input.threadId,
    description: input.description,
    subagentType: input.subagentType,
    prompt: buildPromptForBackground(input.description, input.subagentType),
    startedAt: Date.now(),
    state: "running",
    abort,
  };
  tasks.set(id, task);

  // Fire-and-forget.
  runTask(task, input.modelOverride ?? null).catch((err) => {
    console.error(`[bg-task ${id}] unexpected error:`, err);
  });

  return id;
}

/**
 * Abort a task by id. Returns true if the task was running and got aborted.
 */
export function abortTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || task.state !== "running") return false;
  task.abort.abort();
  task.state = "failed";
  task.endedAt = Date.now();
  return true;
}

async function runTask(
  task: BackgroundTask,
  modelOverride: string | null,
): Promise<void> {
  const bot = (() => {
    try {
      return getBotRef();
    } catch {
      return null;
    }
  })();

  // Acknowledge start in the chat so the user sees the task is alive.
  if (bot) {
    try {
      const desc = task.description.slice(0, 200);
      const typeBadge = task.subagentType ? ` [${task.subagentType}]` : "";
      await bot.api.sendMessage(
        task.chatId,
        `🎯 <b>Tache en arriere-plan demarree</b>${typeBadge}\n<code>${task.id}</code> : ${escapeHtml(desc)}\n\nTu peux continuer a parler, je te notifie quand c'est fini. <code>/tasks</code> pour lister.`,
        {
          parse_mode: "HTML",
          ...(task.threadId && task.threadId > 0
            ? { message_thread_id: task.threadId }
            : {}),
        },
      );
    } catch (error) {
      console.warn(`[bg-task ${task.id}] ack send failed:`, error);
    }
  }

  // Timeout guard.
  const timeoutHandle = setTimeout(() => {
    if (task.state === "running") {
      task.abort.abort();
      task.state = "timeout";
      task.endedAt = Date.now();
    }
  }, TASK_TIMEOUT_MS);

  const options: Options = {
    model: modelOverride || process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    cwd: WORKING_DIR,
    settingSources: ["user", "project"],
    permissionMode: "default",
    systemPrompt: SAFETY_PROMPT,
    mcpServers: MCP_SERVERS,
    additionalDirectories: ALLOWED_PATHS,
    abortController: task.abort,
  };
  if (process.env.CLAUDE_CODE_PATH) {
    options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_PATH;
  }

  let collected = "";
  try {
    const q = query({
      prompt: task.prompt,
      options,
    });
    for await (const msg of q) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") collected += block.text;
        }
      }
      if (task.state !== "running") break; // aborted externally
    }
    if (task.state === "running") {
      task.state = "completed";
      task.endedAt = Date.now();
      task.resultPreview = collected.slice(0, 200);
    }
  } catch (error) {
    if (task.state === "running") {
      task.state = "failed";
      task.endedAt = Date.now();
    }
    const short = String(error).slice(0, 500);
    collected = collected || `Erreur : ${short}`;
    console.error(`[bg-task ${task.id}] query failed:`, error);
  } finally {
    clearTimeout(timeoutHandle);
  }

  // Notify user of completion (success, failure, or timeout).
  if (bot) {
    try {
      const icon =
        task.state === "completed"
          ? "✓"
          : task.state === "timeout"
            ? "⏱️"
            : "⚠️";
      const header =
        task.state === "completed"
          ? "Tache terminee"
          : task.state === "timeout"
            ? "Tache expiree"
            : "Tache echouee";
      const body = collected.slice(0, 3500) || "(pas de sortie)";
      await bot.api.sendMessage(
        task.chatId,
        `${icon} <b>${header}</b> <code>${task.id}</code>\n\n${escapeHtml(body)}`,
        {
          parse_mode: "HTML",
          ...(task.threadId && task.threadId > 0
            ? { message_thread_id: task.threadId }
            : {}),
        },
      );
    } catch (error) {
      console.warn(`[bg-task ${task.id}] result send failed:`, error);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
