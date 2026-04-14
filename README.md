# ask

Pipe-friendly AI for Unix and PowerShell pipelines. Sends stdin to a local [Ollama](https://ollama.com) model and writes the response to stdout — nothing else.

## Install

```bash
npm install -g .
```

Requires Node 18+ and [Ollama](https://ollama.com) running locally.

## Usage

```bash
ask [options] -p "prompt"
```

| Option | Short | Default | Description |
|---|---|---|---|
| `--prompt` | `-p` | *(required)* | The instruction |
| `--model` | `-m` | `gemma4:latest` | Ollama model to use |
| `--format` | `-f` | `text` | Output hint: `text` `json` `csv` `markdown` |
| `--system` | `-s` | | System prompt override |
| `--temperature` | `-t` | `0.1` | Sampling temperature |
| `--raw` | | | Skip output trimming and fence-stripping |
| `--ollama-url` | | `http://localhost:11434` | Ollama endpoint |

## Config file

You can set defaults in `~/.ask-cli/config.json` so you don't have to pass flags every time:

```json
{
  "model": "llama3.2",
  "ollamaUrl": "http://192.168.1.10:11434"
}
```

| Key | Description |
|---|---|
| `model` | Default model (overridden by `-m`) |
| `ollamaUrl` | Ollama endpoint (overridden by `--ollama-url`) |

The file is optional — if it doesn't exist, the built-in defaults apply. CLI flags always take priority over config values.

## Design principles

- **stdout is sacred** — only LLM output goes to stdout; status and errors go to stderr so pipes stay clean
- **Streaming** — text output starts printing as tokens arrive
- **Deterministic** — temperature defaults to `0.1` for consistent piped results
- **Zero config** — works out of the box if Ollama is running locally
- **Stateless** — each invocation is independent; context comes from stdin

## Examples

### Finance

```bash
# Extract food transactions, then total by merchant
cat bank-transactions.json \
  | ask -p "extract all food and restaurant transactions" -f json \
  | ask -p "create a total for each merchant" -f json

# Find largest expenses this month
cat transactions.csv | ask -p "find the 5 largest transactions and explain each one"
```

### DevOps

```bash
# Which pods are crash-looping? Generate fix commands and run them.
kubectl get pods -o json \
  | ask -p "which pods are in CrashLoopBackOff?" \
  | ask -p "generate kubectl delete commands for each" \
  | sh

# Summarize recent deployment events
kubectl get events --sort-by='.lastTimestamp' -o json \
  | ask -p "summarize any warnings or failures in plain English"

# Check resource pressure
kubectl top nodes | ask -p "which nodes are above 80% CPU or memory?"
```

### Security

```bash
# Spot suspicious SSH activity in today's logs
journalctl --since today | ask -p "find suspicious SSH login attempts, include source IPs and usernames"

# Group and count by attacker IP
journalctl --since today \
  | ask -p "find failed SSH attempts" \
  | ask -p "group by source IP and count attempts, sort descending" -f json

# Review a diff before merging
git diff main | ask -p "review this diff for bugs, security issues, and unintended side effects"
```

### Data wrangling

```bash
# Find inventory gaps
cat inventory.csv | ask -p "find all devices without a DHCP reservation" -f csv

# Normalize inconsistent data
cat contacts.csv | ask -p "standardize all phone numbers to E.164 format" -f csv

# Cross-reference two files
cat products.json | ask -p "which of these products are missing from the price list below" \
  -s "$(cat price-list.txt)"
```

### Code

```bash
# Explain a file
cat src/auth.ts | ask -p "explain what this file does in 3 bullet points"

# Generate a commit message from staged changes
git diff --staged | ask -p "write a concise git commit message for these changes"

# Find potential issues in a script
cat deploy.sh | ask -p "what could go wrong when this script runs in production?"
```

### Home automation

```bash
# Decide whether a Frigate camera event is worth a notification
mosquitto_sub -t frigate/events -C 1 \
  | ask -p "is this camera event worth notifying the homeowner? Reply yes or no and one sentence why."

# Summarize today's motion events
mosquitto_sub -t frigate/events -C 50 \
  | ask -p "summarize the activity captured today by camera location"
```

### Chaining with traditional tools

```bash
# LLM output feeds grep, awk, jq as normal
cat access.log | ask -p "extract all 5xx error lines" | grep -v "healthcheck"

# Mix ask with jq
cat api-response.json | jq '.items[]' | ask -p "which of these are expired?" -f json | jq length

# Use model output as shell commands (review first!)
cat report.txt | ask -p "write a bash one-liner to archive files older than 30 days"
```

## Format flag

The `-f` / `--format` flag tells the model what shape to produce. For `json` and `csv`, the full response is buffered and markdown fences are stripped automatically before writing to stdout, so downstream tools like `jq` and spreadsheet importers get clean input.

```bash
# Parsed by jq with no extra steps
echo "Paris, Tokyo, Lagos" | ask -p "as a JSON array" -f json | jq '.[0]'

# Ready to import as a spreadsheet
cat servers.txt | ask -p "convert to CSV with columns: hostname, role, os" -f csv > servers.csv
```

## Model selection

Any model available in your local Ollama installation works:

```bash
ask -p "translate to French" -m gemma3:12b
ask -p "summarize" -m llama3.2
ask -p "extract entities" -m mistral
```

List available models:

```bash
ollama list
```
