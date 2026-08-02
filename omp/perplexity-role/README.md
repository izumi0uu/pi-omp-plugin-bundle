# Perplexity role

This is a dedicated OMP main-agent window for everyday search. It is a model-role overlay and launcher, not a plugin or task agent.

The window uses the `perplexity` model role for answer synthesis and prioritizes Perplexity for OMP's built-in `web_search` tool. Only `web_search` is enabled, and the launcher uses an isolated working directory, so the window cannot modify a project or run commands.

Expand the `web_search` tool card to verify the actual provider and authentication mode. OMP 17.2.4 shows that metadata in the UI but does not pass it to the answer model, so final prose cannot reliably prove that OAuth was used. Strict OAuth-only routing would require a custom provider wrapper and is intentionally outside this simple role.

## Install

```bash
install -d ~/.omp/agent/perplexity-role ~/.local/bin
install -m 0644 config.yml system-prompt.md ~/.omp/agent/perplexity-role/
install -m 0755 omp-perplexity ~/.local/bin/omp-perplexity
```

Start the dedicated window:

```bash
omp-perplexity
```

### Role visibility in OMP 17.2.4

The launch overlay can resolve `@perplexity`, but the `/model` Roles editor only lists roles persisted in the global `~/.omp/agent/config.yml`. To make the row visible, merge this entry into the existing global `modelRoles` mapping without replacing its other entries:

```yaml
modelRoles:
  perplexity: tokenking-grok-queued/grok-4.5:high
```

The global entry only exposes the model alias. Perplexity-first search routing, the search prompt, tool restriction, and session isolation still come from the `omp-perplexity` launcher; merely selecting this role in an ordinary OMP window does not enable those behaviors.

Arguments pass through to OMP, including session operations:

```bash
omp-perplexity --resume
omp-perplexity -p "What changed in Node.js this week?"
```

The Perplexity account supplies search results; the configured `tokenking-grok-queued/grok-4.5:high` model synthesizes the final answer. Perplexity OAuth does not expose a chat model in OMP 17.2.4, so the role cannot map directly to a Perplexity model.
