# Distributed Wagering Processor

Serviço NestJS/Bun com PostgreSQL, TypeORM e SQS FIFO via LocalStack. HTTP e SQS compartilham o núcleo financeiro, com ledger, inbox e transactional outbox.

## Início rápido

Pré-requisitos: Bun 1.x (1.4.4 validado), Docker com containers Linux e Docker Compose. Em PowerShell, a partir da raiz do clone:

```powershell
Copy-Item .env.example .env
bun install --frozen-lockfile
docker compose config --quiet
docker compose build
docker compose up -d --wait
docker compose ps -a
Invoke-RestMethod http://localhost:3001/health/ready
```

Use apenas credenciais fictícias localmente. .env não é versionado. No shell Linux, use `cp .env.example .env`; os demais comandos Bun/Docker são iguais. O hook init-queues.sh é versionado com modo 100755 e LF; ele cria idempotentemente entrada, DLQ, eventos e o marcador de readiness. O healthcheck.sh também usa LF, mas é invocado por `sh` e não requer bit executável.

O Compose aguarda PostgreSQL/LocalStack saudáveis, executa migrations uma vez e inicia três aplicações da mesma imagem. APIs: http://localhost:3001, :3002 e :3003. Os quatro componentes (HTTP, consumer, publisher e referências) estão habilitados. Health: /health/live e /health/ready; métricas: /metrics. Use a porta 3001 nos exemplos HTTP/SQS abaixo quando executar pelo Compose.

O volume postgres-data preserva dados. As filas de desenvolvimento do LocalStack são voláteis em recriação do serviço; reiniciar apenas aplicações preserva banco e filas. A causa dos timeouts históricos intermitentes de SQS/readiness permanece inconclusiva; resultados aprovados posteriores não comprovam sua resolução causal.

## Validar e executar no host

Execute as suítes locais separadamente das provas distribuídas. Integrações exigem PostgreSQL e LocalStack reais, build prévio e permissão CREATEDB para bancos temporários. Para reduzir disputa por recursos, pode parar somente as aplicações:

```powershell
docker compose stop app-1 app-2 app-3
bun run build
bun run typecheck
bun run lint
bun run test:unit
bun run test:integration
bun test
docker compose start app-1 app-2 app-3
```

`bun test` inclui integração e falha se infraestrutura estiver indisponível. Os testes usam bancos/filas temporários e verificam PostgreSQL/SQS reais. Os 502 testes e nove cenários distribuídos da Etapa 12 são resultados históricos; os ajustes finais e sua validação direcionada são descritos em ARCHITECTURE.md.

Para desenvolvimento no host, mantenha `docker compose up -d postgres localstack`, aplique `bun run migration:run`, execute `bun run build` e `bun run start` (porta 3000 de .env). Desenvolvimento contínuo: `bun run build:watch` e `bun run start:dev` em terminais separados; produção: `bun run start:prod`. Não execute outra API na mesma porta.

## Migrations e persistência

```powershell
bun run migration:show
bun run migration:run
# Somente no banco pretendido: desfaz a migration mais recente.
bun run migration:revert
```

Os comandos compilam e usam o CLI TypeORM com Bun. Para criar nova migration: `bun run migration:generate ./src/infrastructure/database/migrations/Nome`; revise o SQL para preservar constraints/triggers. synchronize e migrationsRun são false. O Compose usa o CLI compilado pelo serviço migrations; veja os comandos de imagem adiante.

FinancialFoundation1797000000000 cria as cinco tabelas, constraints e triggers. RejectedSnapshots1797000001000 permite snapshots de rejeições para replay. O downgrade incremental remove esses snapshots, preservando saldo/ledger. Reverter a fundação remove tabelas e dados: não use como limpeza de testes. A reversibilidade run/revert/revert/run é testada em banco exclusivo.

Money usa NUMERIC(30,2) e strings, sem conversão para number; moeda fica separada. A validação de escala ocorre antes do SQL, que pode arredondar entradas diretas. TypeOrmFinancialTransaction compartilha EntityManager READ COMMITTED, lock individual por wallet e confirma saldo, wager, ledger, inbox e outbox atomicamente. Replay usa saldo/versão originais. Detalhes de concorrência, decisões de negócio, códigos e limitações estão em ARCHITECTURE.md.

