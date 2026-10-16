# Render deployment

This repository contains a [Render Blueprint](./render.yaml) that provisions:

- `virai-api`: public Fastify API and persistent upload storage
- `virai-ollama`: private Ollama service and persistent model storage
- `virai-db`: private Render PostgreSQL database

## Deploy

1. Commit and push this repository to GitHub.
2. In Render, select **New > Blueprint** and select the repository.
3. Review the `frankfurt` region and the selected paid plans before creating resources.
4. If a browser frontend calls the API, add a `CORS_ORIGIN` environment variable with that frontend's exact public origin after the Blueprint is created. Native mobile clients do not need it.
5. Wait for the Ollama service to download the chat and embedding models. Its initial deploy can take several minutes.
6. Open `https://<your-api-service>.onrender.com/health`; it should return a connected database status.

## Operational notes

- The API migration runs before every API deployment via `node dist/db/migrate.js`.
- Model and upload disks cannot be scaled horizontally with their services. Use object storage before scaling the API beyond one instance.
- Never add `.env` to Git. Render generates the production JWT secret and injects database and Ollama addresses through private networking.
- `qwen2.5:7b` on CPU is functional but can be slow. Increase the Ollama service plan or move it to a GPU host if response time is unacceptable.
