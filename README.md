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

## Mensageria — Etapa 9

O consumer reutiliza o processamento financeiro HTTP e a inbox persistente. O publisher lê a outbox confirmada e envia seus envelopes para wager-integration-events.fifo. A entrada permanece wager-transactions.fifo e a DLQ permanece wager-transactions-dlq.fifo.

Atualize o Compose e aplique as migrations no ambiente pretendido antes de habilitar os workers.

```powershell
docker compose up -d
docker compose ps
bun install --frozen-lockfile
bun run migration:run
bun run build
```

O hook idempotente do LocalStack provisiona as três filas. Para reaplicá-lo e consultar os atributos, execute

```powershell
docker compose exec -T localstack sh /etc/localstack/init/ready.d/init-queues.sh
bun scripts/sqs.ts queues
```

Os workers ficam desligados por padrão. As variáveis são booleanos literais true/false. Execute uma das configurações abaixo em seu terminal PowerShell.

```powershell
# API HTTP
$env:HTTP_ENABLED = 'true'
$env:SQS_CONSUMER_ENABLED = 'false'
$env:OUTBOX_PUBLISHER_ENABLED = 'false'
bun run start

# Consumer
$env:HTTP_ENABLED = 'false'
$env:SQS_CONSUMER_ENABLED = 'true'
$env:OUTBOX_PUBLISHER_ENABLED = 'false'
bun run start

# Publisher
$env:HTTP_ENABLED = 'false'
$env:SQS_CONSUMER_ENABLED = 'false'
$env:OUTBOX_PUBLISHER_ENABLED = 'true'
bun run start

# API, consumer e publisher
$env:HTTP_ENABLED = 'true'
$env:SQS_CONSUMER_ENABLED = 'true'
$env:OUTBOX_PUBLISHER_ENABLED = 'true'
bun run start
```

Ctrl+C aciona o encerramento gracioso no terminal Windows. O bootstrap também registra SIGTERM. Os workers param a admissão, drenam trabalho em andamento e liberam recursos nessa ordem. O prazo padrão é 30s, com cancelamento cooperativo e reserva para SQL e chamadas externas. A configuração exige que WORKER_PROCESSING_TIMEOUT_MS caiba nesse orçamento.

| Variável | Padrão | Finalidade |
| --- | --- | --- |
| HTTP_ENABLED | true | Habilitar servidor HTTP |
| SQS_CONSUMER_ENABLED | false | Habilitar consumer |
| OUTBOX_PUBLISHER_ENABLED | false | Habilitar publisher |
| SQS_EVENTS_QUEUE_NAME | wager-integration-events.fifo | Destino dos eventos |
| SQS_CONSUMER_CONCURRENCY | 5 | Capacidade de processamento, de 1 a 10 |
| SQS_BATCH_SIZE | 10 | Máximo solicitado por recepção, de 1 a 10 |
| SQS_LONG_POLL_SECONDS | 20 | Espera de ReceiveMessage, de 1 a 20s |
| SQS_VISIBILITY_TIMEOUT | 30 | Visibilidade inicial e renovada |
| SQS_MAX_RECEIVE_COUNT | 5 | Limite alinhado à redrive policy |
| SQS_RETRY_BASE_SECONDS | 1 | Backoff inicial de entrega/polling |
| SQS_RETRY_MAX_SECONDS | 60 | Teto do backoff de entrega/polling |
| WORKER_EXTERNAL_TIMEOUT_MS | 3000 | Timeout individual das operações SQS |
| WORKER_PROCESSING_TIMEOUT_MS | 18000 | Limite de uma entrega ou rodada do publisher |
| WORKER_SHUTDOWN_TIMEOUT_MS | 30000 | Orçamento de encerramento |
| OUTBOX_BATCH_SIZE | 20 | Máximo de eventos por rodada |
| OUTBOX_POLL_INTERVAL_MS | 1000 | Intervalo normal de polling |
| OUTBOX_RETRY_BASE_MS | 1000 | Backoff inicial de publicação |
| OUTBOX_RETRY_MAX_MS | 60000 | Teto de backoff de publicação/polling |

