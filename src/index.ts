/**
 * Claude Telegram Bot - TypeScript/Bun Edition
 *
 * Control Claude Code from your phone via Telegram.
 */

import { Bot } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { autoRetry } from "@grammyjs/auto-retry";
import {
  TELEGRAM_TOKEN,
  WORKING_DIR,
  ALLOWED_USERS,
  RESTART_FILE,
} from "./config";
import { unlinkSync, readFileSync, writeFileSync, existsSync } from "fs";
import {
  handleStart,
  handleNew,
  handleStop,
  handleStatus,
  handleResume,
  handleRestart,
  handleRetry,
  handleText,
  handleVoice,
  handlePhoto,
  handleDocument,
  handleAudio,
  handleVideo,
  handleCallback,
} from "./handlers";
import {
  handleApprove,
  handleDeny,
  handleHelp,
  handleSessions,
  handlePermissions,
  handleIntercept,
  handleTrust,
  handleRevoke,
  handleForbid,
  handleVoiceCmd,
  handleVoicesCmd,
  handleModelCmd,
} from "./handlers/commands";
import { setBotRef } from "./botRef";
import { loadSessionRegistry, sessionRegistry } from "./session";
import {
  PERMISSION_REPLY_RE,
  resolveApprovalByShortCode,
} from "./handlers/approval";
import type { ApprovalChoice } from "./permissions";
// S11 Pattern 5: bot.pid orphan killer (ported from claude-plugins-official/telegram).
// Telegram Bot API allows exactly one getUpdates consumer per token. If the
// previous process crashed (OOM, SIGKILL, Coolify forced stop), its poller
// can survive as a zombie and keep holding the slot, so every new start hits
// 409 Conflict. We kill any stale holder before we start polling.
const BOT_PID_FILE = process.env.ECOSYS_BOT_PID_FILE || "/tmp/ecosys-bot.pid";
try {
  if (existsSync(BOT_PID_FILE)) {
    const stale = parseInt(readFileSync(BOT_PID_FILE, "utf-8"), 10);
    if (stale > 1 && stale !== process.pid) {
      try {
        process.kill(stale, 0); // check if alive (no signal sent)
        console.warn(`[boot] replacing stale poller pid=${stale}`);
        process.kill(stale, "SIGTERM");
      } catch {
        // already dead or no perm, nothing to do
      }
    }
  }
} catch (error) {
  console.warn("[boot] stale check failed:", error);
}
try {
  writeFileSync(BOT_PID_FILE, String(process.pid));
} catch (error) {
  console.warn("[boot] failed to write pid file:", error);
}

// Create bot instance
const bot = new Bot(TELEGRAM_TOKEN);

// Auto-retry on Telegram rate limits (429) and transient network errors.
// Telegram enforces flood control; without this the bot crashes on long streaming
// or rapid tool message bursts. The plugin respects retry_after from Telegram
// and caps attempts / delay so we don't deadlock forever.
bot.api.config.use(
  autoRetry({
    maxRetryAttempts: 3,
    maxDelaySeconds: 60,
  }),
);

// Expose bot reference for modules that need to send messages outside a Context
// (e.g. approval.ts triggered from canUseTool callback).
setBotRef(bot);

// S11 Pattern 4: ackReaction (emoji 👀 acknowledging receipt) ported from
// claude-plugins-official/telegram. Gives the user immediate visual feedback
// that the bot saw the message, even before processing starts. Telegram
// silently drops emojis not on its whitelist, so we default to a safe one.
// Disable with ECOSYS_ACK_REACTION="" (empty).
const ACK_REACTION = process.env.ECOSYS_ACK_REACTION ?? "👀";
if (ACK_REACTION) {
  bot.use(async (ctx, next) => {
    if (ctx.message?.message_id) {
      try {
        await ctx.react(ACK_REACTION as Parameters<typeof ctx.react>[0]);
      } catch {
        // silent fail (non-whitelisted emoji, no permission, etc.)
      }
    }
    await next();
  });
}