## Autenticação e diagnóstico

Autenticação não foi implementada. FinancialAuthGuard é um guard no-op aplicado aos três controllers financeiros: sempre permite a requisição e não oferece segurança. Health permanece aberto. Para integrar um IdP OIDC externo, substitua esse provider por um guard que valide assinatura, issuer, audience e validade do token, e associe uma identidade confiável ao request. Aplique autorização do provider e das wallets ao recurso solicitado; formato válido de providerId/walletId não prova autorização. Guards executam antes dos pipes: valide entradas usadas na decisão ou delegue a autorização de recurso a uma etapa posterior à validação. Não crie usuários/senhas locais.

Logs HTTP de erro incluem correlação, instância e identificadores capturados somente após validação dos DTOs/parâmetros. transactionId representa um parâmetro interno de consulta; operationId vem do erro da aplicação e pode identificar uma tentativa ainda não persistida. Não se infere transação confirmada desse campo. Payload inválido não fornece contexto confiável. Nenhum corpo financeiro, token, SQL ou stack bruto é registrado.

## API HTTP financeira

Os endpoints financeiros usam FinancialAuthGuard no-op, sem autenticação ou autorização. Use o ambiente local; o desenho OIDC está descrito acima. Antes de iniciar a aplicação, aplique as migrations no ambiente pretendido e execute bun run build e bun run start.

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

GET de recurso existente retorna 200. A submissão retorna 202 para referência pendente, 422 para rejeição financeira e 500 para um FAILED terminal persistido. Os resultados financeiros incluem transactionId, status, failureCode/snapshot quando disponíveis e idempotentReplay. Consulte as rotas de transação para acompanhar uma pendência. O worker de referências realiza o agendamento automaticamente quando habilitado.

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

## Mensageria

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

Fora do Compose, os workers ficam desligados por padrão; o Compose habilita os três workers explicitamente. As variáveis são booleanos literais true/false. Execute uma das configurações abaixo em seu terminal PowerShell.

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

A ferramenta send valida o envelope e usa walletId como grupo FIFO. Cada envio recebe nova deduplication ID do broker, mantendo o messageId de negócio do arquivo. Repetir o envio do mesmo arquivo exercita a idempotência persistente. A ferramenta imprime as identidades de negócio e broker. As inspeções dlq e events usam ReceiveMessage com visibilidade zero e exibem o conteúdo solicitado. Essa leitura pode incrementar o contador de recebimentos. A recuperação administrativa da DLQ é manual e exige conferir causa, identidade, conteúdo e resultado financeiro antes de qualquer redrive.

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

O smoke de integração usa dist/main.js com consumer e publisher habilitados em subprocesso Bun. No Windows, o teste dispara o lifecycle SIGTERM por IPC dentro do subprocesso. A suíte distribuída descrita adiante comprovou três processos, sinais nativos e crash abrupto.

## Referências pendentes

Após aplicar as migrations existentes, habilite o worker automático em PowerShell.

```powershell
$env:PENDING_REFERENCE_WORKER_ENABLED = 'true'
$env:PENDING_REFERENCE_POLL_INTERVAL_MS = '1000'
$env:PENDING_REFERENCE_BATCH_SIZE = '20'
bun run build
bun run start
```

PENDING_REFERENCE_WORKER_ENABLED é false por padrão. O intervalo aceita de 10 a 60000 ms, e o lote de 1 a 100 transações. HTTP_ENABLED, SQS_CONSUMER_ENABLED e OUTBOX_PUBLISHER_ENABLED continuam controlando os outros componentes. Para executar todos juntos, habilite os quatro flags. Para executar somente referências pendentes, use HTTP_ENABLED=false e mantenha consumer e publisher desligados. Em NODE_ENV=test, os três workers exigem inicialização explícita pelos testes.

O worker busca PENDING_REFERENCE com nextAttemptAt vencido ou ausente e também pendências cujo TTL já expirou. Cada candidato passa pelo ReprocessPendingReferenceUseCase existente. A operação bloqueia a wallet e relê estado e agendamento antes de aplicar qualquer transição. Referência ainda ausente mantém o backoff existente de 1s, 2s, 4s e assim por diante, limitado a 60s. Cinco tentativas totais incluem a submissão inicial. O TTL é de 24 horas desde a criação. Esgotamento ou expiração gera REJECTED com REFERENCE_NOT_FOUND e evento na outbox.

