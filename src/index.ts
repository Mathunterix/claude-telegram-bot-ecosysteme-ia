/**
 * Claude Telegram Bot - TypeScript/Bun Edition
 *
 * Control Claude Code from your phone via Telegram.
 */

import { Bot } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import {
  TELEGRAM_TOKEN,
  WORKING_DIR,
  ALLOWED_USERS,
  RESTART_FILE,
} from "./config";
import { unlinkSync, readFileSync, existsSync } from "fs";
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
} from "./handlers/commands";
import { setBotRef } from "./botRef";
import { loadSessionRegistry } from "./session";

// Create bot instance
const bot = new Bot(TELEGRAM_TOKEN);

// Expose bot reference for modules that need to send messages outside a Context
// (e.g. approval.ts triggered from canUseTool callback).
setBotRef(bot);

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
    { command: "help", description: "Aide et commandes disponibles" },
  ]);
  console.log("setMyCommands: menu slash enregistre");
} catch (e) {
  console.warn("setMyCommands failed:", e);
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
