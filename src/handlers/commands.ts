/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /new, /stop, /status, /resume, /restart
 */

import type { Context } from "grammy";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { getSession, saveSessionRegistry, listSessions } from "../session";
import { WORKING_DIR, ALLOWED_USERS, RESTART_FILE } from "../config";
import {
  listTasks,
  abortTask,
  getTask,
  type BackgroundTask,
} from "../backgroundTasks";
import { isAuthorized } from "../security";
import type { ApprovalChoice } from "../permissions";

/**
 * /start - Show welcome message and status.
 */
export async function handleStart(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const status = session.isActive ? "Active session" : "No active session";
  const workDir = WORKING_DIR;

  await ctx.reply(
    `🤖 <b>Claude Telegram Bot</b>\n\n` +
      `Status: ${status}\n` +
      `Working directory: <code>${workDir}</code>\n\n` +
      `<b>Commands:</b>\n` +
      `/new - Start fresh session\n` +
      `/stop - Stop current query\n` +
      `/status - Show detailed status\n` +
      `/resume - Resume last session\n` +
      `/retry - Retry last message\n` +
      `/restart - Restart the bot\n\n` +
      `<b>Tips:</b>\n` +
      `• Prefix with <code>!</code> to interrupt current query\n` +
      `• Use "think" keyword for extended reasoning\n` +
      `• Send photos, voice, or documents`,
    { parse_mode: "HTML" },
  );
}

/**
 * /new - Start a fresh session.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Stop any running query
  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      await Bun.sleep(100);
      session.clearStopRequested();
    }
  }

  // Clear session
  await session.kill();

  await ctx.reply("🆕 Session cleared. Next message starts fresh.");
}

/**
 * /stop - Stop the current query (silently).
 */
export async function handleStop(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      // Wait for the abort to be processed, then clear stopRequested so next message can proceed
      await Bun.sleep(100);
      session.clearStopRequested();
    }
    // Silent stop - no message shown
  }
  // If nothing running, also stay silent
}

/**
 * /status - Show detailed status.
 */
export async function handleStatus(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const lines: string[] = ["📊 <b>Bot Status</b>\n"];

  // Session status
  if (session.isActive) {
    lines.push(`✅ Session: Active (${session.sessionId?.slice(0, 8)}...)`);
  } else {
    lines.push("⚪ Session: None");
  }

  // Query status
  if (session.isRunning) {
    const elapsed = session.queryStarted
      ? Math.floor((Date.now() - session.queryStarted.getTime()) / 1000)
      : 0;
    lines.push(`🔄 Query: Running (${elapsed}s)`);
    if (session.currentTool) {
      lines.push(`   └─ ${session.currentTool}`);
    }
  } else {
    lines.push("⚪ Query: Idle");
    if (session.lastTool) {
      lines.push(`   └─ Last: ${session.lastTool}`);
    }
  }

  // Last activity
  if (session.lastActivity) {
    const ago = Math.floor(
      (Date.now() - session.lastActivity.getTime()) / 1000,
    );
    lines.push(`\n⏱️ Last activity: ${ago}s ago`);
  }

  // Usage stats
  if (session.lastUsage) {
    const usage = session.lastUsage;
    lines.push(
      `\n📈 Last query usage:`,
      `   Input: ${usage.input_tokens?.toLocaleString() || "?"} tokens`,
      `   Output: ${usage.output_tokens?.toLocaleString() || "?"} tokens`,
    );
    if (usage.cache_read_input_tokens) {
      lines.push(
        `   Cache read: ${usage.cache_read_input_tokens.toLocaleString()}`,
      );
    }
  }

  // Error status
  if (session.lastError) {
    const ago = session.lastErrorTime
      ? Math.floor((Date.now() - session.lastErrorTime.getTime()) / 1000)
      : "?";
    lines.push(`\n⚠️ Last error (${ago}s ago):`, `   ${session.lastError}`);
  }

  // Working directory
  lines.push(`\n📁 Working dir: <code>${WORKING_DIR}</code>`);

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * /resume - Show list of sessions to resume with inline keyboard.
 */
export async function handleResume(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (session.isActive) {
    await ctx.reply("Sessione già attiva. Usa /new per iniziare da capo.");
    return;
  }

  // Get saved sessions
  const sessions = session.getSessionList();

  if (sessions.length === 0) {
    await ctx.reply("❌ Nessuna sessione salvata.");
    return;
  }

  // Build inline keyboard with session list
  const buttons = sessions.map((s) => {
    // Format date: "18/01 10:30"
    const date = new Date(s.saved_at);
    const dateStr = date.toLocaleDateString("it-IT", {
      day: "2-digit",
      month: "2-digit",
    });
    const timeStr = date.toLocaleTimeString("it-IT", {
      hour: "2-digit",
      minute: "2-digit",
    });

    // Truncate title for button (max ~40 chars to fit)
    const titlePreview =
      s.title.length > 35 ? s.title.slice(0, 32) + "..." : s.title;

    return [
      {
        text: `📅 ${dateStr} ${timeStr} - "${titlePreview}"`,
        callback_data: `resume:${s.session_id}`,
      },
    ];
  });

  await ctx.reply(
    "📋 <b>Sessioni salvate</b>\n\nSeleziona una sessione da riprendere:",
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: buttons,
      },
    },
  );
}

