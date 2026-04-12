#!/usr/bin/env node
/**
 * ask — pipe-friendly AI CLI for Unix/PowerShell pipelines
 * Usage: cat file.txt | ask -p "summarize this"
 */

import { parseArgs } from 'node:util';

// ── Arg parsing ────────────────────────────────────────────────────────────────

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    prompt:       { type: 'string',  short: 'p' },
    model:        { type: 'string',  short: 'm', default: 'gemma4:latest' },
    format:       { type: 'string',  short: 'f', default: 'text' },
    system:       { type: 'string',  short: 's' },
    temperature:  { type: 'string',  short: 't', default: '0.1' },
    raw:          { type: 'boolean',             default: false },
    'ollama-url': { type: 'string',              default: 'http://localhost:11434' },
    help:         { type: 'boolean', short: 'h', default: false },
    version:      { type: 'boolean', short: 'v', default: false },
  },
});

// ── Help / version ─────────────────────────────────────────────────────────────

if (args.version) {
  process.stdout.write('ask-cli 1.0.0\n');
  process.exit(0);
}

if (args.help) {
  process.stderr.write(`
ask — pipe-friendly AI for Unix/PowerShell pipelines

Usage:
  ask [options] -p "prompt"
  echo "text" | ask -p "do something"

Options:
  -p, --prompt        The instruction (required)
  -m, --model         Model to use          (default: gemma4:latest)
  -f, --format        Output hint: text|json|csv|markdown  (default: text)
  -s, --system        System prompt override
  -t, --temperature   Sampling temperature  (default: 0.1)
      --raw           Skip output trimming/fence-stripping
      --ollama-url    Ollama base URL       (default: http://localhost:11434)
  -h, --help          Show this help
  -v, --version       Show version

Examples:
  cat bank.json | ask -p "extract food transactions" | ask -p "sum by merchant"
  git diff main   | ask -p "review for bugs and security issues"
  kubectl get pods -o json | ask -p "which pods are crash-looping?" | ask -p "generate delete commands" | sh
`);
  process.exit(0);
}

// ── Validate ───────────────────────────────────────────────────────────────────

// Allow prompt as a positional if -p was not supplied: `ask "do something"`
const prompt = args.prompt ?? positionals[0];

if (!prompt) {
  process.stderr.write('ask: error: -p/--prompt is required\n');
  process.stderr.write('Run `ask --help` for usage.\n');
  process.exit(1);
}

const temperature = parseFloat(args.temperature);
if (Number.isNaN(temperature)) {
  process.stderr.write(`ask: error: invalid temperature "${args.temperature}"\n`);
  process.exit(1);
}

// Formats that must buffer the full response before writing (to allow post-processing)
const BUFFERED_FORMATS = new Set(['json', 'csv']);

// ── Read stdin ─────────────────────────────────────────────────────────────────

async function readStdin() {
  // If stdin is a TTY there is nothing to read — that's fine, prompt-only mode.
  if (process.stdin.isTTY) return '';

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// ── Build messages ─────────────────────────────────────────────────────────────

function buildMessages(stdinText, prompt, format, systemOverride) {
  const formatHints = {
    json:     'Respond with valid, raw JSON only. No markdown fences. No explanation. No trailing text.',
    csv:      'Respond with valid CSV only. Include a header row. No markdown fences. No explanation.',
    markdown: 'Respond in clean Markdown.',
    text:     '',
  };

  const formatHint = formatHints[format] ?? '';

  const systemLines = [
    'You are a precise data-processing assistant embedded in a Unix pipeline.',
    'Output ONLY the requested result — no preamble, no sign-off, no apology.',
    'If the instruction is ambiguous, make the most useful assumption and proceed.',
    formatHint,
    systemOverride ?? '',
  ].filter(Boolean);

  const messages = [
    { role: 'system', content: systemLines.join('\n') },
  ];

  let userContent = stdinText.trim()
    ? `<input>\n${stdinText.trim()}\n</input>\n\n${prompt}`
    : prompt;

  messages.push({ role: 'user', content: userContent });
  return messages;
}

// ── Post-process output ────────────────────────────────────────────────────────

/**
 * Strip markdown code fences that models add despite instructions.
 * e.g.  ```json\n[...]\n```  →  [...]
 */
function stripFences(text) {
  return text
    .replace(/^```[a-z]*\s*\n?/i, '')  // opening fence
    .replace(/\n?```\s*$/,        '')  // closing fence
    .trim();
}

function postProcess(text, format, raw) {
  if (raw) return text;
  const cleaned = stripFences(text);
  return cleaned + (cleaned.endsWith('\n') ? '' : '\n');
}

// ── Stream from Ollama ─────────────────────────────────────────────────────────

async function streamOllama({ baseUrl, model, messages, temperature, buffered }) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: { temperature },
      }),
    });
  } catch (err) {
    const hint = err.cause?.code === 'ECONNREFUSED'
      ? `Is Ollama running at ${baseUrl}?`
      : err.message;
    process.stderr.write(`ask: connection error: ${hint}\n`);
    process.exit(1);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    process.stderr.write(`ask: Ollama error ${response.status}: ${body}\n`);
    process.exit(1);
  }

  const decoder = new TextDecoder();
  let lineBuffer = '';
  let totalContent = '';

  for await (const chunk of response.body) {
    lineBuffer += decoder.decode(chunk, { stream: true });
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop(); // retain incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }

      const token = parsed?.message?.content ?? '';
      if (token) {
        if (!buffered) process.stdout.write(token); // stream directly for text
        totalContent += token;
      }

      if (parsed.done) return totalContent;
    }
  }

  return totalContent;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  process.stderr.write(`ask: model=${args.model} format=${args.format} temp=${args.temperature}\n`);

  const stdinText = await readStdin();

  if (stdinText.trim()) {
    const lineCount = stdinText.trim().split('\n').length;
    process.stderr.write(`ask: received ${lineCount} line(s) from stdin\n`);
  }

  const messages = buildMessages(stdinText, prompt, args.format, args.system);
  const buffered = !args.raw && BUFFERED_FORMATS.has(args.format);

  const output = await streamOllama({
    baseUrl: args['ollama-url'],
    model: args.model,
    messages,
    temperature,
    buffered,
  });

  if (buffered) {
    // Write post-processed output all at once
    process.stdout.write(postProcess(output, args.format, args.raw));
  } else if (!args.raw && output && !output.endsWith('\n')) {
    // Ensure clean line ending for streamed text
    process.stdout.write('\n');
  }
}

main().catch((err) => {
  process.stderr.write(`ask: unexpected error: ${err.message}\n`);
  process.exit(1);
});
