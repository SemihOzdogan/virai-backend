FROM ollama/ollama:latest

ENV OLLAMA_HOST=0.0.0.0:11434 \
    OLLAMA_MODELS=/models \
    OLLAMA_KEEP_ALIVE=30m

COPY render/ollama-start.sh /usr/local/bin/ollama-start
RUN chmod +x /usr/local/bin/ollama-start

CMD ["/usr/local/bin/ollama-start"]