A recepção efetiva usa o mínimo entre lote e concorrência. Mensagens do mesmo grupo são sequenciais. Grupos distintos podem progredir em paralelo. Ao alterar maxReceiveCount ou o visibility timeout no ambiente, reaplique o hook para alinhar os atributos das filas. O producer deve preferir MessageGroupId igual a walletId. FIFO complementa as garantias do PostgreSQL.

Exemplo executável em PowerShell com a API habilitada. Use o consumer habilitado em outra instância ou na mesma aplicação. O arquivo é gravado em UTF-8 sem BOM para funcionar também no Windows PowerShell 5.1.

```powershell
$apiBase = 'http://localhost:3000'
$walletBody = @{
  playerId = [guid]::NewGuid().ToString()
  initialBalance = @{ amount = '100.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 4
$wallet = Invoke-RestMethod -Method Post -Uri "$apiBase/wallets" `
  -ContentType 'application/json' -Body $walletBody
$externalId = [guid]::NewGuid().ToString()
$message = @{
  messageId = [guid]::NewGuid().ToString()
  type = 'WagerTransactionRequested'
  occurredAt = [DateTime]::UtcNow.ToString('o')
  correlationId = [guid]::NewGuid().ToString()
  data = @{
    providerId = 'provider-a'
    externalTransactionId = $externalId
    idempotencyKey = "provider-a:$externalId"
    playerId = $wallet.playerId
    walletId = $wallet.id
    roundId = 'round-sqs'
    gameId = 'fortune-chimp'
    kind = 'BET'
    money = @{ amount = '25.00'; currency = 'BRL' }
  }
}
$messageJson = $message | ConvertTo-Json -Depth 6
$messagePath = Join-Path (Get-Location) 'transaction-message.json'
[IO.File]::WriteAllText($messagePath, $messageJson, [Text.UTF8Encoding]::new($false))
bun scripts/sqs.ts send $messagePath

Invoke-RestMethod -Uri "$apiBase/providers/provider-a/wagering/transactions/$externalId"
Invoke-RestMethod -Uri "$apiBase/wallets/$($wallet.id)"
Invoke-RestMethod -Method Post -Uri "$apiBase/wallets/$($wallet.id)/reconciliation"

bun scripts/sqs.ts dlq
bun scripts/sqs.ts events
```

A ferramenta send valida o envelope e usa walletId como grupo FIFO. Cada envio recebe nova deduplication ID do broker, mantendo o messageId de negócio do arquivo. Repetir o envio do mesmo arquivo exercita a idempotência persistente. A ferramenta imprime as identidades de negócio e broker. As inspeções dlq e events usam ReceiveMessage com visibilidade zero e exibem o conteúdo solicitado. Essa leitura pode incrementar o contador de recebimentos. A recuperação administrativa da DLQ será manual e deverá conferir causa, identidade, conteúdo e resultado financeiro antes de qualquer redrive.

Rejeições financeiras e referências pendentes persistidas recebem ACK após commit. JSON/envelope inválido e conflitos permanentes são enviados à DLQ antes da exclusão da origem. Falhas transitórias mudam a visibilidade e chegam à DLQ pelo redrive nativo quando esgotadas. Falha no ACK permite redelivery seguro. O publisher oferece at-least-once com eventId estável, backoff e recuperação de linhas pendentes. O processamento concorrente de publishers pode alterar a ordem causal entre eventos da mesma wallet. Os consumidores futuros precisam deduplicar por eventId.

Em NODE_ENV=test, o lifecycle desabilita a inicialização automática dos workers, inclusive quando os flags de desenvolvimento estão ligados. As integrações habilitam seus workers explicitamente e usam bancos e filas temporários. O smoke usa NODE_ENV=production para exercitar o bootstrap normal.

```powershell
$env:HTTP_ENABLED = 'true'
$env:SQS_CONSUMER_ENABLED = 'false'
$env:OUTBOX_PUBLISHER_ENABLED = 'false'
bun run build
bun test test/unit/messaging.test.ts
bun test test/integration/messaging.test.ts
bun run test:integration
bun test
```

O smoke de integração usa dist/main.js com consumer e publisher habilitados em subprocesso Bun. No Windows, o teste dispara o lifecycle SIGTERM por IPC dentro do subprocesso. A validação distribuída com três processos, sinais nativos do sistema operacional e crash abrupto será consolidada posteriormente.
