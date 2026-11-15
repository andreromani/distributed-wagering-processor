# Operação e configuração

[Voltar ao README](../README.md)

Este guia reúne procedimentos detalhados. Execute os comandos a partir da raiz do repositório. Para subir o sistema e executar os fluxos principais, comece pelo [início rápido](../README.md#pré-requisitos-e-início-rápido). Comandos de envio, smoke, shutdown e limpeza modificam o ambiente; execute apenas o procedimento pretendido.

## Desenvolvimento no host

Mantenha PostgreSQL e LocalStack do Compose saudáveis. Fora do Compose, .env.example aponta o Bun para 127.0.0.1:5432 e 127.0.0.1:4566; a API no host usa porta 3000. Dentro do Compose, as APIs usam 3001–3003 no host e postgres:5432/localstack:4566 internamente. Ao alterar LOCALSTACK_PORT, ajuste SQS_ENDPOINT do host. Não sobrescreva um .env existente sem revisar sua configuração.

```sh
docker compose up -d postgres localstack
bun run migration:run
bun run build
bun run start
```

Para desenvolvimento contínuo: bun run build:watch em um terminal e bun run start:dev em outro. Produção no host usa bun run start:prod. As migrations são explícitas: synchronize e migrationsRun são false. O CLI do host compila antes de migration:show, migration:run e migration:revert; migration:generate aceita um caminho como ./src/infrastructure/database/migrations/Nome. Revise SQL gerado para preservar constraints e triggers manuais.

O downgrade de RejectedSnapshots1797000001000 remove os snapshots adicionais de REJECTED/FAILED, preservando saldo e ledger. Reverter FinancialFoundation1797000000000 remove as tabelas financeiras e seus dados. Use revert somente no banco pretendido, nunca como limpeza genérica. Testes de reversibilidade usam bancos exclusivos.

Para inspecionar, gerar ou reverter no host, confirme primeiro o banco configurado no `.env`. Execute somente a ação pretendida; `migration:revert` desfaz a última migration aplicada:

```sh
bun run migration:show
bun run migration:generate ./src/infrastructure/database/migrations/Nome
bun run migration:revert
```

## Flags e limites dos workers

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

Em Linux, as atribuições PowerShell `$env:NOME = 'valor'` correspondem a `export NOME=valor`. As variáveis restantes são declaradas em [.env.example](../.env.example) e validadas por [worker-options.ts](../src/infrastructure/config/worker-options.ts). Em NODE_ENV=test, os workers não iniciam automaticamente; as integrações os habilitam explicitamente.

## Envio e inspeção SQS

A ferramenta [scripts/sqs.ts](../scripts/sqs.ts) usa a configuração local do Bun. Não precisa de AWS CLI no host.

| Comando existente | Comportamento real |
| --- | --- |
| `bun scripts/sqs.ts send message.json` | Lê e valida o envelope, envia à entrada FIFO com walletId como MessageGroupId e uma nova deduplication ID de transporte por envio; imprime businessMessageId e sqsMessageId. Não espera o processamento financeiro. |
| `bun scripts/sqs.ts queues` | Consulta URLs e atributos das três filas; não consome mensagens. Quantidades fornecidas pelo SQS são aproximadas. |
| `bun scripts/sqs.ts dlq` | Recebe uma amostra de até dez mensagens da DLQ com atributos, long polling de 1s e visibilidade zero. Não exclui mensagens e pode incrementar ApproximateReceiveCount. |
| `bun scripts/sqs.ts events` | Faz a mesma inspeção na fila de eventos. Não equivale a listar todo o histórico nem a confirmar eventos como consumidor. |

### BET usando uma wallet existente

Em um clone novo, grave o exemplo abaixo em `message.json` (UTF-8 sem BOM). Se já existir um arquivo com esse nome, preserve-o e use outro caminho, como `tmp/message-example.json`, passando esse caminho ao comando send. Os UUIDs abaixo são fictícios: substitua **playerId e walletId juntos** pelos dados retornados por `GET /wallets/:walletId`. A moeda precisa ser a da wallet e o saldo deve comportar 50.00. Use messageId, externalTransactionId e idempotencyKey novos para uma nova operação; atualize occurredAt para o horário atual em ISO-8601. Não use providerId `internal` nem chaves com prefixo `opening:`.

```json
{
  "messageId": "demo-message-001",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-11-14T12:00:00.000Z",
  "correlationId": "demo-sqs-001",
  "data": {
    "providerId": "provider-demo",
    "externalTransactionId": "demo-bet-001",
    "idempotencyKey": "provider-demo:demo-bet-001",
    "playerId": "11111111-1111-4111-8111-111111111111",
    "walletId": "22222222-2222-4222-8222-222222222222",
    "roundId": "demo-round-001",
    "gameId": "postman-demo",
    "kind": "BET",
    "money": { "amount": "50.00", "currency": "BRL" }
  }
}
```

Os comandos de envio/inspeção são idênticos em Linux e PowerShell, com Bun instalado e `.env` configurado para o host:

```sh
bun scripts/sqs.ts send message.json
bun scripts/sqs.ts queues
bun scripts/sqs.ts dlq
bun scripts/sqs.ts events
```

Consulte `GET /providers/provider-demo/wagering/transactions/demo-bet-001`, substituindo provider/external ID pelos usados no arquivo. Em PowerShell: `Invoke-RestMethod 'http://localhost:3001/providers/provider-demo/wagering/transactions/demo-bet-001'`; em Linux: `curl --fail --silent --show-error 'http://localhost:3001/providers/provider-demo/wagering/transactions/demo-bet-001'`. Se ainda retornar 404, aguarde o consumer e repita. O retorno fornece transactionId para `GET /wagering/transactions/:transactionId`.

Para reproduzir a deduplicação financeira com duas inboxes, envie uma segunda cópia alterando **somente o messageId do envelope**. Preserve data, externalTransactionId, idempotencyKey e contexto financeiro. A nova mensagem gera outra inbox e replay da mesma operação, sem novo débito nem novos eventos financeiros. Reenviar o arquivo sem mudar messageId exercita a mesma inbox. Em uma wallet inicialmente com 1000.00 e sem outras operações, o saldo fica 950.00 após ambos os envios.

### Demonstrar mensagem inválida na DLQ

`scripts/sqs.ts send` valida antes do envio: um arquivo inválido falha localmente e não chega à DLQ. Para demonstrar a DLQ real sem alterar o script, use o awslocal já presente no LocalStack para enviar um corpo inválido à entrada:

```powershell
$demoInvalidId = [guid]::NewGuid().ToString()
$demoQueueUrl = docker compose exec -T localstack sh -c 'awslocal sqs get-queue-url --queue-name "$SQS_QUEUE_NAME" --query QueueUrl --output text'
if ($LASTEXITCODE -ne 0 -or -not $demoQueueUrl) { throw 'Não foi possível resolver a fila local' }
docker compose exec -T localstack awslocal sqs send-message --queue-url $demoQueueUrl --message-body INVALID_JSON --message-group-id postman-invalid --message-deduplication-id $demoInvalidId
# Aguarde o consumer e repita para observar INVALID_MESSAGE nos atributos da DLQ.
bun scripts/sqs.ts dlq
```

As inspeções não excluem mensagens, mas incrementam contadores de recebimento. A recuperação administrativa da DLQ é manual: confira causa, identidade, conteúdo e resultado financeiro antes de redrive. Não há comando automático de redrive na ferramenta.

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

O limite de tentativas pode ser atingido muito antes do TTL: as 24 horas são um teto de idade, não uma promessa de espera mínima. No teste manual relatado, uma BET enviada cerca de 36 segundos após o REFUND chegou quando a pendência já havia sido rejeitada por esgotamento. A BET não reabre esse estado terminal. Em outro cenário, com cerca de oito segundos de intervalo, o worker resolveu o REFUND automaticamente após a BET. Esses intervalos são observações da sessão, não garantias de latência. Para repetir, crie novas identidades e envie a referência antes do esgotamento.

Agendamento e tentativas ficam no PostgreSQL. Ao reiniciar, uma nova instância consulta as pendências persistidas. Falhas transitórias preservam rollback e permitem recuperação posterior. O shutdown interrompe novas buscas e drena ou cancela cooperativamente a rodada antes do fechamento do DataSource, usando os deadlines dos workers existentes.

```powershell
bun test test/unit/pending-reference-worker.test.ts
bun test test/integration/pending-reference-worker.test.ts
```

Os testes de integração usam banco temporário exclusivo, relógio controlado e verificam saldo, ledger e outbox. Dois workers concorrentes no mesmo processo verificam a arbitragem SQL. A prova complementar com três processos está registrada nas [evidências de validação](VALIDATION.md#cenários-distribuídos).

## Imagem e operação distribuída

O Dockerfile usa oven/bun:1.4.4 em múltiplos estágios, instalação frozen, compilação tsc e dependências de produção. A imagem final executa dist/main.js com Bun e usuário bun. A mesma imagem atende migrations e app-1, app-2 e app-3. O PostgreSQL saudável e o hook de filas do LocalStack precedem migrations. As aplicações dependem da conclusão bem-sucedida desse serviço único.

Para preparar o ambiente, siga o [início rápido](../README.md#pré-requisitos-e-início-rápido).

As três aplicações habilitam HTTP, consumer, publisher e referências pendentes explicitamente. INSTANCE_ID assume app-1, app-2 e app-3, preservando consumerName e identidades persistentes. Fora do Compose, INSTANCE_ID é opcional, com valor gerado uma vez por processo e limite de 128 caracteres de letras, números, ponto, sublinhado, dois-pontos e hífen. O header x-instance-id identifica a aplicação que respondeu.

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

## Diagnóstico e métricas

Comece por `docker compose ps -a` e `docker compose logs --tail 50 app-1 app-2 app-3`. Consulte `/health/live`, `/health/ready` e `/metrics` nas portas 3001, 3002 e 3003, conforme os [comandos de observabilidade](../README.md#observabilidade). Se readiness falhar, confira também os logs de `postgres`, `localstack` e `migrations`; confirme que o hook concluiu a criação das três filas antes de investigar o consumer.

Correlacione logs JSON por correlationId, instanceId e identificadores financeiros aplicáveis. Para SQS, diferencie o messageId de negócio do ID de transporte; os comandos de inspeção estão na [seção SQS](#envio-e-inspeção-sqs). Não publique `.env`, credenciais, corpos financeiros ou logs brutos na entrega.

Contadores e histogramas pertencem a cada processo e reiniciam com ele. Gauges `scope=shared` representam consultas ao mesmo PostgreSQL/LocalStack; somá-los entre instâncias multiplica a mesma observação. Quantidades SQS são aproximadas. Confira as flags de coleta antes de interpretar valores preservados durante indisponibilidade. Outbox lag é a idade do evento pendente mais antigo, além da quantidade pendente; não são medidas equivalentes.

Uma pendência pode já estar terminal por esgotamento das cinco tentativas, mesmo antes de completar 24 horas; consulte status e failureCode antes de reenviar. Os timeouts históricos de SQS/readiness permanecem com causa inconclusiva; não atribua uma causa apenas porque uma nova tentativa passou. Histórico e limites estão em [VALIDATION.md](VALIDATION.md).

### Níveis e correlação dos logs

`LOG_LEVEL` aceita debug, info (padrão), warn, error e fatal, sem distinção entre maiúsculas/minúsculas; valores vazios ou desconhecidos falham na validação. Cada nível omite os inferiores. O filtro vale para NestJS, HTTP, mensageria e lifecycle; métricas continuam sendo contabilizadas independentemente do filtro. A saída permanece em stdout, com timestamp UTC ISO, level, event e instanceId.

Para uma API no host, após compilar, habilite DEBUG em PowerShell:

```powershell
$env:LOG_LEVEL = 'debug'
bun run start
```

Em Bash:

```bash
LOG_LEVEL=debug bun run start
```

Nos containers, configure `LOG_LEVEL=debug` no `.env` ou no ambiente do Compose e reaplique somente as aplicações com `docker compose up -d --no-deps app-1 app-2 app-3`, após preparar a imagem pelo README. Não recrie aplicações durante uma execução distribuída. Volte para info após o diagnóstico; os scripts que verificam eventos de resultado, barreiras e shutdown precisam de info ou debug.

INFO registra resultados, abertura, ACK, publicação e lifecycle. DEBUG acrescenta início, tentativa SQL, consulta com lock e referência. WARN identifica retries, falhas recuperáveis e conflitos/4xx; ERROR indica falhas técnicas relevantes e divergências. Rejeição financeira esperada permanece INFO. A aquisição do lock inclui execução da consulta e round-trip, não somente espera interna do PostgreSQL.

Exemplo ilustrativo de diagnóstico, sem payload ou valores financeiros:

```json
{"timestamp":"2026-11-14T18:00:00.000Z","level":"debug","event":"wallet_lock_acquired","instanceId":"app-2","source":"sqs","correlationId":"demo-request","walletId":"11111111-1111-4111-8111-111111111111","sqlAttempt":1,"durationMs":12}
```

Use transactionId para acompanhar a identidade persistida entre instâncias; operationId pode identificar somente uma tentativa. CorrelationId do replay identifica o pedido atual, enquanto a outbox preserva a correlação original. O worker de referências pode usar transactionId como sua correlação; não procure toda a recuperação somente pelo correlationId inicial. Tentativa SQL usa sqlAttempt, separada de attempt de entrega/publicação.

`outbox_event_published` com stage=broker_confirmed confirma o broker e pode preceder falha/rollback dos metadados. `outbox_publication_committed` com stage=metadata_committed confirma o retorno bem-sucedido da transação de publicação. EventId permanece estável na recuperação. WalletBalanceChanged permite correlação por transactionId, sem providerId próprio nem consulta adicional para enriquecer o log.

Falhas de serialização/emissão são isoladas. Erros são classificados sem SQL, ReceiptHandle, stack, credenciais ou corpo financeiro; não use DEBUG como justificativa para registrar esses dados. DEBUG aumenta volume e custo, e não deve ficar ligado indiscriminadamente durante medição de carga.

## Recursos das execuções distribuídas

Os comandos para iniciar a suíte estão no [README](../README.md#testes-e-resultados). Ela recria temporariamente as três aplicações e exige acesso Docker e permissão CREATEDB, mas não recria PostgreSQL/LocalStack. Execute sem outros processos que alterem essas aplicações.

O comando cria `wager_distributed_<uuid>` e três filas FIFO `wager-dist-<uuid>-*`, mantendo esses recursos para auditoria. Usa as três aplicações reais com override temporário em `tmp/distributed-tests/<runId>/compose.test.json`. Banco e filas usuais permanecem preservados. A configuração normal das aplicações é restaurada no finally, seguido de readiness das três APIs. Não execute simultaneamente outras ferramentas que recriem essas aplicações.

Os cenários A–H cobrem três repetições de 50 duplicatas, hot wallet, wallets distintas com evidência de locks SQL, três processos independentes, SIGKILL após commit antes do ACK, dois publishers concorrentes, crash após confirmação do broker, referência fora de ordem, restart e reconciliação de todas as wallets. E1 e E2 detalham as duas provas de publicação, totalizando nove resultados de cenário.

As barreiras exigem `DISTRIBUTED_TEST_HOOKS_ENABLED=true`, diretório montado, runId e IDs de alvos explícitos. Estão desabilitadas por padrão e usam arquivos locais, sem endpoint administrativo. O teste envia SIGKILL a um container real após observar o marcador e o estado persistido. A recuperação ocorre em outra instância. Os limites financeiros existentes são preservados.

Cada cenário emite JSON com resultado, duração, instâncias e identificadores auditáveis. `logs/distributed-tests/<runId>/summary.json` contém o resumo, e `applications.log` preserva o diagnóstico coletado. Esses diretórios são ignorados pelo Git. Falhas retornam exit code 1 e cenários não executados são listados como pendentes. O coletor de evidências confirma payload e eventId antes de fazer ACK exclusivamente na fila de saída isolada desta execução. FIFO pode deduplicar republicações com o mesmo eventId. A garantia de publicação é at-least-once.

## Limpeza segura

A retenção de banco e filas é intencional. Preserve summary.json e os logs antes da limpeza. Escolha uma única execução encerrada; não execute testes, recriações de aplicações ou redrive durante o procedimento. Não use down -v, purge, exclusão por prefixo ou DROP com FORCE.

1. Leia o summary.json exato. Valide runId, banco e as três filas contra o padrão da execução. Os nomes usados para remoção vêm do resumo:

```powershell
$auditRunId = Read-Host 'runId da execução encerrada a remover (confira o summary.json)'
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

## Arquivos da entrega

Versione fontes, testes, scripts, migrations, documentação, collection/environment Postman reutilizáveis, configurações, .env.example e bun.lock. Não versione .env, credenciais, logs, volumes, node_modules, dist, coverage, tmp/temp ou message.json da sessão manual. Ignore não remove arquivos locais. Revise git status --short e git diff --check antes de selecionar arquivos para commit.