/**
 * /restart - Restart the bot process.
 */
export async function handleRestart(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const msg = await ctx.reply("🔄 Restarting bot...");

  // Save message info so we can update it after restart
  if (chatId && msg.message_id) {
    try {
      await Bun.write(
        RESTART_FILE,
        JSON.stringify({
          chat_id: chatId,
          message_id: msg.message_id,
          timestamp: Date.now(),
        }),
      );
    } catch (e) {
      console.warn("Failed to save restart info:", e);
    }
  }

  // Give time for the message to send
  await Bun.sleep(500);

  // Exit - launchd will restart us
  process.exit(0);
}

/**
 * /retry - Retry the last message (resume session and re-send).
 */
export async function handleRetry(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Check if there's a message to retry
  if (!session.lastMessage) {
    await ctx.reply("❌ No message to retry.");
    return;
  }

  // Check if something is already running
  if (session.isRunning) {
    await ctx.reply("⏳ A query is already running. Use /stop first.");
    return;
  }

  const message = session.lastMessage;
  await ctx.reply(
    `🔄 Retrying: "${message.slice(0, 50)}${message.length > 50 ? "..." : ""}"`,
  );

  // Simulate sending the message again by emitting a fake text message event
  // We do this by directly calling the text handler logic
  const { handleText } = await import("./text");

  // Create a modified context with the last message
  const fakeCtx = {
    ...ctx,
    message: {
      ...ctx.message,
      text: message,
    },
  } as Context;

  await handleText(fakeCtx);
}

/**
 * /help — Afficher toutes les commandes disponibles en francais.
 */
export async function handleHelp(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Non autorise. Contacte le proprietaire du bot.");
    return;
  }

  await ctx.reply(
    `<b>Sessions</b>\n` +
      `/new - Nouvelle session (reset memoire + history) pour ce topic\n` +
      `/stop - Stopper la requete en cours\n` +
      `/status - Etat de la session courante\n` +
      `/sessions - Liste toutes les sessions actives (par topic)\n` +
      `/resume - Reprendre la derniere session\n` +
      `/retry - Relancer le dernier message\n` +
      `/restart - Redemarrer le bot\n\n` +
      `<b>Permissions (par topic)</b>\n` +
      `/permissions - Etat des permissions du topic\n` +
      `/intercept Tool - Forcer approval sur un tool safe (ex: /intercept WebFetch)\n` +
      `/trust pattern - Auto-approuver (ex: /trust rm-rf-generic)\n` +
      `/revoke pattern - Retirer des listes (ex: /revoke WebFetch)\n` +
      `/forbid Tool - Interdire sans demander (ex: /forbid sudo)\n` +
      `/approve - Approuver la derniere demande pending (fallback texte)\n` +
      `/deny - Refuser la derniere demande pending\n\n` +
      `<b>Voix (par topic)</b>\n` +
      `/voice - Toggle on/off\n` +
      `/voice fr-FR-HenriNeural - Changer la voix\n` +
      `/voices - Liste des voix FR disponibles\n\n` +
      `<b>Modele (par topic)</b>\n` +
      `/model - Afficher le modele courant\n` +
      `/model haiku|sonnet|opus - Switch modele\n` +
      `/model default - Revenir au defaut\n\n` +
      `<b>Taches en arriere-plan</b>\n` +
      `/tasks - Liste des taches du topic courant\n` +
      `/tasks all - Liste tous topics\n` +
      `/tasks &lt;id&gt; - Details d'une tache\n` +
      `/tasks kill &lt;id&gt; - Annuler une tache\n\n` +
      `<b>Astuces</b>\n` +
      `- Prefixer avec <code>!</code> interrompt la requete en cours\n` +
      `- Mots-cles <code>think</code>, <code>reflechis</code> activent le raisonnement etendu\n` +
      `- Envoyer photos, vocaux ou documents fonctionne directement\n` +
      `- Chaque topic Telegram = session isolee avec sa propre memoire, voix, modele et permissions\n` +
      `- Les commandes dangereuses (rm -rf, sudo...) declenchent un popup d'approbation`,
    { parse_mode: "HTML" },
  );
}

