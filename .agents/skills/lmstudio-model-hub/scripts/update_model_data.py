"""Update LM Studio's model-data.json to register a hub entry and mark GGUF as transitive."""
import argparse
import json
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Register hub model in LM Studio model-data.json")
    parser.add_argument("--lmstudio-dir", required=True, help="Path to .lmstudio directory")
    parser.add_argument("--hub-id", required=True, help="Hub ID in format 'publisher/model-name'")
    parser.add_argument("--gguf-key", required=True, help="GGUF key in format 'hf-publisher/repo/filename.gguf'")
    args = parser.parse_args()

    model_data_path = Path(args.lmstudio_dir) / ".internal" / "model-data.json"
    if not model_data_path.exists():
        print(f"ERROR: {model_data_path} not found", file=sys.stderr)
        sys.exit(1)

    with open(model_data_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    entries = data["json"]
    existing_keys = {e[0] for e in entries}
    changes = []

    owner, name = args.hub_id.split("/", 1)

    if args.hub_id not in existing_keys:
        entries.append([args.hub_id, {
            "source": {
                "type": "hub",
                "url": f"https://lmstudio.ai/models/{args.hub_id}",
                "owner": owner,
                "name": name
            },
            "transitive": False
        }])
        changes.append(f"ADD hub: {args.hub_id}")
    else:
        print(f"SKIP hub (exists): {args.hub_id}")

    for entry in entries:
        if entry[0] == args.gguf_key:
            if not entry[1].get("transitive"):
                entry[1]["transitive"] = True
                changes.append(f"SET transitive: {args.gguf_key}")
            else:
                print(f"SKIP transitive (already set): {args.gguf_key}")
            break
    else:
        print(f"WARN: GGUF key not found in model-data.json: {args.gguf_key}")
        print("  The model may need to be loaded once in LM Studio first.")

    if changes:
        with open(model_data_path, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
        for c in changes:
            print(c)
    else:
        print("No changes needed.")


if __name__ == "__main__":
    main()
