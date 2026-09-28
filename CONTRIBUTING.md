# Contributing to Pixie

Thank you for your interest in contributing to Pixie! Pixie is a friendly, local-first ELI5 AI coding companion built with TypeScript and paired with fine-tuned open-weights models and smart scaffold guardrails.

## Getting Started

1. **Prerequisites**:
   - Node.js >= 18.17
   - npm
   - [Ollama](https://ollama.ai) (optional, if testing with local models)

2. **Clone and Install**:
   ```bash
   git clone https://github.com/limpetz/Pixie-ELI5-CLI.git
   cd Pixie-ELI5-CLI
   npm install
   ```

3. **Run Locally**:
   ```bash
   npm run dev
   ```

---

## Testing & Quality Gates

Before submitting changes, all gates must be green:

```bash
# 1. Typecheck TypeScript sources without emitting
npm run typecheck

# 2. Run unit and behavioral self-tests (stream filter, parser, nudges, classifiers, tools)
npm run selftest

# 3. Run goal verifier smoke tests
npm run verify-smoke
```

If you have Ollama running with `pixie-7b` or `qwen2.5-coder:7b`:
```bash
# Run behavioral probe (must act via tools across all 4 rounds)
npx tsx scripts/probe.ts --model pixie-7b --rounds 4
```

---

## Development Guidelines

1. **Beginner-Friendly Philosophy (ELI5)**:
   - Keep answers warm, encouraging, and free of unnecessary technical jargon in beginner mode.
   - Any runtime changes to `BEGINNER_SYSTEM_PROMPT` must be probe-verified (`probe.ts`) against the model to prevent narration traps.

2. **Scaffold Runtime & Guardrails**:
   - When improving agent behaviors, prefer deterministic runtime guardrails in `src/agent.ts` and `src/tools.ts` (e.g. wrong-premise tool signals, recovery nudges, request routing) before altering training data.
   - Add unit tests to `scripts/selftest.ts` for every new detector or parser function.

3. **Submitting a Pull Request**:
   - Fork the repository and create a feature branch (`git checkout -b feature/my-feature`).
   - Ensure `npm run typecheck`, `npm run selftest`, and `npm run verify-smoke` pass.
   - Submit your pull request against the `master` branch.

## License

By contributing to Pixie, you agree that your contributions will be licensed under the [Apache 2.0 License](LICENSE).