Agendamento e tentativas ficam no PostgreSQL. Ao reiniciar, uma nova instância consulta as pendências persistidas. Falhas transitórias preservam rollback e permitem recuperação posterior. O shutdown interrompe novas buscas e drena ou cancela cooperativamente a rodada antes do fechamento do DataSource, usando os deadlines dos workers existentes.

```powershell
bun test test/unit/pending-reference-worker.test.ts
bun test test/integration/pending-reference-worker.test.ts
```

Os testes de integração usam banco temporário exclusivo, relógio controlado e verificam saldo, ledger e outbox. Dois workers concorrentes no mesmo processo verificam a arbitragem SQL. A prova complementar com três processos está registrada nos resultados distribuídos adiante.

## Imagem e operação distribuída

O Dockerfile usa oven/bun:1.4.4 em múltiplos estágios, instalação frozen, compilação tsc e dependências de produção. A imagem final executa dist/main.js com Bun e usuário bun. A mesma imagem atende migrations e app-1, app-2 e app-3. O PostgreSQL saudável e o hook de filas do LocalStack precedem migrations. As aplicações dependem da conclusão bem-sucedida desse serviço único.

Após clonar, copie .env.example para .env e execute em PowerShell.

```powershell
bun install --frozen-lockfile
docker compose config --quiet
docker compose build
docker compose up -d --wait
docker compose ps -a
```

As três aplicações habilitam HTTP, consumer, publisher e referências pendentes explicitamente. INSTANCE_ID assume app-1, app-2 e app-3, preservando consumerName e identidades persistentes. Fora do Compose, INSTANCE_ID é opcional, com valor gerado uma vez por processo e limite de 128 caracteres de letras, números, ponto, sublinhado, dois-pontos e hífen. O header x-instance-id identifica a aplicação que respondeu.

| Instância | API | Liveness | Readiness | Métricas |
| --- | --- | --- | --- | --- |
| app-1 | http://localhost:3001 | /health/live | /health/ready | /metrics |
| app-2 | http://localhost:3002 | /health/live | /health/ready | /metrics |
| app-3 | http://localhost:3003 | /health/live | /health/ready | /metrics |

Dentro dos containers, PostgreSQL usa postgres:5432 e SQS usa localstack:4566. SQS_ENDPOINT_STRATEGY=dynamic permite ao LocalStack retornar URLs usando o host da requisição, atendendo containers e host. O volume PostgreSQL existente é preservado. As filas LocalStack continuam seguindo a política de desenvolvimento anterior, com recriação pelo hook quando o serviço reinicia. Reiniciar somente as aplicações preserva filas e banco.

Para executar migrations com a imagem pronta, sem compilador TypeScript na imagem final, use o serviço migrations.
O DataSource exclusivo do CLI usa conexão de 10s, statement timeout de 60s e query timeout de 65s para catálogo e DDL. Os limites curtos das operações financeiras permanecem na configuração da aplicação.

```powershell
docker compose run --rm migrations
docker compose run --rm migrations bun ./node_modules/typeorm/cli.js migration:show -d ./dist/infrastructure/database/data-source.js
```

Para o smoke distribuído, mantenha as três instâncias prontas e execute a ferramenta Bun no host. Ela usa as credenciais locais e portas de .env para consultar evidências no PostgreSQL e SQS.

```powershell
bun scripts/distributed-smoke.ts
bun scripts/distributed-shutdown.ts
Invoke-RestMethod http://localhost:3001/health/ready
(Invoke-WebRequest -UseBasicParsing http://localhost:3001/metrics).Content
docker compose logs --tail 50 app-1 app-2 app-3
docker compose stop app-1
docker compose start app-1
```

O smoke cria identificadores únicos e mantém os dados financeiros. Verifica wallet compartilhada, BET e replay entre instâncias, WIN via SQS, saldo 85.00, três lançamentos, reconciliação, seis eventos publicados e métricas das três APIs. Para conferir os envelopes publicados, lê a fila de eventos, mantém visibilidade temporária e a devolve no finally, preservando as mensagens. A inspeção incrementa contadores de recebimento dessa fila. SMOKE_APP_URLS permite informar três URLs distintas na ordem app-1, app-2 e app-3. O smoke é complementar à suíte distribuída de concorrência e crash descrita adiante.

