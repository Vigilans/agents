#!/usr/bin/env bash
# Override Agent model and permission inputs from per-subagent environment vars.
#
# Model override:
#   CLAUDE_CODE_SUBAGENT_<TYPE>_MODEL
#   - subagent_type is uppercased and hyphens become underscores
#   - missing subagent_type maps to GENERAL_PURPOSE
#
#   CLAUDE_CODE_SUBAGENT_<ALIAS>_MODEL
#   - applies whenever the effective model matches <ALIAS>, whether the model
#     was chosen explicitly or inherited
#   - a model declared in the subagent's definition frontmatter counts as an
#     explicit choice when the Agent call passes no model
#
#   CLAUDE_CODE_SUBAGENT_INHERIT_MODEL / CLAUDE_CODE_SUBAGENT_INHERIT_<ALIAS>_MODEL
#   - same, but only when the call picks no model (unset, "inherit", or
#     "default") and the definition declares none; the effective model is the
#     one that made the Agent call, read from the transcript
#
#   First match wins: <TYPE> > INHERIT_<ALIAS> > INHERIT > <ALIAS>
#   - CLAUDE_CODE_SUBAGENT_MODEL remains Claude Code's native global override
#   - custom model IDs are only injected when the active runtime does not
#     contain Agent updatedInput schema validation
#
# Permission mode override:
#   CLAUDE_CODE_SUBAGENT_MODE=<mode>
#   - Claude Code's native Agent modes pass through unchanged
#   - bypassPermissions+dontAsk extends them with a virtual mode
#   - Agent PreToolUse translates the virtual mode to bypassPermissions
#   - child PermissionRequest events are denied without prompting the user (dontAsk)
#   - main-thread and Agent Team permission handling remains unchanged

set -euo pipefail

INPUT=$(cat)
EVENT=$(jq -r '.hook_event_name // empty' <<<"$INPUT")
POLICY="${CLAUDE_CODE_SUBAGENT_MODE:-}"

supports_updated_input_without_schema_validation() {
    local runtime="" pid="$PPID" command status

    # ClawGod runs patched source under Bun; native Claude runs the executable.
    if [ -n "${CLAWGOD_DIR:-}" ] \
        && [ -r "$CLAWGOD_DIR/cli.original.cjs" ]; then
        runtime="$CLAWGOD_DIR/cli.original.cjs"
    elif [ -d /proc ]; then
        while [ "$pid" -gt 1 ]; do
            command=$(ps -o comm= -p "$pid" 2>/dev/null || true)
            if [ "$command" = claude ]; then
                runtime="/proc/$pid/exe"
                break
            fi
            pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
            [ -n "$pid" ] || break
        done
    elif [ -r "${CLAUDE_CODE_EXECPATH:-}" ]; then
        runtime="$CLAUDE_CODE_EXECPATH"
    fi

    # The ClawGod patch removes the strict-validation block containing this text.
    [ -r "$runtime" ] || return 1
    grep -aFq 'returned updatedInput that failed schema validation' \
        "$runtime" 2>/dev/null || status=$?
    [ "${status:-0}" -eq 1 ]
}

agent_calling_model() {
    local transcript="$1"
    [ -r "$transcript" ] || return 0

    # Poll for a main-thread assistant message to appear
    local deadline=$((SECONDS + 2))
    local model=""
    while [ $SECONDS -lt $deadline ]; do
        model=$(tail -200 "$transcript" 2>/dev/null | jq -rs '
            last(.[] | select(.isSidechain == false and .type == "assistant")
                | .message.model // empty) // empty' 2>/dev/null || true)
        [ -n "$model" ] && break
        sleep 0.05
    done
    printf '%s' "$model" # Model of the LLM response that made this Agent call.
}

agent_definition_model() {
    local subagent_type="$1" cwd="$2" dir file

    # Same precedence as Claude Code: project agents shadow user agents.
    # Built-in agents have no definition file and resolve as inherit.
    for dir in "$cwd/.claude/agents" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agents"; do
        file="$dir/$subagent_type.md"
        [ -r "$file" ] || continue
        sed -n '2,/^---$/{/^model:/{s/^model:[[:space:]]*//;s/[[:space:]]*$//;p;q}}' "$file"
        return 0
    done
}

model_id_to_alias() {
    local model="$1" key val base cfg
    [ -n "$model" ] && [ "$model" != "default" ] || return 0

    base="${model%%\[*}"
    while IFS='=' read -r key val; do
        case "$key" in
            ANTHROPIC_DEFAULT_*_MODEL)
                cfg="${val%%\[*}"
                if [ -n "$cfg" ]; then
                    case "$cfg" in *"$base"*|"$base"*)
                        printf '%s\n' "${key#ANTHROPIC_DEFAULT_}" | sed 's/_MODEL$//'
                        return 0 ;;
                    esac
                    case "$base" in *"$cfg"*)
                        printf '%s\n' "${key#ANTHROPIC_DEFAULT_}" | sed 's/_MODEL$//'
                        return 0 ;;
                    esac
                fi
                ;;
        esac
    done < <(env)

    case "${base,,}" in
        *opus*)   echo OPUS ;;
        *sonnet*) echo SONNET ;;
        *haiku*)  echo HAIKU ;;
        *fable*)  echo FABLE ;;
        *) tr '[:lower:]-.' '[:upper:]__' <<<"$base" ;;
    esac
}