/**
 * Resoudre la plus recente demande d'approbation pending pour ce chat.
 * Fallback texte pour /approve et /deny si les boutons inline ne sont pas cliquables.
 */
async function resolveLatestApproval(
  ctx: Context,
  choice: ApprovalChoice,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const tmpDir = process.env.ECOSYS_APPROVAL_TMP_DIR || "/tmp";
  const glob = new Bun.Glob("approval-*.json");

  let latestRequestId: string | null = null;
  let latestCreatedAt = 0;

  for await (const filename of glob.scan({ cwd: tmpDir, absolute: false })) {
    if (filename.includes(".response.")) continue;
    const filepath = `${tmpDir}/${filename}`;
    try {
      const raw = readFileSync(filepath, "utf-8");
      const data = JSON.parse(raw) as {
        request_id: string;
        chat_id: number;
        status: string;
        created_at: number;
      };
      if (data.chat_id !== chatId) continue;
      if (data.status === "answered") continue;
      if (data.created_at > latestCreatedAt) {
        latestCreatedAt = data.created_at;
        latestRequestId = data.request_id;
      }
    } catch {
      // ignore unreadable files
    }
  }

  if (!latestRequestId) {
    await ctx.reply("Aucune demande d'approbation en attente.");
    return;
  }

  const responsePath = `${tmpDir}/approval-${latestRequestId}.response.json`;
  writeFileSync(
    responsePath,
    JSON.stringify({ request_id: latestRequestId, choice }),
  );

  const labels: Record<ApprovalChoice, string> = {
    once: "autorise une fois",
    session: "autorise pour cette session",
    always: "autorise toujours",
    deny: "refuse",
    timeout: "expire",
  };
  await ctx.reply(`Demande ${labels[choice]}.`);
}

/**
 * /approve - Approuver la derniere demande pending (fallback texte).
 * Accepte un argument optionnel : once (defaut) / session / always.
 */
export async function handleApprove(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Non autorise.");
    return;
  }

  const arg = ctx.message?.text?.split(/\s+/)[1]?.toLowerCase() ?? "once";
  const choice: ApprovalChoice = (
    arg === "session" || arg === "always" ? arg : "once"
  ) as ApprovalChoice;
  await resolveLatestApproval(ctx, choice);
}

/**
 * /deny - Refuser la derniere demande pending (fallback texte).
 */
export async function handleDeny(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Non autorise.");
    return;
  }
  await resolveLatestApproval(ctx, "deny");
}

/**
 * /sessions - liste toutes les sessions actives par topic (S7).
 * Le topic courant est marque avec un asterisque.
 */
export async function handleSessions(ctx: Context): Promise<void> {
  const current = getSession(ctx);
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Non autorise.");
    return;
  }

  const all = listSessions().filter((s) => s.active);

  if (all.length === 0) {
    await ctx.reply(
      "Aucune session active. Envoie un message pour en demarrer une.",
    );
    return;
  }

  const currentKey = current.sessionKey;
  const lines: string[] = [`<b>Sessions actives (${all.length})</b>\n`];

  for (const s of all) {
    const prefix = s.sessionKey === currentKey ? "▶" : "·";
    const title = s.title || "(sans titre)";
    const ago = s.lastActivityISO
      ? formatAgo(new Date(s.lastActivityISO))
      : "?";
    const [chatPart, threadPart] = s.sessionKey.split(":");
    const label = threadPart === "0" ? "DM/General" : `thread ${threadPart}`;
    lines.push(
      `${prefix} <code>${label}</code> · ${title.slice(0, 40)} · ${ago}`,
    );
  }

  lines.push("", "<i>▶ topic courant</i>");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