stop_grace_period é 40s para o orçamento de workers de 30s. Logs signal_received, consumer_stopped, outbox_publisher_stopped, pending_reference_worker_stopped, workers_drained e sqs_client_destroyed permitem acompanhar SIGTERM nativo e a ordem de encerramento. O teste cooperativo de stop/start é independente das provas existentes de crash abrupto.

distributed-shutdown.ts usa as portas padrão 3001–3003 e chama Docker Compose pelo Bun. Ele pausa app-2/app-3, cria uma wallet exclusiva, mantém um lock SQL enquanto app-1 recebe LOSS e executa docker compose stop app-1. Após observar SIGTERM, libera o lock e verifica drenagem, fechamento de conexões e ACK condicionado a inbox confirmada. Reinicia as três aplicações e confere recuperação, ledger e reconciliação. Os dados de teste são preservados e as aplicações são reiniciadas também no finally.
O probe identifica o bloqueador SQL da conexão de teste. A sincronização considera visibilidade e long polling, limitada a 120s. A espera de readiness após restart é limitada a 180s, acompanhando a janela de startup do Compose. Esses prazos de validação são separados do orçamento de shutdown de 30s dos workers e da tolerância de 40s do Compose.

Para reduzir consumo durante a suíte local, pare as aplicações e mantenha a infraestrutura.

```powershell
docker compose stop app-1 app-2 app-3
docker compose up -d postgres localstack
bun run build
bun run typecheck
bun run lint
bun run test:unit
bun run test:integration
bun test
docker compose start app-1 app-2 app-3
```

GET /metrics fornece Prometheus text 0.0.4. Contadores são locais à instância e reiniciam com o processo. Os resultados financeiros usam source, status e replay, contabilizando observações do processamento, inclusive resultados reproduzidos. O histograma wager_processing_duration_seconds mede HTTP sem health/metrics, entregas SQS e tentativas de referência com buckets cumulativos em segundos.

As famílias incluem wager_transactions_total, wager_replays_total, wager_identity_conflicts_total, wager_http_requests_total, wager_sql_lock_conflicts_total, wager_sql_transient_failures_total, wager_reconciliation_divergences_total, contadores wager_sqs_*, wager_outbox_* e wager_reference_*. Conflitos SQL contabilizam 40001, 40P01 e 55P03 observados pelo adaptador financeiro. Falhas transitórias SQL são contabilizadas por tentativa desfeita. Os retries de entrega e publicação possuem contadores próprios.

Gauges consultam PostgreSQL e SQS durante o scrape, incluindo wager_outbox_pending_events, wager_outbox_oldest_pending_age_seconds, wager_reference_pending_transactions e wager_sqs_dlq_messages. Esses valores representam recursos compartilhados e aparecem com scope=shared, devendo ser deduplicados ao consultar várias instâncias. Os flags wager_metrics_database_collection_success e wager_metrics_sqs_collection_success indicam o sucesso da coleta daquela instância. Em falha, os últimos gauges conhecidos são preservados e os contadores continuam disponíveis com HTTP 200. Nenhum identificador financeiro é label. A consolidação pode ser feita futuramente por um coletor Prometheus externo.

## Testes distribuídos e resultados históricos

Use Bun 1.4.4, Docker Compose acessível pelo host e `.env` configurado conforme `.env.example`. PostgreSQL e LocalStack devem estar saudáveis, assim como as três aplicações nas portas 3001–3003. O usuário PostgreSQL local precisa de permissão para criar o banco exclusivo da execução. Execute separadamente da suíte local completa.

```powershell
docker compose config --quiet
docker compose build migrations
docker compose up -d --wait
docker compose ps
bun run test:distributed
```

O comando cria `wager_distributed_<uuid>` e três filas FIFO `wager-dist-<uuid>-*`, mantendo esses recursos para auditoria. Usa as três aplicações reais com override temporário em `tmp/distributed-tests/<runId>/compose.test.json`. Banco e filas usuais permanecem preservados. A configuração normal das aplicações é restaurada no finally, seguido de readiness das três APIs. Não execute simultaneamente outras ferramentas que recriem essas aplicações.