case "$EVENT" in
PreToolUse)
    SUBAGENT_TYPE=$(jq -r '.tool_input.subagent_type // "general-purpose"' <<<"$INPUT")
    UPPER_NAME=$(tr '[:lower:]-' '[:upper:]_' <<<"$SUBAGENT_TYPE")
    MODEL=""
    if [[ "$UPPER_NAME" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then # CLAUDE_CODE_SUBAGENT_<TYPE>_MODEL
        MODEL_VAR="CLAUDE_CODE_SUBAGENT_${UPPER_NAME}_MODEL"
        MODEL="${!MODEL_VAR:-}"
    fi

    if [ -z "$MODEL" ]; then # CLAUDE_CODE_SUBAGENT_<ALIAS>_MODEL
        REQUESTED=$(jq -r '.tool_input.model // empty' <<<"$INPUT")
        if [ -z "$REQUESTED" ]; then
            REQUESTED=$(agent_definition_model "$SUBAGENT_TYPE" \
                "$(jq -r '.cwd // empty' <<<"$INPUT")")
        fi
        case "$REQUESTED" in
            ""|inherit|default)
                # Inherit-like calls (unset, "inherit", "default") resolve through the inherited model's alias
                EFFECTIVE=$(agent_calling_model \
                    "$(jq -r '.transcript_path // empty' <<<"$INPUT")")
                ALIAS=$(model_id_to_alias "$EFFECTIVE")
                if [ -n "$ALIAS" ]; then
                    MODEL_VAR="CLAUDE_CODE_SUBAGENT_INHERIT_${ALIAS}_MODEL"
                    MODEL="${!MODEL_VAR:-}"
                fi
                if [ -z "$MODEL" ]; then
                    MODEL="${CLAUDE_CODE_SUBAGENT_INHERIT_MODEL:-}"
                fi
                ;;
            *)
                # Explicit model choices are matched against <ALIAS> directly.
                ALIAS=$(model_id_to_alias "$REQUESTED")
                ;;
        esac
        if [ -z "$MODEL" ] && [ -n "$ALIAS" ]; then
            MODEL_VAR="CLAUDE_CODE_SUBAGENT_${ALIAS}_MODEL"
            MODEL="${!MODEL_VAR:-}"
        fi
    fi

    if [ -n "$MODEL" ] \
        && ! supports_updated_input_without_schema_validation; then
        MODEL=""
    fi

    # The virtual policy is never passed to Claude Code's native mode schema.
    MODE="$POLICY"
    if [ "$MODE" = bypassPermissions+dontAsk ]; then
        if [ -n "${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-}" ] \
            && [ -n "$(jq -r '.tool_input.name // empty' <<<"$INPUT")" ]; then
            MODE=""
        else
            MODE=bypassPermissions
        fi
    fi

    [ -n "$MODEL" ] || [ -n "$MODE" ] || exit 0
    UPDATED=$(jq -c --arg model "$MODEL" --arg mode "$MODE" '
        .tool_input
        | if $model != "" then .model = $model else . end
        | if $mode != "" then .mode = $mode else . end
    ' <<<"$INPUT")

    jq -nc --argjson input "$UPDATED" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: $input
      }
    }'
    ;;

PermissionRequest)
    [ "$POLICY" = bypassPermissions+dontAsk ] || exit 0

    # agent_id is present only inside a child Agent. The main thread keeps its
    # normal permission prompt, so dontAsk applies only to subagent requests.
    [ -n "$(jq -r '.agent_id // empty' <<<"$INPUT")" ] || exit 0

    SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
    ASK_RULES=$(jq -r '
        .permissions.ask // []
        | map(select(type == "string") | "- " + .)
        | join("\n")
    ' "$SETTINGS" 2>/dev/null || true)

    MESSAGE=$(printf '%s\n' \
        "Avoid commands and tools that require user approval; use an alternative and continue when possible.")
    if [ -n "$ASK_RULES" ]; then
        MESSAGE=$(printf '%s\n\nConfigured commands that require user approval:\n%s\n' \
            "$MESSAGE" "$ASK_RULES")
    fi
    MESSAGE=$(printf '%s\n\n%s' "$MESSAGE" \
        "If this action is essential and unavoidable, report the exact action, its purpose, and why it is necessary to the main agent. The main agent must ask the user and perform the action after approval.")

    jq -nc --arg message "$MESSAGE" '{
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: $message,
          interrupt: false
        }
      }
    }'
    ;;
esac