// S11 Pattern 2: intercept text-based permission replies `y abcde` / `n abcde`
// BEFORE the sequentializer. Matches the short_code of a pending approval and
// resolves it without sending the message to Claude. Mobile-friendly fallback
// when inline buttons are inconvenient (ported from official plugin).
bot.on("message:text", async (ctx, next) => {
  const text = ctx.message?.text ?? "";
  const match = text.match(PERMISSION_REPLY_RE);
  if (!match) return next();
  const chatId = ctx.chat?.id;
  if (!chatId) return next();
  const verb = match[1]!.toLowerCase();
  const code = match[2]!.toLowerCase();
  const choice: ApprovalChoice =
    verb === "y" || verb === "yes" ? "once" : "deny";
  const resolved = resolveApprovalByShortCode(chatId, code, choice);
  if (resolved) {
    const label = choice === "once" ? "approuvee" : "refusee";
    await ctx.reply(`Permission ${label} via code <code>${code}</code>.`, {
      parse_mode: "HTML",
    });
    return; // short-circuit: do not forward to Claude
  }
  // No matching pending approval — fall through as a normal text message.
  return next();
});

// Sequentialize non-command messages per user (prevents race conditions)
// Commands bypass sequentialization so they work immediately
bot.use(
  sequentialize((ctx) => {
    // Commands are not sequentialized - they work immediately
    if (ctx.message?.text?.startsWith("/")) {
      return undefined;
    }
    // Messages with ! prefix bypass queue (interrupt)
    if (ctx.message?.text?.startsWith("!")) {
      return undefined;
    }
    // Callback queries (button clicks) are not sequentialized
    if (ctx.callbackQuery) {
      return undefined;
    }
    // Other messages are sequentialized per chat
    return ctx.chat?.id.toString();
  }),
);

// ============== Command Handlers ==============

bot.command("start", handleStart);
bot.command("new", handleNew);
bot.command("stop", handleStop);
bot.command("status", handleStatus);
bot.command("resume", handleResume);
bot.command("restart", handleRestart);
bot.command("retry", handleRetry);
bot.command("help", handleHelp);
bot.command("approve", handleApprove);
bot.command("deny", handleDeny);
bot.command("sessions", handleSessions);
bot.command("permissions", handlePermissions);
bot.command("intercept", handleIntercept);
bot.command("trust", handleTrust);
bot.command("revoke", handleRevoke);
bot.command("forbid", handleForbid);
bot.command("voice", handleVoiceCmd);
bot.command("voices", handleVoicesCmd);
bot.command("model", handleModelCmd);

// ============== Message Handlers ==============

// Text messages
bot.on("message:text", handleText);

// Voice messages
bot.on("message:voice", handleVoice);

// Photo messages
bot.on("message:photo", handlePhoto);

// Document messages
bot.on("message:document", handleDocument);

// Audio messages
bot.on("message:audio", handleAudio);

// Video messages (regular videos and video notes)
bot.on("message:video", handleVideo);
bot.on("message:video_note", handleVideo);

// ============== Callback Queries ==============

bot.on("callback_query:data", handleCallback);

// ============== Error Handler ==============

bot.catch((err) => {
  console.error("Bot error:", err);
});

// ============== Startup ==============

console.log("=".repeat(50));
console.log("Claude Telegram Bot - TypeScript Edition");
console.log("=".repeat(50));
console.log(`Working directory: ${WORKING_DIR}`);
console.log(`Allowed users: ${ALLOWED_USERS.length}`);
console.log("Starting bot...");

// Load persisted sessions registry (S7).
loadSessionRegistry();

// Get bot info first
const botInfo = await bot.api.getMe();
console.log(`Bot started: @${botInfo.username}`);

// Register slash menu natively with Telegram (QW1).
// Users get autocomplete when typing / in the chat.
try {
  await bot.api.setMyCommands([
    {
      command: "new",
      description: "Nouvelle session (reset memoire + history)",
    },
    { command: "stop", description: "Stopper la requete en cours" },
    { command: "status", description: "Etat de la session actuelle" },
    { command: "resume", description: "Reprendre la derniere session" },
    { command: "retry", description: "Relancer le dernier message" },
    { command: "restart", description: "Redemarrer le bot" },
    {
      command: "approve",
      description: "Approuver la derniere demande (une fois)",
    },
    { command: "deny", description: "Refuser la derniere demande" },
    {
      command: "sessions",
      description: "Liste des sessions actives (par topic)",
    },
    {
      command: "permissions",
      description: "Voir les permissions du topic courant",
    },
    {
      command: "intercept",
      description: "Forcer l'approval sur un tool (ex: /intercept WebFetch)",
    },
    {
      command: "trust",
      description: "Auto-approuver un pattern (ex: /trust rm-rf-generic)",
    },
    {
      command: "revoke",
      description: "Retirer des permissions (ex: /revoke WebFetch)",
    },
    {
      command: "forbid",
      description: "Interdire un tool sans demander (ex: /forbid sudo)",
    },
    {
      command: "voice",
      description: "Toggle voix ou changer (ex: /voice fr-FR-HenriNeural)",
    },
    { command: "voices", description: "Liste des voix FR disponibles" },
    {
      command: "model",
      description: "Switch de modele (haiku / sonnet / opus)",
    },
    { command: "help", description: "Aide et commandes disponibles" },
  ]);
  console.log("setMyCommands: menu slash enregistre");
} catch (e) {
  console.warn("setMyCommands failed:", e);
}