Os cenários A–H cobrem três repetições de 50 duplicatas, hot wallet, wallets distintas com evidência de locks SQL, três processos independentes, SIGKILL após commit antes do ACK, dois publishers concorrentes, crash após confirmação do broker, referência fora de ordem, restart e reconciliação de todas as wallets. E1 e E2 detalham as duas provas de publicação, totalizando nove resultados de cenário.

As barreiras exigem `DISTRIBUTED_TEST_HOOKS_ENABLED=true`, diretório montado, runId e IDs de alvos explícitos. Estão desabilitadas por padrão e usam arquivos locais, sem endpoint administrativo. O teste envia SIGKILL a um container real após observar o marcador e o estado persistido. A recuperação ocorre em outra instância. Os limites financeiros existentes são preservados.

Cada cenário emite JSON com resultado, duração, instâncias e identificadores auditáveis. `logs/distributed-tests/<runId>/summary.json` contém o resumo, e `applications.log` preserva o diagnóstico coletado. Esses diretórios são ignorados pelo Git. Falhas retornam exit code 1 e cenários não executados são listados como pendentes. O coletor de evidências confirma payload e eventId antes de fazer ACK exclusivamente na fila de saída isolada desta execução. FIFO pode deduplicar republicações com o mesmo eventId. A garantia de publicação é at-least-once.

A execução `20194d68-d451-4f2a-9901-9be48c430a1f` aprovou A, B, C, D, E1, E2, F, G e H, com 1.208 assertions. As 16 wallets reconciliaram, com 39 lançamentos, 42 transações e 83 eventos publicados e observados. O crash do consumer confirmou commit em app-1, exit 137 e redelivery com replay/ACK em app-2 na tentativa 2, preservando saldo 75.00. Dois publishers comprovaram locks simultâneos em eventos distintos. A recuperação após confirmação do broker preservou o eventId. O restart recuperou mensagem, eventos e referência pendentes, com saldo 110.00. PostgreSQL e LocalStack conservaram seus containers. A configuração normal foi restaurada e as três APIs ficaram prontas.

Uma primeira execução aprovou A/B e parou por erro de leitura do PID no script, corrigido antes da repetição integral. Os diagnósticos estão preservados nos logs. Os detalhes por cenário, IDs dos containers/PIDs e limitações estão em `ARCHITECTURE.md`. Os cenários distribuídos obrigatórios da seção 13 estão comprovados. A causa dos timeouts intermitentes de SQS/readiness das etapas anteriores continua inconclusiva. Esta execução usou os serviços preservados, sem avaliar persistência do LocalStack após sua recriação.

As validações locais da etapa passaram com 356 testes unitários/1.110 assertions e 146 testes de integração/888 assertions. bun test aprovou os 502 testes e 1.998 assertions, preservando os 498 existentes. Build, typecheck, lint, Prettier dos TypeScript alterados e git diff --check passaram. A suíte local foi executada com as aplicações temporariamente paradas para reduzir disputa por recursos.

## Limpeza segura dos recursos exclusivos dos testes distribuídos

A retenção de banco e filas é intencional. Preserve summary.json e os logs antes da limpeza. Escolha uma única execução encerrada; não execute testes, recriações de aplicações ou redrive durante o procedimento. Não use down -v, purge, exclusão por prefixo ou DROP com FORCE.

1. Leia o summary.json exato. Valide runId, banco e as três filas contra o padrão da execução. Os nomes usados para remoção vêm do resumo:

```powershell
$auditRunId = '20194d68-d451-4f2a-9901-9be48c430a1f' # escolha a execução a remover
if ($auditRunId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'runId inválido' }
$auditSummary = Get-Content -Raw -LiteralPath "logs/distributed-tests/$auditRunId/summary.json" | ConvertFrom-Json
if ($auditSummary.runId -cne $auditRunId) { throw 'Resumo de outra execução' }
$auditDatabase = [string]$auditSummary.database
if ($auditDatabase -cne ('wager_distributed_' + $auditRunId.Replace('-', ''))) { throw 'Banco não exclusivo' }
$auditQueues = @([string]$auditSummary.queues.input, [string]$auditSummary.queues.dead, [string]$auditSummary.queues.events)
$auditExpectedQueues = @("wager-dist-$auditRunId-input.fifo", "wager-dist-$auditRunId-dead.fifo", "wager-dist-$auditRunId-events.fifo")
for ($auditIndex = 0; $auditIndex -lt 3; $auditIndex++) {
  if ($auditQueues[$auditIndex] -cne $auditExpectedQueues[$auditIndex]) { throw 'Fila não exclusiva' }
}
$auditTargets = @($auditDatabase) + $auditQueues
$auditTargets
```

