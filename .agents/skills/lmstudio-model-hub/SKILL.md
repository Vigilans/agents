---
name: lmstudio-model-hub
description: Register a Hugging Face GGUF model in LM Studio's hub so it gets a clean `publisher/model-name` identifier in the `/v1/models` API. Use this skill when the user provides a HF repo (e.g. `unsloth/Qwen3.6-27B-GGUF`) and wants it properly registered with the original model author as publisher. Also use when the user mentions LM Studio model IDs lacking publisher names, or wants to clean up their LM Studio model list.
---

# LM Studio Model Registration

## What this skill does

LM Studio's `/v1/models` API returns model IDs without publisher prefixes by default (e.g. `qwen3.6-27b` instead of `qwen/qwen3.6-27b`). This skill creates "hub entries" that give models proper publisher-qualified identifiers and hide the raw GGUF-based IDs.

## LM Studio directory layout

```
~/.lmstudio/
├── models/                          # GGUF files, organized by HF publisher/repo
│   ├── unsloth/Qwen3.6-27B-GGUF/
│   │   ├── Qwen3.6-27B-Q6_K.gguf
│   │   └── ...
│   └── lmstudio-community/Qwen3.6-35B-A3B-GGUF/
│       └── Qwen3.6-35B-A3B-Q4_K_M.gguf
├── hub/models/                      # Hub entries (what we create)
│   └── qwen/qwen3.6-27b/
│       ├── manifest.json
│       └── model.yaml
└── .internal/
    └── model-data.json              # Tracks model metadata and transitive flags
```

## Workflow

### Step 1: Parse the input

Accept a HF repo identifier in any of these formats:
- `unsloth/Qwen3.6-27B-GGUF`
- `https://huggingface.co/unsloth/Qwen3.6-27B-GGUF`
- `https://hf-mirror.com/unsloth/Qwen3.6-27B-GGUF`

Extract `hf_publisher` (e.g. `unsloth`) and `hf_repo` (e.g. `Qwen3.6-27B-GGUF`).

### Step 2: Fetch model info from HF

Use the `hf` CLI to get model metadata:

```bash
hf models info <hf_publisher>/<hf_repo> --format json
```

Key fields to extract:
- `tags` — look for `base_model:<org>/<model>` to find the original author
- `gguf.architecture` — the GGUF architecture name (e.g. `qwen35moe`, `llama`, `qwen2`)
- `pipeline_tag` — `text-generation`, `image-text-to-text`, `feature-extraction`, etc.
- `config.model_type` — model architecture type
- `siblings` — list of files (check for `mmproj*.gguf` for vision support)

This is the most reliable way to determine the original author: the `base_model:` tag directly gives you the upstream repo (e.g. `base_model:Qwen/Qwen3.6-27B` → original author is `qwen`).

If `hf models info` is not available (older hf CLI version), use the HF API directly:
```bash
curl -s "https://huggingface.co/api/models/<hf_publisher>/<hf_repo>"
```

### Step 3: Check if the GGUF is downloaded

Look for `~/.lmstudio/models/<hf_publisher>/<hf_repo>/` containing `.gguf` files.

- If found: continue to step 4.
- If not found: tell the user the model isn't downloaded yet. Suggest:
  ```bash
  lms get <hf_publisher>/<hf_repo>
  ```
  or for HF direct download + import:
  ```bash
  hf download <hf_publisher>/<hf_repo> --include "*.gguf"
  lms import -L --user-repo "<hf_publisher>/<hf_repo>" <path-to-gguf>
  ```
  Stop here until the model is available.

### Step 4: Determine the hub ID

The hub ID has the format `<original_author>/<model_name>` (all lowercase).

#### Derive model_name

Strip these suffixes from `hf_repo` (case-insensitive), then lowercase:
- `-GGUF`
- Quantization suffixes: `-Q4_K_M`, `-Q4_K_S`, `-Q5_K_S`, `-Q5_K_M`, `-Q6_K`, `-Q8_0`, `-Q4`, `-IQ4_XS`, etc. (pattern: `-Q\d+.*` or `-IQ\d+.*` at the end)

Examples:
- `Qwen3.6-27B-GGUF` → `qwen3.6-27b`
- `Qwen3.6-35B-A3B-GGUF` → `qwen3.6-35b-a3b`
- `Sakura-14B-Qwen3-v1.5-Q5_K_S` → `sakura-14b-qwen3-v1.5`