function formatAgo(date: Date): string {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}j`;
}

// ====================================================================
// S6.1 — Permissions editables par topic
// ====================================================================

/**
 * /permissions - affiche l'etat des permissions pour le topic courant.
 */
export async function handlePermissions(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Non autorise.");
    return;
  }

  const lines: string[] = [`<b>Permissions topic ${session.sessionKey}</b>\n`];

  lines.push(
    "<b>Toujours approuves</b> (pas de demande) :",
    session.alwaysApprovedPatterns.size > 0
      ? Array.from(session.alwaysApprovedPatterns)
          .map((k) => `  - <code>${k}</code>`)
          .join("\n")
      : "  <i>(aucun)</i>",
  );

  lines.push(
    "",
    "<b>Interceptes</b> (demandent approval meme si safe) :",
    session.interceptTools.size > 0
      ? Array.from(session.interceptTools)
          .map((t) => `  - <code>${t}</code>`)
          .join("\n")
      : "  <i>(aucun)</i>",
  );

  lines.push(
    "",
    "<b>Interdits</b> (refuses sans demander) :",
    session.forbidTools.size > 0
      ? Array.from(session.forbidTools)
          .map((t) => `  - <code>${t}</code>`)
          .join("\n")
      : "  <i>(aucun)</i>",
  );

  lines.push(
    "",
    "<i>Commandes : /intercept tool, /trust pattern, /revoke pattern, /forbid tool</i>",
  );

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

function parseArg(ctx: Context): string | null {
  const text = ctx.message?.text ?? "";
  const parts = text.trim().split(/\s+/);
  return parts.length >= 2 ? parts.slice(1).join(" ") : null;
}

/**
 * /intercept <tool> - force approval meme sur un tool safe.
 */
export async function handleIntercept(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Non autorise.");
    return;
  }
  const tool = parseArg(ctx);
  if (!tool) {
    await ctx.reply("Usage : /intercept <Tool> (ex: /intercept WebFetch)");
    return;
  }
  session.interceptTools.add(tool);
  session.alwaysApprovedPatterns.delete(tool);
  saveSessionRegistry();
  await ctx.reply(
    `OK. <code>${tool}</code> sera intercepte a chaque utilisation pour ce topic.`,
    { parse_mode: "HTML" },
  );
}

/**
 * /trust <patternKey|tool> - auto-approuve toujours pour ce topic.
 */
export async function handleTrust(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Non autorise.");
    return;
  }
  const key = parseArg(ctx);
  if (!key) {
    await ctx.reply(
      "Usage : /trust <pattern> (ex: /trust rm-rf-generic ou /trust WebFetch)",
    );
    return;
  }
  session.alwaysApprovedPatterns.add(key);
  session.forbidTools.delete(key);
  saveSessionRegistry();
  await ctx.reply(
    `OK. <code>${key}</code> est maintenant auto-approuve pour ce topic.`,
    { parse_mode: "HTML" },
  );
}

/**
 * /revoke <patternKey|tool> - retire de trust + intercept -> redemandera.
 */
export async function handleRevoke(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Non autorise.");
    return;
  }
  const key = parseArg(ctx);
  if (!key) {
    await ctx.reply("Usage : /revoke <pattern> (ex: /revoke WebFetch)");
    return;
  }
  const removedTrust = session.alwaysApprovedPatterns.delete(key);
  const removedIntercept = session.interceptTools.delete(key);
  const removedForbid = session.forbidTools.delete(key);
  saveSessionRegistry();
  if (!removedTrust && !removedIntercept && !removedForbid) {
    await ctx.reply(`<code>${key}</code> n'etait dans aucune liste.`, {
      parse_mode: "HTML",
    });
    return;
  }
  await ctx.reply(
    `OK. <code>${key}</code> retire des listes (trust/intercept/forbid) pour ce topic.`,
    { parse_mode: "HTML" },
  );
}

/**
 * /forbid <tool> - refus permanent sans demander.
 */
export async function handleForbid(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Non autorise.");
    return;
  }
  const tool = parseArg(ctx);
  if (!tool) {
    await ctx.reply("Usage : /forbid <Tool> (ex: /forbid WebFetch)");
    return;
  }
  session.forbidTools.add(tool);
  session.alwaysApprovedPatterns.delete(tool);
  session.interceptTools.delete(tool);
  saveSessionRegistry();
  await ctx.reply(
    `OK. <code>${tool}</code> est interdit pour ce topic (refus immediat sans demander).`,
    { parse_mode: "HTML" },
  );
}

