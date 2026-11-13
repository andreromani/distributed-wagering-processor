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

A migration FinancialFoundation1797000000000 cria o schema financeiro inicial.

    bun run migration:show
    bun run migration:generate ./src/infrastructure/database/migrations/Nome
    bun run migration:run
    bun run migration:revert

Os scripts compilam antes de chamar o CLI TypeORM com Bun e DataSource em dist.
Após gerar uma migration TypeScript, o próximo build compila o arquivo antes de aplicar.
Migrations devem implementar up/down reversíveis. Não há migrations automáticas na inicialização.
A reversibilidade é testada pelo CLI em banco temporário isolado.

## Persistência financeira

A migration inicial cria wallets, wager_transactions, wallet_ledger_entries, inbox_messages e outbox_messages.
Saldo e quantias usam NUMERIC(30,2), preservados como strings nos mappers. Money valida a escala antes da persistência, pois PostgreSQL arredonda entradas com escala excedente.

Wallets têm unicidade por jogador/moeda e checks de saldo e versão.
Transações têm unicidade por provider/external ID e idempotency key, snapshot de resultado original e agendamento de referências pendentes.
Reversões PROCESSED têm unicidade parcial por referência/tipo.
O ledger valida aritmética, contexto e imutabilidade por triggers, incluindo TRUNCATE.
Inbox e outbox possuem schema e adaptadores preparatórios.

O bloco TypeOrmFinancialTransaction.run compartilha um EntityManager READ COMMITTED entre os cinco repositórios.
A consulta de wallet com lock exige transação ativa. Adquira locks por ID em ordem consistente e execute chamadas externas fora do bloco.
O snapshot result_balance/result_version permite replay sem consultar o saldo atual.
O namespace provider internal e as keys opening: são reservados para abertura.

Com infraestrutura saudável, execute

    bun run build
    bun run typecheck
    bun run lint
    bun run test:unit
    bun run test:integration
    bun test

Os testes financeiros criam e removem um banco temporário exclusivo, com nome wager_test_<uuid>, usando as credenciais de desenvolvimento e exigindo permissão CREATEDB. Eles executam os scripts reais migration:run, migration:revert e migration:run com POSTGRES_DB direcionado ao banco temporário. O banco de desenvolvimento permanece preservado.

Para aplicar a migration no banco indicado pelo seu ambiente, execute

    bun run migration:show
    bun run migration:run
    bun run migration:revert

Revert desfaz a migration mais recente. Reverter a fundação remove as cinco tabelas financeiras e seus dados. Use somente no banco pretendido. Os testes de reversibilidade usam exclusivamente o banco temporário.
Os esquemas TypeORM registram colunas. Revise migrations geradas para preservar constraints e triggers implementadas manualmente.

As garantias de processamento completo, replay HTTP/SQS, eventos, workers e múltiplas instâncias dependem das etapas seguintes.

## Núcleo transacional

FinancialApplicationModule exporta OpenWalletUseCase, ProcessWagerTransactionUseCase e ReprocessPendingReferenceUseCase.
Os casos de uso recebem contratos de application, com correlação e inbox opcionais, e retornam resultados independentes de transporte.
Os testes executam abertura, operações financeiras, replay, rejeições, pendências, inbox/outbox e rollback com PostgreSQL real.

Aplique as migrations antes de usar os casos de uso no banco configurado

    bun run migration:run

A migration incremental RejectedSnapshots1797000001000 permite preservar saldo/versão das rejeições para replay.
Seu downgrade remove esses snapshots de REJECTED/FAILED ao restaurar a constraint anterior, preservando wallets e ledger. Planeje reversões em dados reais.
Os testes usam bancos temporários e validam run/revert/run sem modificar o banco de desenvolvimento.

O processamento de referência é invocado explicitamente por ID. O padrão tem cinco tentativas totais, TTL de 24h e backoff inicial de 1s, limitado a 60s. Relógio e política podem ser injetados para testes determinísticos.
Os eventos são gravados na outbox na transação financeira. O consumidor e os workers serão conectados nas etapas seguintes.

## API HTTP financeira — Etapa 8

Os endpoints financeiros estão sem autenticação nesta etapa. Use o ambiente local. A integração futura com IdP externo e autorização tem ponto de extensão em FinancialHttpModule. Antes de iniciar a aplicação, aplique as migrations no ambiente pretendido e execute bun run build e bun run start.

Exemplo executável em PowerShell. Cada execução cria um jogador novo. Os objetos retornados pelos comandos mostram as respostas reais da aplicação.