2. Confira a restauração normal das três aplicações: summary.normalConfigurationRestored, readiness nas portas 3001–3003 e configuração efetiva. Inspecione também containers parados que poderiam reiniciar com configuração antiga. O bloco abaixo não imprime senhas e aborta ao encontrar aplicações configuradas para os alvos:

```powershell
$auditContainerIds = @(docker ps -aq)
if ($LASTEXITCODE -ne 0) { throw 'Falha ao listar containers' }
if ($auditContainerIds.Count -gt 0) {
  $auditContainers = docker inspect @auditContainerIds | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao inspecionar containers' }
  foreach ($auditContainer in $auditContainers) {
    foreach ($auditSetting in @($auditContainer.Config.Env)) {
      $auditPair = $auditSetting -split '=', 2
      if ($auditPair.Count -eq 2 -and $auditPair[0] -in @('POSTGRES_DB','SQS_QUEUE_NAME','SQS_DLQ_NAME','SQS_EVENTS_QUEUE_NAME') -and $auditPair[1] -cin $auditTargets) {
        throw ('Recurso ainda configurado no container ' + $auditContainer.Name)
      }
    }
  }
}
```

Se houver referência, restaure a configuração normal pelo Compose e repita a inspeção. Verifique também processos Bun no host, terminais, IDE e eventuais clientes externos: encerre os workers exclusivos e retire os alvos de suas configurações. SQS não fornece uma lista de clientes conectados; contagem zero de mensagens não comprova ausência de consumidores. Sem essa verificação operacional, não remova as filas.

3. Consulte pg_stat_activity com o nome exato do resumo. O helper usa as credenciais do serviço PostgreSQL sem mostrá-las. Ele não termina sessões:

```powershell
function Invoke-AuditSql([string]$auditSql) {
  $auditSql | docker compose exec -T postgres sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' audit-psql -X -v ON_ERROR_STOP=1 -v "target_db=$auditDatabase" -At
  if ($LASTEXITCODE -ne 0) { throw 'Falha na verificação SQL' }
}
$auditSessions = Invoke-AuditSql "SELECT count(*) FROM pg_stat_activity WHERE datname = :'target_db';"
if ([string]$auditSessions -ne '0') { throw 'Banco ainda possui sessões; investigue antes de remover' }
```

4. Somente após conferir os alvos e a ausência de aplicações, remova os três nomes exatos no LocalStack deste Compose. Não aponte este procedimento para AWS real. Os comandos rodam dentro do LocalStack e fixam o endpoint local:

```powershell
foreach ($auditQueue in $auditQueues) {
  $auditQueueUrl = docker compose exec -T localstack awslocal --endpoint-url=http://localhost:4566 sqs get-queue-url --queue-name $auditQueue --query QueueUrl --output text
  if ($LASTEXITCODE -ne 0 -or -not $auditQueueUrl) { throw 'Fila não encontrada; interrompa e investigue' }
  docker compose exec -T localstack awslocal --endpoint-url=http://localhost:4566 sqs delete-queue --queue-url $auditQueueUrl
  if ($LASTEXITCODE -ne 0) { throw 'Falha na remoção da fila exclusiva' }
}
# Sem FORCE: conexões concorrentes impedem a remoção em vez de serem terminadas.
Invoke-AuditSql @'
SELECT format('DROP DATABASE %I', datname) FROM pg_database WHERE datname = :'target_db'
\gexec
'@
```

Por fim, confira a ausência desse banco com pg_database, a ausência dos três nomes via get-queue-url e a readiness das aplicações normais. Recursos compartilhados e volumes permanecem intactos. O procedimento é administrativo e manual; não é executado automaticamente pelo teste nem pela aplicação.
