# Distributed Wagering Processor

Pré-requisitos: Bun 1.x (1.4.4 validado), Docker Desktop com containers Linux e Docker Compose.

## Ambiente local

Copie .env.example para .env (PowerShell: Copy-Item .env.example .env).
Use somente credenciais fictícias localmente. .env não é versionado.

Variáveis: PORT; POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD;
LOCALSTACK_PORT; SQS_ENDPOINT; AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY;
SQS_QUEUE_NAME, SQS_DLQ_NAME, SQS_MAX_RECEIVE_COUNT, SQS_VISIBILITY_TIMEOUT.
Ao alterar LOCALSTACK_PORT, ajuste também SQS_ENDPOINT.

    bun install
    docker compose config --quiet
    docker compose up -d
    docker compose ps
    docker compose logs localstack
    docker compose exec localstack awslocal sqs list-queues
    docker compose stop

Compose sobe somente PostgreSQL e LocalStack. O volume postgres-data preserva dados.
LocalStack recria filas ao iniciar; o healthcheck só aprova após o hook de provisionamento.
Para repetir o hook: docker compose exec localstack sh /etc/localstack/init/ready.d/init-queues.sh

## Aplicação

    bun run build
    bun run start

Produção: bun run start:prod. Desenvolvimento em dois terminais:
bun run build:watch e bun run start:dev.

GET /health e /health/live: 200, processo vivo.
GET /health/ready: verifica SELECT 1 e acesso às duas filas FIFO; 200 ou 503 sem detalhes internos.
A aplicação inicia sem conectar ao banco: primeira readiness inicializa a conexão.
Falhas temporárias não impedem liveness e novas chamadas de readiness podem recuperar a conexão.

## Validação

    bun run build
    bun run typecheck
    bun run lint
    bun run test:unit
    bun run test:integration
    bun test

Unitários não precisam de Docker. Integração precisa de Compose saudável e build prévio.
bun test inclui integração e falha explicitamente se dependências estiverem indisponíveis.
Os cenários de falha usam endpoint isolado inválido; não param containers de outros testes.
O teste de metadados usa o JavaScript compilado. Injeções de tokens em código-fonte são explícitas com @Inject, pois a transpilação direta do Bun não substitui emitDecoratorMetadata.

## Migrations

Nenhuma entidade ou migration de negócio existe ainda.

    bun run migration:show
    bun run migration:generate ./src/infrastructure/database/migrations/Nome
    bun run migration:run
    bun run migration:revert

Os scripts compilam antes de chamar o CLI TypeORM com Bun e DataSource em dist.
Após gerar uma migration TypeScript, o próximo build compila o arquivo antes de aplicar.
Migrations devem implementar up/down reversíveis. Não há migrations automáticas na inicialização.
Não foi aplicada ou revertida migration financeira nesta etapa.