```powershell
$apiBase = 'http://localhost:3000'
$playerId = [guid]::NewGuid().ToString()
$walletBody = @{
  playerId = $playerId
  initialBalance = @{ amount = '1000.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 4

$wallet = Invoke-RestMethod -Method Post -Uri "$apiBase/wallets" `
  -ContentType 'application/json' -Body $walletBody
$wallet
Invoke-RestMethod -Uri "$apiBase/wallets/$($wallet.id)"

$externalId = [guid]::NewGuid().ToString()
$financialHeaders = @{
  'Idempotency-Key' = "provider-a:$externalId"
  'x-correlation-id' = [guid]::NewGuid().ToString()
}
$betBody = @{
  providerId = 'provider-a'
  externalTransactionId = $externalId
  playerId = $playerId
  walletId = $wallet.id
  roundId = 'round-987'
  gameId = 'fortune-chimp'
  kind = 'BET'
  money = @{ amount = '25.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 4

$bet = Invoke-RestMethod -Method Post -Uri "$apiBase/wagering/transactions" `
  -Headers $financialHeaders -ContentType 'application/json' -Body $betBody
$bet

# Replay mantém transactionId e saldo original, com idempotentReplay true.
Invoke-RestMethod -Method Post -Uri "$apiBase/wagering/transactions" `
  -Headers $financialHeaders -ContentType 'application/json' -Body $betBody

Invoke-RestMethod -Uri "$apiBase/wagering/transactions/$($bet.transactionId)"
Invoke-RestMethod -Uri "$apiBase/providers/provider-a/wagering/transactions/$externalId"

$page = Invoke-RestMethod -Uri "$apiBase/wallets/$($wallet.id)/ledger?limit=1"
$page | ConvertTo-Json -Depth 8
if ($page.nextCursor) {
  $next = [uri]::EscapeDataString($page.nextCursor)
  Invoke-RestMethod -Uri "$apiBase/wallets/$($wallet.id)/ledger?limit=1&cursor=$next"
}

Invoke-RestMethod -Method Post -Uri "$apiBase/wallets/$($wallet.id)/reconciliation"
Invoke-RestMethod -Uri "$apiBase/health/live"
Invoke-RestMethod -Uri "$apiBase/health/ready"
```

A abertura retorna 201, saldo 1000.00 e versão 1. A BET retorna 200, PROCESSED e saldo 975.00. O ledger inclui OPENING e BET. A reconciliação retorna consistent true, difference 0.00 e checkedEntries 2. Valores monetários são strings.

GET de recurso existente retorna 200. A submissão retorna 202 para referência pendente, 422 para rejeição financeira e 500 para um FAILED terminal persistido. Os resultados financeiros incluem transactionId, status, failureCode/snapshot quando disponíveis e idempotentReplay. Consulte as rotas de transação para acompanhar uma pendência. O agendamento automático será implementado posteriormente.

Payload/header inválido retorna 400. Recurso inexistente retorna 404. Wallet duplicada e conflitos de identidade retornam 409. Falha transitória retorna 503. Erros usam statusCode, code, message e correlationId. Invoke-RestMethod lança erro para respostas HTTP 4xx/5xx.

O Idempotency-Key é obrigatório na submissão e aceita até 256 caracteres ASCII imprimíveis, sem vírgula e com conteúdo não branco. A forma provider:externalId é uma recomendação. Identificadores de negócio aceitam até 256 caracteres. x-correlation-id é opcional e aceita até 128 caracteres de letras, números, ponto, sublinhado, dois-pontos e hífen. A resposta sempre inclui x-correlation-id.

O ledger usa cursor opaco com escopo de wallet e precisão de microssegundos. O limite padrão é 50, mínimo 1 e máximo 100. Uma navegação não mantém snapshot entre requisições. A reconciliação executa uma única consulta consistente e sinaliza divergências em resposta, log JSON e contador por processo, preservando os dados.

Resposta observada na demonstração com JavaScript compilado e banco temporário, após a BET de 25.00 do exemplo acima. IDs e horários pertencem àquela execução, cujo banco já foi removido.

```json
{
  "transactionId": "12b1a196-60d1-46a6-b444-4779e577aea4",
  "status": "PROCESSED",
  "idempotentReplay": false,
  "createdAt": "2026-11-13T13:27:44.284Z",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "walletVersion": 2,
  "processedAt": "2026-11-13T13:27:44.326Z"
}
```