// ====================================================================
// S8 — TTS commandes : /voice et /voices
// ====================================================================

const KNOWN_VOICES: Array<{ id: string; label: string }> = [
  { id: "fr-FR-DeniseNeural", label: "Denise (FR feminin, defaut)" },
  { id: "fr-FR-HenriNeural", label: "Henri (FR masculin)" },
  { id: "fr-FR-EloiseNeural", label: "Eloise (FR feminin, adolescent)" },
  { id: "fr-FR-RemyMultilingualNeural", label: "Remy (FR multilingue)" },
  {
    id: "fr-FR-VivienneMultilingualNeural",
    label: "Vivienne (FR multilingue)",
  },
  { id: "fr-CA-SylvieNeural", label: "Sylvie (quebecois feminin)" },
  { id: "fr-CA-AntoineNeural", label: "Antoine (quebecois masculin)" },
  { id: "fr-CH-ArianeNeural", label: "Ariane (suisse feminin)" },
];

/**
 * /voice - toggle on/off, ou set a specific voice, ou status.
 * Usages:
 *   /voice         -> toggle on/off
 *   /voice on      -> active (garde la voix courante)
 *   /voice off     -> desactive
 *   /voice <name>  -> set la voix et active (ex: /voice fr-FR-HenriNeural)
 */
export async function handleVoiceCmd(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Non autorise.");
    return;
  }
  const arg = parseArg(ctx)?.trim();

  if (!arg) {
    session.voiceMode = session.voiceMode === "off" ? "all" : "off";
    saveSessionRegistry();
    await ctx.reply(
      `Voix : <b>${session.voiceMode}</b> (voix actuelle : <code>${session.voiceName}</code>)`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (arg === "on") {
    session.voiceMode = "all";
    saveSessionRegistry();
    await ctx.reply(`Voix activee (<code>${session.voiceName}</code>).`, {
      parse_mode: "HTML",
    });
    return;
  }
  if (arg === "off") {
    session.voiceMode = "off";
    saveSessionRegistry();
    await ctx.reply("Voix desactivee.");
    return;
  }

  // Check contre la liste connue pour UX, mais on accepte n'importe quelle voix edge-tts
  const known = KNOWN_VOICES.find((v) => v.id === arg);
  if (!known && !arg.includes("-")) {
    await ctx.reply(
      `Voix <code>${arg}</code> inconnue. Tape /voices pour la liste ou donne un id edge-tts (ex: fr-FR-HenriNeural).`,
      { parse_mode: "HTML" },
    );
    return;
  }

  session.voiceName = arg;
  session.voiceMode = "all";
  saveSessionRegistry();
  await ctx.reply(`Voix <code>${arg}</code> activee pour ce topic.`, {
    parse_mode: "HTML",
  });
}

/**
 * /voices - liste les voix FR connues.
 */
export async function handleVoicesCmd(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Non autorise.");
    return;
  }
  const lines: string[] = ["<b>Voix francaises disponibles</b>\n"];
  for (const v of KNOWN_VOICES) {
    lines.push(`<code>${v.id}</code> - ${v.label}`);
  }
  lines.push(
    "",
    "<i>Usage : /voice fr-FR-HenriNeural pour changer</i>",
    "<i>Tu peux aussi utiliser n'importe quelle voix Microsoft Edge (en-US-..., es-ES-..., etc.)</i>",
  );
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

// ====================================================================
// S9 — /model switch per-topic
// ====================================================================

const MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
  "haiku-4-5": "claude-haiku-4-5",
  "sonnet-4-6": "claude-sonnet-4-6",
  "opus-4-7": "claude-opus-4-7",
};

/**
 * /model - switch model for this topic.
 * /model         -> affiche le modele courant
 * /model haiku   -> claude-haiku-4-5
 * /model sonnet  -> claude-sonnet-4-6
 * /model opus    -> claude-opus-4-7
 * /model default -> retire l'override (utilise env CLAUDE_MODEL)
 */
