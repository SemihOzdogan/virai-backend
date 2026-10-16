#!/bin/sh
set -eu

ollama serve &
ollama_pid=$!

shutdown() {
  kill -TERM "$ollama_pid" 2>/dev/null || true
  wait "$ollama_pid" 2>/dev/null || true
}
trap shutdown INT TERM

until ollama list >/dev/null 2>&1; do
  sleep 1
done

ollama pull "${OLLAMA_CHAT_MODEL:?OLLAMA_CHAT_MODEL must be set}"
ollama pull "${OLLAMA_EMBEDDING_MODEL:?OLLAMA_EMBEDDING_MODEL must be set}"

wait "$ollama_pid"