// Notify each active session of the restart (unplanned Coolify redeploy,
// crash restart, etc). Users need to know the bot reloaded, otherwise they
// might keep chatting assuming context continuity while Claude has actually
// resumed from persisted sessionId (which may or may not still hold the
// full conversation depending on Anthropic-side retention).
//
// Throttle: skip if a notification was sent less than RESTART_NOTIFY_MIN_INTERVAL_MS
// ago to avoid spamming during crash loops.
const RESTART_NOTIFY_MIN_INTERVAL_MS = 60_000;
const restartMarker = "/tmp/ecosys-last-restart-notify.ts";
const shouldNotifyRestart = await (async () => {
  try {
    if (existsSync(restartMarker)) {
      const lastTs = parseInt(readFileSync(restartMarker, "utf-8").trim(), 10);
      if (
        !isNaN(lastTs) &&
        Date.now() - lastTs < RESTART_NOTIFY_MIN_INTERVAL_MS
      ) {
        console.log("[restart] last notify was recent, skipping");
        return false;
      }
    }
    return true;
  } catch {
    return true;
  }
})();

if (shouldNotifyRestart && sessionRegistry.size > 0) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  let notified = 0;
  for (const [sessionKey, s] of sessionRegistry.entries()) {
    if (!s.sessionId) continue;
    const [chatStr, threadStr] = sessionKey.split(":");
    const chatId = parseInt(chatStr ?? "", 10);
    const threadId = parseInt(threadStr ?? "0", 10);
    if (!chatId || isNaN(chatId)) continue;
    try {
      await bot.api.sendMessage(
        chatId,
        `<i>Bot redeploye a ${timeStr}. Je tente de reprendre la session precedente (<code>${s.sessionId.slice(0, 8)}...</code>). Si je ne me souviens pas de notre conversation, tape /new pour repartir de zero.</i>`,
        {
          parse_mode: "HTML",
          ...(threadId > 0 ? { message_thread_id: threadId } : {}),
        },
      );
      notified++;
    } catch (e) {
      console.warn(`[restart] failed to notify session ${sessionKey}:`, e);
    }
  }
  if (notified > 0) {
    try {
      await Bun.write(restartMarker, String(Date.now()));
    } catch {
      // ignore
    }
    console.log(`[restart] notified ${notified} session(s)`);
  }
}

// Check for pending restart message to update
if (existsSync(RESTART_FILE)) {
  try {
    const data = JSON.parse(readFileSync(RESTART_FILE, "utf-8"));
    const age = Date.now() - data.timestamp;

    // Only update if restart was recent (within 30 seconds)
    if (age < 30000 && data.chat_id && data.message_id) {
      await bot.api.editMessageText(
        data.chat_id,
        data.message_id,
        "✅ Bot restarted",
      );
    }
    unlinkSync(RESTART_FILE);
  } catch (e) {
    console.warn("Failed to update restart message:", e);
    try {
      unlinkSync(RESTART_FILE);
    } catch {}
  }
}

// Start with concurrent runner (commands work immediately)
const runner = run(bot);

// Graceful shutdown
const stopRunner = () => {
  if (runner.isRunning()) {
    console.log("Stopping bot...");
    runner.stop();
  }
  // Clean up pid file if it's ours (ignore if someone else took over)
  try {
    if (existsSync(BOT_PID_FILE)) {
      const owner = parseInt(readFileSync(BOT_PID_FILE, "utf-8"), 10);
      if (owner === process.pid) unlinkSync(BOT_PID_FILE);
    }
  } catch {
    // best-effort cleanup
  }
};

process.on("SIGINT", () => {
  console.log("Received SIGINT");
  stopRunner();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM");
  stopRunner();
  process.exit(0);
});
