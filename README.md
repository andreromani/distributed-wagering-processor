# Distributed Wagering Processor

Requisitos: Bun 1.x (validado com 1.4.4).

```sh
bun install
bun run build
bun run start
```

`start` e `start:prod` executam `dist/main.js` com Bun. Porta padrão: 3000; pode ser alterada por `PORT`.
`GET /health` retorna HTTP 200 e `{"status":"ok"}`. É apenas liveness inicial; readiness fica para etapa posterior.

Desenvolvimento em dois terminais:

```sh
bun run build:watch
bun run start:dev
```

O primeiro recompila TypeScript; o segundo realiza build inicial e observa o JavaScript compilado.

```sh
bun run typecheck
bun run lint
bun test
bun run test:e2e
bun run test:cov
```

O teste HTTP usa porta efêmera e fecha a aplicação em finally. Nenhum serviço externo é necessário nesta etapa.
