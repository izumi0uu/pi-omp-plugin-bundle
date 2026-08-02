# Perplexity role

This is a dedicated OMP main-agent window for everyday search. It is a model-role overlay and launcher, not a plugin or task agent.

The window uses the `perplexity` model role for answer synthesis and prioritizes authenticated Perplexity for OMP's built-in `web_search` tool. Only `web_search` is enabled, and the launcher uses an isolated working directory, so the window cannot modify a project or run commands. If OMP falls back from Perplexity OAuth, the search prompt requires the answer to disclose that fact.

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

Arguments pass through to OMP, including session operations:

```bash
omp-perplexity --resume
omp-perplexity -p "What changed in Node.js this week?"
```

The Perplexity account supplies search results; the configured `tokenking-grok-queued/grok-4.5:high` model synthesizes the final answer. Perplexity OAuth does not expose a chat model in OMP 17.2.4, so the role cannot map directly to a Perplexity model.
