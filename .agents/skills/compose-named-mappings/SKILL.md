---
name: compose-named-mappings
description: >
  Write Docker Compose YAML files using the Named Mappings interpolation feature from the
  Vigilans/compose fork. Named Mappings extend `${VAR}` syntax with `${name[key]}` (bash
  associative array style) to reference project metadata, service identity, secrets data,
  cross-service values, and file-relative paths — all resolved after merge.

  Use this skill whenever the user is writing, editing, or reviewing compose.yml files that
  use `${name[key]}` syntax, or when they need to use features like `${compose[root-dir]}`,
  `${project[name]}`, `${service[name]}`, `${secrets[...]}`, `${labels[...]}`,
  `${env[...]}`, `${services[...][...]}`, or `${container[...]}`. Also use this skill when
  the user asks about compose interpolation beyond standard `${VAR}` syntax, or when they
  mention "named mappings", "compose fork", or want to reference contextual/internal values
  in their compose files. If the user is working in a project that already uses `${name[key]}`
  patterns in its compose files, proactively apply this skill.
---

# Compose Named Mappings

This skill covers the **Named Mappings** feature — a fork extension to Docker Compose that
introduces `${name[key]}` interpolation syntax. It is implemented in the
[Vigilans/compose-go](https://github.com/Vigilans/compose-go) fork and used via a custom
`docker compose` binary built from [Vigilans/compose](https://github.com/Vigilans/compose).

Named Mappings are **not** part of the upstream compose-spec. They are a personal fork feature.

## Syntax

Named Mappings extend the existing `${VAR}` shell-variable interpolation with bracket-key
syntax inspired by bash associative arrays:

```
${name[key]}                          # Simple lookup
${name[key]:-default}                 # Default if unset or empty
${name[key]-default}                  # Default if unset only
${name[key]:+replacement}             # Replacement if set and non-empty
${name[key]+replacement}              # Replacement if set
${name[key]:?error message}           # Error if unset or empty
${name[key]?error message}            # Error if unset only

${name[key1][key2][key3]}             # Multi-level (variadic) key access
${name[${other[key]}]}                # Nested interpolation inside keys
```

Key character set: `[_A-Za-z0-9.-]` (after interpolation of any nested expressions).

Escaping: `$${name[key]}` produces the literal string `${name[key]}`.

## Available Mappings

### Global scope (available everywhere)

| Expression | Description |
|---|---|
| `${project[name]}` | Project name. Changes per `include` block (each included file can set its own `name:`). |
| `${project[working-dir]}` | Project working directory. Also changes per `include` context. |
| `${compose[root-dir]}` | Directory where `docker compose` was invoked. Never changes regardless of `include`/`extends`. |
| `${compose[config-dir]}` | Directory of the compose file containing this expression. Tracks through `extends`/`include`. |
| `${compose[working-dir]}` | Working directory for path resolution (same as `.` in compose paths). |
| `${env[VAR_NAME]}` | Host environment variable. Like `${VAR_NAME}` but supports templated keys. |

### Service scope (available inside `services.<name>.*`)

| Expression | Description |
|---|---|
| `${service[name]}` | The service's key name in the compose file. |
| `${service[scale]}` | The service's replica count (from `scale:` or `deploy.replicas:`). |
| `${service[containers][N][...]}` | Access the Nth container's properties (0-indexed). Only `N=0` is implemented; higher indexes resolve to an empty string. |
| `${container[name]}` | The container's `container_name` value (after interpolation). |
| `${container[user]}` | The container's `user` value. |
| `${container[working-dir]}` | The container's `working_dir` value. |
| `${container[image]}` | The container's image name. Same as `${image[name]}`. |
| `${container[env][VAR]}` | A resolved environment variable from this service's `environment:` / `env_file:`. |
| `${container[labels][KEY]}` | A label value on this container. Same as `${labels[KEY]}`. |
| `${image[name]}` | The `image:` field value of this service. |
| `${labels[KEY]}` | A label value from the service's `labels:` (shorthand for `${container[labels][KEY]}`). |

When `service[scale]` is 1, `${service[...]}` falls through to the single container's fields.

### Resource scope

**Networks** (`networks.<name>.*`):
`${network[name]}`, `${network[external]}`, `${network[driver]}`, `${network[labels][KEY]}`

**Volumes** (`volumes.<name>.*`):
`${volume[name]}`, `${volume[external]}`, `${volume[driver]}`, `${volume[labels][KEY]}`

**Configs** (`configs.<name>.*`):
`${config[name]}`, `${config[external]}`, `${config[file]}`, `${config[environment]}`,
`${config[content]}`, `${config[data]}`, `${config[labels][KEY]}`

**Secrets** (`secrets.<name>.*`):
`${secret[name]}`, `${secret[external]}`, `${secret[file]}`, `${secret[environment]}`,
`${secret[data]}`, `${secret[labels][KEY]}`

Secrets have no `content:` field — unlike configs, they can only be sourced from `file:` or
`environment:`.

### Cross-reference scope (available everywhere)

| Expression | Description |
|---|---|
| `${services[svc-key][...]}` | Look up another service's properties by its YAML key. |
| `${containers[container-name][...]}` | Look up a container by its `container_name`. |
| `${networks[net-key][...]}` | Look up a network by key. |
| `${volumes[vol-key][...]}` | Look up a volume by key. |
| `${configs[cfg-key]}` | Returns the config's resolved data (file content, env value, or inline content). |
| `${secrets[secret-key]}` | Returns the secret's resolved data (file content or env value). |

Cross-references trigger partial interpolation of the referenced element, with cycle detection.

`${secrets[name]}` and `${configs[name]}` are special: when called with a single key (no
trailing sub-keys), they resolve to the data content directly — reading the file, environment
variable, or inline content as appropriate.

## Key Semantics

### Interpolate after merge

Named Mappings require interpolation to happen **after** all merge operations (`extends`,
`include`, multiple `-f` files). This is because named mappings need the fully assembled
model to resolve correctly. Each field retains metadata about its source file, so expressions
like `${compose[config-dir]}` resolve to the correct directory even after merging files from
different directories.

### `extends` with named mappings

Named Mappings make `extends` much more powerful. A base service can use `${service[name]}`,
`${project[name]}`, or `${labels[KEY]}` as template parameters, and these resolve to the
**extending** service's actual values, not the base service's key:

```yaml
# common/compose.common.yml — shared base template
services:
  common:
    container_name: nas.${service[name]}
    network_mode: service:${project[name]}-ingress
    labels:
      nas.profile: ${project[name]}

# app/compose.yml
services:
  my-app:
    extends:
      file: ${compose[root-dir]}/common/compose.common.yml
      service: common
    # container_name resolves to "nas.my-app"
    # network_mode resolves to "service:app-ingress" (assuming project name is "app")
```

### Templated keys

Keys inside brackets can themselves contain interpolation expressions. This enables dynamic
lookups:

```yaml
# Resolve env var name based on a label value
volumes:
  - ${env[DATABASE_DISK_${labels[nas.replica-index]}]}/etcd:/var/lib/etcd
```

Here `${labels[nas.replica-index]}` resolves first (e.g., to `0`), then the outer expression
becomes `${env[DATABASE_DISK_0]}`, which resolves to the host environment variable
`DATABASE_DISK_0`.

### Secrets/configs as inline values

Instead of mounting secret files and using `*_FILE` env vars, you can inline secret data
directly:

```yaml
services:
  my-app:
    environment:
      DB_PASSWORD: ${secrets[db_password]}
      API_TOKEN: ${secrets[api_token]}

secrets:
  db_password:
    file: ./secrets/db_password.txt
  api_token:
    file: ./secrets/api_token.txt
```

`${secrets[db_password]}` reads the file at `./secrets/db_password.txt` and inlines its
content as the environment variable value. This works for secrets defined via `file:` or
`environment:`.

### Cross-service references

Services can reference other services' resolved environment variables:

```yaml
services:
  auth-lldap:
    environment:
      LLDAP_LDAP_BASE_DN: dc=example,dc=com

  auth-proxy:
    environment:
      # Reference the other service's env var — always stays in sync
      LDAP_BASE_DN: ${services[auth-lldap][env][LLDAP_LDAP_BASE_DN]}
      LDAP_USER: uid=${secrets[ldap_username]},ou=people,${services[auth-lldap][env][LLDAP_LDAP_BASE_DN]}
```

### Path resolution with `compose[root-dir]` and `compose[config-dir]`

These two mappings solve the long-standing problem of relative paths in multi-file compose
setups:

- `${compose[root-dir]}` — Always points to where `docker compose` was invoked, regardless
  of `extends`/`include` nesting. Use for absolute references to shared resources (common
  base files, project-wide secrets).

- `${compose[config-dir]}` — Points to the directory of the compose file containing this
  expression. Use for references that should be relative to the current file (local build
  contexts, sibling config files).

```yaml
# database/etcd/compose.common.yml
services:
  etcd:
    build:
      context: ${compose[config-dir]}/../docker    # → database/docker/
    extends:
      file: ${compose[root-dir]}/common/compose.common.yml   # → <project-root>/common/...
      service: common
```

### Labels as template parameters

Labels serve double duty: they are standard Docker labels AND template parameters for named
mappings. A common pattern is to set a label in a per-instance template and reference it in
shared base definitions:

```yaml
# templates/compose.instance.0.yml — per-replica instance
services:
  etcd-0:
    extends:
      service: etcd      # from compose.common.yml
    labels:
      nas.replica-index: 0

# compose.common.yml — shared definition
services:
  etcd:
    container_name: nas.${service[name]}
    hostname: ${labels[nas.replica-index]}.database.example.com
    volumes:
      - ${env[DATABASE_DISK_${labels[nas.replica-index]}]}/etcd:/var/lib/etcd
    environment:
      ETCD_NAME: etcd-${labels[nas.replica-index]}
```

The label `nas.replica-index: 0` flows through `extends` and is available in the base
service's named mapping expressions.

## Combining with standard interpolation

Named mappings coexist with standard `${VAR}` interpolation. You can mix them freely:

```yaml
services:
  my-service:
    image: registry.example.com/${project[name]}/${service[name]}:${IMAGE_TAG:-latest}
    user: ${PUID:?PUID required}:${PGID:?PGID required}
```

Standard env-var interpolation uses the same `:-`, `:+`, `:?` modifiers and works identically
to upstream Docker Compose. Named mapping modifiers follow the same rules.

## Differences from upstream Docker Compose

| Feature | Upstream | This fork |
|---|---|---|
| `${VAR}` env interpolation | Yes | Yes (unchanged) |
| `${name[key]}` named mappings | No | Yes |
| Interpolation timing | Before merge | After merge |
| `extends.file` with interpolation | Limited | Full (`${compose[root-dir]}` works) |
| Secret/config data inlining | No | `${secrets[name]}`, `${configs[name]}` |
| Self-referencing service metadata | No | `${service[name]}`, `${labels[...]}`, etc. |
| Cross-service env reference | No | `${services[svc][env][VAR]}` |

## Gotchas and edge cases

1. **Cycle detection**: Cross-references that form a cycle (A references B which references A)
   will produce an error: `lookup cycle detected: name[key]`.

2. **`project[name]` changes with `include`**: Each `include` block may set a different
   project `name:`. `${project[name]}` reflects the **included** file's project name, not the
   root. Use `${compose[root-dir]}` for stable root references.

3. **`${env[VAR]}` vs `${VAR}`**: Both resolve host environment variables. `${env[VAR]}`
   supports templated keys (`${env[PREFIX_${labels[idx]}]}`), while `${VAR}` does not.

4. **Key validation**: Resolved keys must match `[_A-Za-z0-9.-]*`. Keys containing other
   characters (spaces, slashes) will produce an error.

5. **Data resolution order**: `${configs[name]}` resolves data by trying in order:
   `environment:` → `file:` → `content:`. Secrets follow the same order across the two
   sources they support.