export async function handleModelCmd(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Non autorise.");
    return;
  }
  const arg = parseArg(ctx)?.trim().toLowerCase();
  const envModel = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
  const effective = session.modelOverride || envModel;

  if (!arg) {
    await ctx.reply(
      `<b>Modele courant (topic)</b>\n` +
        `  <code>${effective}</code>${session.modelOverride ? " (override)" : " (defaut env)"}\n\n` +
        `<b>Options</b>\n` +
        `  /model haiku - rapide, 5x moins cher\n` +
        `  /model sonnet - equilibre (defaut)\n` +
        `  /model opus - maximum intelligence, plus cher\n` +
        `  /model default - utiliser le defaut du container`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (arg === "default" || arg === "reset") {
    session.modelOverride = null;
    saveSessionRegistry();
    await ctx.reply(
      `Override retire. Ce topic utilisera <code>${envModel}</code> (defaut env).`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const resolved = MODEL_ALIASES[arg] || arg;
  if (!resolved.startsWith("claude-")) {
    await ctx.reply(
      "Modele inconnu. Utilise haiku / sonnet / opus, ou un id <code>claude-...</code>.",
      { parse_mode: "HTML" },
    );
    return;
  }
  session.modelOverride = resolved;
  saveSessionRegistry();
  // La prochaine query utilisera le nouveau modele. Le sessionId actuel reste valable
  // (c'est Claude Code SDK qui gere le switch en interne via resume).
  await ctx.reply(
    `Modele du topic : <code>${resolved}</code>. Applique au prochain message.`,
    { parse_mode: "HTML" },
  );
}

// ====================================================================
// S12 — Background tasks commands
// ====================================================================

/**
 * /tasks - liste les taches en arriere-plan pour ce topic (+ optionnellement autres).
 * /tasks <id> - affiche les details + resultat d'une tache specifique.
 * /tasks kill <id> - annule une tache en cours.
 */
export async function handleTasksCmd(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Non autorise.");
    return;
  }
  const args = (ctx.message?.text ?? "").trim().split(/\s+/).slice(1);

  if (args[0] === "kill" && args[1]) {
    const ok = abortTask(args[1]);
    await ctx.reply(
      ok
        ? `Tache <code>${args[1]}</code> annulee.`
        : `Tache <code>${args[1]}</code> introuvable ou deja terminee.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (args[0] && args[0] !== "all") {
    const t = getTask(args[0]);
    if (!t) {
      await ctx.reply(`Tache <code>${args[0]}</code> introuvable.`, {
        parse_mode: "HTML",
      });
      return;
    }
    const duration = Math.round(
      ((t.endedAt ?? Date.now()) - t.startedAt) / 1000,
    );
    const body =
      `<b>Tache</b> <code>${t.id}</code>\n` +
      `etat : ${t.state}\n` +
      `topic : <code>${t.sessionKey}</code>\n` +
      `duree : ${duration}s\n` +
      `subagent : ${t.subagentType ?? "-"}\n` +
      `description : ${t.description.slice(0, 300)}`;
    await ctx.reply(body, { parse_mode: "HTML" });
    return;
  }

  const showAll = args[0] === "all";
  const list = showAll ? listTasks() : listTasks(session.sessionKey);

  if (list.length === 0) {
    await ctx.reply(
      showAll
        ? "Aucune tache en arriere-plan."
        : "Aucune tache en arriere-plan pour ce topic. Utilise <code>/tasks all</code> pour voir les autres topics.",
      { parse_mode: "HTML" },
    );
    return;
  }

  const lines: string[] = [
    `<b>Taches en arriere-plan (${list.length}${showAll ? " tous topics" : " ce topic"})</b>\n`,
  ];
  for (const t of list
    .sort((a: BackgroundTask, b: BackgroundTask) => b.startedAt - a.startedAt)
    .slice(0, 15)) {
    const icon =
      t.state === "running"
        ? "⏳"
        : t.state === "completed"
          ? "✓"
          : t.state === "timeout"
            ? "⏱️"
            : "⚠️";
    const duration = Math.round(
      ((t.endedAt ?? Date.now()) - t.startedAt) / 1000,
    );
    const suffix = t.subagentType ? ` [${t.subagentType}]` : "";
    lines.push(
      `${icon} <code>${t.id}</code>${suffix} · ${duration}s · ${t.description.slice(0, 60)}`,
    );
  }
  lines.push(
    "",
    "<i>/tasks &lt;id&gt; pour details · /tasks kill &lt;id&gt; pour annuler</i>",
  );
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

// Suppress unused-import warning for existsSync in some TS setups (helper for future use).
void existsSync;
