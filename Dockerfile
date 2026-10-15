FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
WORKDIR /app
COPY --chown=node:node package.json analyse.js normalise.js detectors.js usage.js report.js cli.mjs server.mjs index.html app.js style.css ./
COPY --chown=node:node cases/openai-tool-loop.json cases/anthropic-retry-storm.json cases/openai-unproven-completion.json cases/openai-clean.json ./cases/
USER node
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.mjs"]