#### Derive original_author

**Known quantizer-only publishers** — these just quantize/convert other people's models, so the original author must be inferred from the model name:

| HF Publisher | Role |
|---|---|
| `lmstudio-community` | LM Studio's official GGUF conversions |
| `unsloth` | Quantization with improved calibration |
| `bartowski` | GGUF conversions |
| `TheBloke` | GGUF/GPTQ conversions |
| `mradermacher` | GGUF conversions |
| `mmnga` | Japanese model GGUF conversions |

For these publishers, infer the original author from the model name:
- `Qwen3.5-*` → `qwen` (Alibaba Qwen team)
- `Llama-*`, `Meta-Llama-*` → `meta-llama`
- `gemma-*` → `google`
- `Phi-*` → `microsoft`
- `Mistral-*`, `Mixtral-*` → `mistralai`
- `GLM-*`, `ChatGLM-*` → `thudm`
- `DeepSeek-*` → `deepseek-ai`
- `Yi-*` → `01-ai`
- `Falcon-*` → `tiiuae`
- `StarCoder*`, `StarChat*` → `bigcode`
- `Command-*` → `cohere`
- `gpt-oss-*` → `openai`
- `nomic-embed-*` → `nomic-ai`
- `Nemotron-*` → `nvidia`

If the HF publisher is NOT in the known quantizer list, they are likely the original author or a fine-tuner — use `hf_publisher` lowercased as `original_author`.

#### Confirm with user

Present the proposed mapping:
```
HF repo:     unsloth/Qwen3.6-27B-GGUF
Hub ID:      qwen/qwen3.6-27b
Publisher:   qwen (original: Alibaba Qwen team)
Model name:  qwen3.6-27b
```

Wait for user confirmation before proceeding. The user may want to adjust the publisher or model name.

### Step 5: Check for existing hub entry

Look for `~/.lmstudio/hub/models/<original_author>/<model_name>/manifest.json`.

If it already exists, tell the user and ask if they want to overwrite.

### Step 6: Detect model metadata

Use the info fetched in step 2 to populate metadata. Priority: HF API data > filename heuristics.

- **domain**: `embedding` if `pipeline_tag` is `feature-extraction` or name contains `embed`, otherwise `llm`
- **architecture**: use `gguf.architecture` from HF API (e.g. `qwen35moe`, `llama`, `qwen2`)
- **paramsStrings**: extract size like `27B`, `0.6B`, `14B`, `7B` from the model name
- **vision**: true if `pipeline_tag` is `image-text-to-text`, or there's a `mmproj*.gguf` in siblings
- **reasoning**: true for recent reasoning-capable models (Qwen3+, etc.)
- **trainedForToolUse**: true for instruct/chat models of capable families

Present the detected metadata to the user for confirmation alongside the hub ID in step 3.

### Step 7: Create hub entry files

Create directory `~/.lmstudio/hub/models/<original_author>/<model_name>/`.

#### manifest.json

```json
{
  "type": "model",
  "owner": "<original_author>",
  "name": "<model_name>",
  "dependencies": [
    {
      "type": "model",
      "purpose": "baseModel",
      "modelKeys": [
        "<hf_publisher_lower>/<hf_repo_lower>"
      ],
      "sources": [
        {
          "type": "huggingface",
          "user": "<hf_publisher>",
          "repo": "<hf_repo>"
        }
      ]
    }
  ],
  "revision": 1
}
```

`modelKeys` must be fully lowercased (`unsloth/qwen3.5-122b-a10b-gguf`).

#### model.yaml

```yaml
model: <original_author>/<model_name>
base:
  - key: <hf_publisher_lower>/<hf_repo_lower>
    sources:
      - type: huggingface
        user: <hf_publisher>
        repo: <hf_repo>
metadataOverrides:
  domain: <domain>
  architectures:
    - <architecture>
  compatibilityTypes:
    - gguf
  paramsStrings:
    - <params>
  vision: <true|false>
  reasoning: <true|false>
  trainedForToolUse: <true|false>
```

For **LLM models** (not embedding), always append thinking customFields so users can toggle thinking mode in the UI:

```yaml
customFields:
  - key: enableThinking
    displayName: Enable Thinking
    description: Controls whether the model will think before replying
    type: boolean
    defaultValue: true
    effects:
      - type: setJinjaVariable
        variable: enable_thinking
  - key: preserveThinking
    displayName: Preserve Thinking
    description: Preserve reasoning content in all prior assistant turns instead of only the most recent one
    type: boolean
    defaultValue: false
    effects:
      - type: setJinjaVariable
        variable: preserve_thinking
```

This requires the model's chat template to support the `enable_thinking` jinja variable (Qwen3+ and similar models do). Check with `hf models info` — if the GGUF's `chat_template` field does not contain `enable_thinking`, do NOT add this customFields block.

### Step 8: Update model-data.json

Run the bundled script:

```bash
python3 "<skill_dir>/scripts/update_model_data.py" \
  --lmstudio-dir "<lmstudio_dir>" \
  --hub-id "<original_author>/<model_name>" \
  --gguf-key "<hf_publisher>/<hf_repo>/<main_gguf_filename>"
```

This script:
1. Adds a hub source entry for the hub ID (if not exists)
2. Marks the GGUF entry as `transitive: true` (so the bare ID disappears from `/v1/models`)

If the script is not available, do it manually:

Read `~/.lmstudio/.internal/model-data.json`. It has this structure:
```json
{"json": [["key", {...metadata...}], ...], "meta": {"values": ["map"]}}
```

Add/update two entries in the `json` array:

1. **Hub entry** (add if the hub ID key doesn't exist):
   ```json
   ["<original_author>/<model_name>", {
     "source": {
       "type": "hub",
       "url": "https://lmstudio.ai/models/<original_author>/<model_name>",
       "owner": "<original_author>",
       "name": "<model_name>"
     },
     "transitive": false
   }]
   ```

2. **GGUF entry** (find existing entry matching the GGUF path and set transitive):
   ```json
   ["<hf_publisher>/<hf_repo>/<gguf_filename>", {
     ...existing fields...,
     "transitive": true
   }]
   ```
   The GGUF key format is `<hf_publisher>/<hf_repo>/<filename>.gguf`. For split models, use the first shard (`*-00001-of-*.gguf`).

### Step 9: Verify

Query the LM Studio API to confirm registration. Set `LM_API_URL` if LM Studio runs on a remote host (defaults to `http://localhost:1234`). Include `LM_API_TOKEN` if auth is enabled, otherwise omit the header.

```bash
# With auth
curl -s -H "Authorization: Bearer $LM_API_TOKEN" "${LM_API_URL:-http://localhost:1234}/v1/models" | jq '.data[].id'

# Without auth
curl -s "${LM_API_URL:-http://localhost:1234}/v1/models" | jq '.data[].id'
```

The user may need to restart LM Studio first. Check that:
1. The new `<publisher>/<model-name>` ID appears
2. The old bare ID (without publisher) is gone

## Useful commands reference

### LM Studio CLI (`lms`)

| Command | Purpose |
|---|---|
| `lms get <publisher>/<model>` | Download from LM Studio Hub (e.g. `lms get qwen/qwen3.5-0.8b`) |
| `lms get <hf-publisher>/<hf-repo>` | Download from HF via LM Studio |
| `lms import -L --user-repo "<pub>/<repo>" <path>` | Hard-link an existing GGUF into LM Studio |
| `lms import -c --user-repo "<pub>/<repo>" <path>` | Copy a GGUF into LM Studio |
| `lms ls` | List local models |
| `lms ls --json` | List with full metadata (publisher, arch, quant, etc.) |
| `lms server status` | Check if the API server is running |

### Hugging Face CLI (`hf`)

| Command | Purpose |
|---|---|
| `hf download <repo> --include "*.gguf"` | Download GGUF files from HF |
| `hf download <repo> --local-dir <dir>` | Download to specific directory |
| `hf models info <repo>` | Get model metadata (tags, architecture, pipeline) |
| `hf models info <repo> --format json` | JSON output for parsing |
| `hf models list --author <org> --filter gguf` | List GGUF models by author |

Set `HF_ENDPOINT=https://hf-mirror.com` for mirror access in restricted networks.

## Batch mode

If the user wants to register all unregistered models at once, scan `~/.lmstudio/models/` for all GGUF directories, check which ones lack hub entries, and present the full mapping table for confirmation before creating anything.
