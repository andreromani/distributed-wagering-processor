# Decisões de arquitetura

## Etapa 2: Bun e compilação

Bun 1.x executa a aplicação, o TypeScript compiler e os testes. ESM e imports relativos .js são preservados.
O build usa tsc com experimentalDecorators e emitDecoratorMetadata, preservando metadados de tipos para NestJS e futura integração TypeORM. Não usamos bun build como substituto desse compilador.
Os testes de código-fonte rodam pelo transpiler do Bun; não devem ser considerados prova de emissão de metadados. A aplicação compilada também deve ser validada.
O desenvolvimento usa tsc --watch e Bun --watch sobre dist em terminais separados, mantendo a mesma compilação da produção.
strictPropertyInitialization está habilitado, sem exceções adicionais.
Observe foi removido por não ser necessário para liveness. Observabilidade completa, readiness e infraestrutura estão fora desta etapa.

## Etapa 3: monólito modular distribuído

Adotamos monólito modular: uma base de código, futuramente replicável em três ou mais processos com PostgreSQL e SQS compartilhados. Simplifica timebox e permite atomicidade futura entre wallet, ledger, transação financeira, inbox e outbox sem transações distribuídas. Microserviços independentes exigiriam coordenação e recuperação adicionais. Trade-off: deploy e escala por processo ficam acoplados; os módulos devem manter limites claros.

Domínio terá entidades e invariantes sem NestJS, ORM ou AWS; application orquestrará casos de uso por portas; infrastructure contém adaptadores concretos. AppModule compõe banco, SQS e HTTP. Pastas sem implementação não foram criadas. Entidades de persistência futuras serão separadas das de domínio.

TypeORM foi escolhido pela familiaridade e timebox, embora MikroORM seja preferencial no desafio. Options e DataSource reutilizam a mesma configuração validada. synchronize e migrationsRun são false. Pool de três conexões por instância; conexão de 2s e consultas de aproximadamente 2–2,5s. Valores devem ser revistos antes de carga. O Nest gerencia o shutdown do DataSource; SQSClient é destruído por lifecycle provider.
Inicialização manual permite servir liveness mesmo sem banco; readiness inicializa conexão sob demanda e serializa tentativas concorrentes. Nenhuma conexão é aberta ao importar DataSource do CLI.

PostgreSQL 16.11-alpine fixa versão e reduz tamanho local. LocalStack Community 4.14.0 precede a mudança de distribuição que exige token nas versões 2026.03+. Não usamos latest, socket Docker, conta AWS real ou serviços além de SQS.
Fonte da escolha: https://blog.localstack.cloud/localstack-for-aws-release-v-4-14-0/
Mudança de autenticação: https://blog.localstack.cloud/localstack-single-image-next-steps/

Filas obrigatórias FIFO: wager-transactions.fifo e wager-transactions-dlq.fifo.
Redrive após cinco recebimentos, visibility de 30s e long polling de 20s são parâmetros iniciais; cinco tentativas e visibility são configuráveis. Os workers futuros deverão ajustar visibilidade à duração de processamento e aplicar backoff. FIFO não garante integridade financeira: constraints e transações PostgreSQL serão responsáveis. Hook idempotente cria filas e atualiza atributos antes do marcador de readiness do container.

SQS usa endpoint/região/credenciais configurados, duas tentativas no SDK, timeout de conexão de 1s e requisição de 2s; health aplica abort de 2,5s por chamada.
Readiness consulta banco e ambas as filas; liveness não depende deles. Nenhum consumidor, publisher, outbox, inbox, worker ou regra financeira foi implementado. Transações futuras usarão controle por wallet, nunca lock global; a estratégia detalhada e constraints permanecem para a etapa financeira.

Testes reais não substituem banco ou SQS por mocks. Falha SQS é isolada com um cliente para porta indisponível. Metadados são verificados no JavaScript compilado e DI é verificada pela criação real do AppModule.

## Validação da etapa 3

Bun install, build, typecheck, lint e git diff --check concluíram com sucesso.
bun test: 4 testes aprovados; integração isolada: 3; unitários isolados: 1.
PostgreSQL e LocalStack saudáveis; filas e redrive verificadas pelos testes reais.
Hook executado duas vezes sem duplicar recursos.
Aplicação compilada iniciou com Bun; live e ready retornaram 200.
Cenário SQS isoladamente indisponível retornou 503, preservando live em 200.
Metadados design:paramtypes do controller compilado foram confirmados.
migration:show concluiu sem migrations; generate/run/revert tiveram opções do CLI verificadas, sem aplicação/reversão de migration real.

O Docker inicialmente retornou HTTP 500 na negociação API v1.56. A tentativa com API v1.45 funcionou neste ambiente:
PowerShell: $env:DOCKER_API_VERSION='1.45'; docker compose up -d
Não foi necessário trocar LocalStack por MiniStack.
Durante download/extração, a máquina ficou lenta e a primeira integração excedeu timeout; repetição após containers saudáveis passou.

## Etapa 4 — Money

Money encapsula decimal.js como Value Object imutável com campo privado ECMAScript e instância congelada. Contratos usam MoneyProps com amount string e currency. number perde precisão binária para centavos e inteiros grandes, por isso nenhuma conversão monetária para number é permitida.

A política de entrada exige exatamente duas casas, sem espaços, sinal positivo, zeros à esquerda, expoentes ou separadores. Formatos 10 e 10.5 são rejeitados. from aceita valores não negativos e rejeita inclusive -0.00. rehydrate permite sinal negativo para reconstruir representações persistidas legítimas, mantendo validações de representação. subtract e negate podem produzir negativos. Zero é sempre serializado como 0.00. toString retorna apenas a quantia decimal e toJSON inclui a moeda.

Moedas aceitas nesta entrega são o subconjunto ISO-4217 BRL e USD, em maiúsculas e sem normalização. A lista explícita evita aceitar códigos inexistentes apenas por terem três letras. A ampliação exige decisão e testes. Todas as operações binárias, inclusive equals e isLessThan, lançam CurrencyMismatchError quando as moedas divergem.

O clone privado do Decimal usa 32 dígitos significativos e ROUND_HALF_EVEN, isolado da configuração global. O intervalo simétrico vai de -9999999999999999999999999999.99 a 9999999999999999999999999999.99, com 28 inteiros e dois decimais. Soma ou subtração dos operandos limitados exige no máximo 31 dígitos, portanto a precisão configurada preserva centavos inclusive antes de detectar overflow. Cada resultado fora do intervalo lança MoneyOutOfRangeError. A API oferece somente adição, subtração e negação, que preservam escala exata. toFixed(2) apenas formata resultados já exatos. Entradas com escala excedente são rejeitadas, sem arredondamento.

A persistência futura deverá usar NUMERIC(30,2) e moeda em coluna separada, preservando strings no TypeORM e reconstruindo Money sem passar por number. Esse schema comporta o intervalo definido. O mapeamento e as migrations financeiras serão implementados na etapa correspondente.

A configuração isolada segue a API de clone do decimal.js.
https://mikemcl.github.io/decimal.js/#clone

## Etapa 5 — Entidades financeiras

Wallet é o Aggregate Root do saldo e versionamento. Money mantém aritmética decimal exata. WalletLedgerEntry representa uma movimentação imutável e valida direção, moedas, montante positivo, saldos não negativos e equação financeira. WagerTransaction guarda identidade, contexto e transições do processamento.

Wallet.open recebe id, playerId, initialBalance, at e contexto opcional opening com transactionId, ledgerEntryId e payloadHash fornecido pelo chamador. Retorna wallet, openingTransaction e openingEntry. Saldo positivo exige o contexto e produz OPENING interno já PROCESSED e crédito a partir de zero. Saldo zero retorna somente wallet. Versão inicial é sempre 1. A factory interna WagerTransaction.opening reserva provider/game internos e identificadores determinísticos de abertura. create rejeita OPENING externo.

Wallet.debit e credit recebem Money e MovementContext com transactionId, ledgerEntryId e at. O lançamento é construído e validado antes da alteração do saldo, versão e updatedAt. Somente operações estritamente positivas alteram saldo e incrementam versão. Não há coleção de lançamentos no aggregate. Falhas locais preservam o estado financeiro. Timestamps são guardados como milissegundos e getters retornam novas Dates. Campos de identidade são protegidos por objetos congelados e estado privado ECMAScript.

As factories rehydrate copiam estado persistido, incluindo versão, status e datas, sem gerar lançamentos nem reaplicar regras de transição ou criação. Datas precisam ser representáveis. A validação financeira de novos lançamentos ocorre em create. Um registro reidratado pode ser inspecionado com isBalanced para reconciliação.

Transições permitidas de WagerTransaction
- PENDING para PENDING_REFERENCE, PROCESSED, REJECTED ou FAILED.
- PENDING_REFERENCE para PENDING_REFERENCE, PROCESSED, REJECTED ou FAILED.
- PROCESSED, REJECTED e FAILED são terminais e todas as tentativas de mutação lançam InvalidTransactionStateError.
Entrar em PENDING_REFERENCE exige identificador externo de referência. markProcessed exige identificador interno para reversões. Timestamp de processamento é registrado nessa transição. reject e fail armazenam failureCode.

Política de valores adotada onde o desafio deixa interpretação aberta
- BET, REFUND, ROLLBACK e OPENING exigem valor positivo.
- WIN exige valor estritamente positivo e produz um lançamento CREDIT.
- LOSS aceita valor não negativo e registra resultado sem alterar saldo ou versão e sem gerar lançamento no ledger.
- A ausência de efeito implica ledgerDirectionFor lançar INVALID_LEDGER. affectsBalance indica potencial efeito da operação e valor, independentemente do status.
- WIN sem referência é processado normalmente com crédito. Com referência explícita, exige BET PROCESSED do mesmo provider, player, wallet, moeda e rodada, com identidade externa correspondente. Referência ainda não encontrada leva a PENDING_REFERENCE sem alterar saldo, versão ou ledger. O prêmio pode diferir do valor da BET. gameId pode diferir, pois a seção 7 não o inclui no contexto exigido.

BET debita. WIN e REFUND creditam. ROLLBACK de BET credita e de WIN/REFUND debita. REFUND exige BET processada. Reversões conferem provider, player, wallet, moeda, rodada, identidade externa e igualdade integral do valor. gameId não é exigido na igualdade de contexto porque a seção 7 não o inclui. Referência a si própria é inválida.

WagerTransaction.applyTo aplica regras locais a uma wallet já carregada e retorna seu lançamento, ou undefined para resultado sem efeito ou referência pendente. Recebe referência resolvida pelo chamador. Uma falha de negócio lança FinancialRuleError e preserva saldo, ledger, versão e status anterior. A camada application deverá capturá-la e chamar reject(code). Referência ausente entra em PENDING_REFERENCE. Aplicação bem-sucedida marca PROCESSED. Hash é somente comparado por matchesPayload. O domínio não calcula hash nem consulta armazenamento.

FailureCode contém INSUFFICIENT_FUNDS, INSUFFICIENT_REVERSAL_FUNDS, CURRENCY_MISMATCH, INVALID_AMOUNT, INVALID_REFERENCE, INVALID_REFERENCE_KIND, REFERENCE_CONTEXT_MISMATCH, REFERENCE_AMOUNT_MISMATCH, REFERENCE_NOT_FOUND, INVALID_KIND, EXTERNAL_OPENING_FORBIDDEN, INVALID_LEDGER, INVALID_TIMESTAMP e PERMANENT_INFRASTRUCTURE_FAILURE. Os códigos identificam falhas locais, expiração futura de referência ou falha permanente. InvalidTransactionStateError identifica uso incorreto de uma entidade terminal.

A etapa de persistência deverá aplicar pessimistic locking por wallet no PostgreSQL. Wallet, transação, ledger, inbox e outbox participarão de uma única transação SQL. Também serão necessárias constraints de não-negatividade, imutabilidade e unicidade de wallet por player/moeda, lançamento por transação/wallet, idempotência e reversão por referência/tipo. Consultar reversões anteriores, resolver referências e evitar duplicatas entre instâncias continuam responsabilidades da aplicação e banco. Testes locais verificam invariantes em memória e reconstrução do saldo pelo ledger.

## Etapa 6 — Persistência financeira

As cinco tabelas são criadas pela migration explícita FinancialFoundation1797000000000. Entidades de persistência usam EntitySchema tipado, independente das classes do domínio. A opção evita depender da emissão de metadados durante testes TypeScript diretos e mantém todos os campos sob strict. synchronize e migrationsRun permanecem false. A migration é a autoridade do schema, inclusive triggers. Qualquer SQL gerado futuramente por migration:generate exige revisão, pois os EntitySchemas descrevem colunas e não replicam todas as constraints e triggers manuais.

wallets guarda identidade, moeda, saldo NUMERIC(30,2), versão e datas. UNIQUE(player_id,currency) garante uma carteira por jogador e moeda. UNIQUE(id,player_id,currency) é necessário para a FK composta que impede transações com contexto de wallet divergente. Checks restringem BRL/USD, saldo não negativo, NaN e versão mínima 1. Infinity não cabe no NUMERIC com precisão limitada.

wager_transactions guarda identidade, hash, contexto, referência externa opcional, referência interna por FK, estado, código de falha e datas. A key de idempotência externa tem escopo global, pois o desafio define o header como fonte da verdade e recomenda incluir provider na própria key. Há constraints separadas para key e par provider/external ID. A identidade interna de OPENING reserva provider internal e prefixo opening: para keys internas, com external ID igual ao ID interno. Integrações externas deverão rejeitar esse namespace reservado. Essa restrição evita colisões com a representação interna já adotada pelo domínio.

O resultado original usa result_balance NUMERIC(30,2) e result_version, associados à moeda da transação, obrigatórios em PROCESSED. Replays usarão esse snapshot sem ler o saldo atual. Transações terminais têm atualização bloqueada, protegendo também o snapshot. Pendências têm reference_attempts e next_attempt_at e índice parcial por vencimento, data e ID. Referências internas PROCESSED são validadas por trigger quanto a identidade, contexto, status, tipo e reversão integral. O índice único parcial uq_wager_processed_reversal protege (reference_transaction_id,kind) somente para REFUND/ROLLBACK PROCESSED. Tentativas rejeitadas continuam auditáveis.

wallet_ledger_entries tem FKs sem cascade delete, UNIQUE(wallet_id,transaction_id), checks de direção, quantia positiva, saldos não negativos e equação financeira. Trigger de inserção confere transação PROCESSED, wallet, moeda, montante e direção esperada, excluindo LOSS. Índice (wallet_id,created_at,id) prepara consulta estável e reconciliação. Triggers BEFORE UPDATE/DELETE e BEFORE TRUNCATE rejeitam alterações. O proprietário e superusuários ainda podem remover ou desabilitar triggers ou alterar schema. Produção deverá executar aplicação sem privilégios administrativos e usar outro papel para migrations.

inbox_messages tem PK(consumer_name,message_id), hash e timestamps. outbox_messages tem envelope JSONB, agregado, tipo, data, tentativas, próximo envio e publicação. O índice parcial de pendentes prepara lockDue com FOR UPDATE SKIP LOCKED. Nenhum fluxo de consumo ou publicação é executado por esses adaptadores.

Os mappers persistem quantias como strings e reconstroem Money por rehydrate e entidades por suas factories rehydrate. Não há parser pg para converter NUMERIC em number. PostgreSQL pode arredondar escala excedente ao converter para NUMERIC(30,2), antes de executar checks. A validação estrita de escala continua no Money. SQL direto exige o mesmo cuidado na fronteira de escrita.

TypeOrmFinancialTransaction.run executa READ COMMITTED e entrega repositórios criados exclusivamente com o EntityManager daquela transação. Escritas e locks exigem QueryRunner ativo. findByIdForUpdate emite SELECT FOR UPDATE para uma wallet. Aquisição futura de múltiplas wallets deverá seguir ordem lexicográfica de ID, antes de gravar transações e ledger. Chamadas externas devem ocorrer fora desse bloco. O caso de uso deverá carregar com lock antes de modificar e persistir a wallet. A infraestrutura permite essa disciplina, enquanto o fluxo financeiro completo será desenvolvido na etapa seguinte.

Os adaptadores oferecem insert explícito, buscas por identidade e idempotência, consulta de reversão processada, persistência de transições/snapshot e paginação estável do ledger. Ledger não oferece update, delete, save ou upsert. Inbox oferece insert/find e outbox insert/lockDue. O contexto transacional permite confirmar ou desfazer todas essas escritas juntas.

Conflitos 23505 devem ser distinguidos pelo nome de constraint. uq_wager_idempotency e uq_wager_provider_external exigirão nova leitura e comparação de identidade/hash depois do rollback, em nova transação. uq_wager_processed_reversal é conflito de reversão, não replay. O erro deve sair do callback run para o TypeORM desfazer a transação abortada. Não se deve capturar violação SQL e continuar usando o mesmo EntityManager sem rollback ou savepoint.

Testes criam um banco exclusivo wager_test_<uuid>, executam migration:run, migration:revert e migration:run pelo CLI com Bun, e removem somente esse banco. O usuário PostgreSQL de testes precisa de CREATEDB. Os testes verificam SQL inválido diretamente, round trips, snapshot, rollback das cinco tabelas e duas conexões com sincronização por pg_blocking_pids. Os testes de duplicatas 50 vezes e três instâncias serão realizados com o caso de uso futuro.

Validação executada nesta etapa
- docker compose config e ps aprovados, PostgreSQL e LocalStack saudáveis.
- Build, typecheck e lint aprovados.
- 179 testes unitários e 37 testes de integração aprovados.
- Suíte completa com 216 testes aprovados.
- CLI migration:run, migration:revert e migration:run executados com sucesso em bancos temporários isolados.
- git diff --check aprovado, com avisos de normalização CRLF/LF nos documentos.
- O sandbox exigiu permissão ampliada para subprocessos Bun dos testes de migrations. A criação do banco temporário usa timeout maior que o das consultas normais.

## Etapa 6.2 — Encapsulamento simplificado

Wallet expõe id, playerId e currency como readonly. WagerTransaction expõe os identificadores, hash, contexto, kind, Money e referência externa como readonly. WalletLedgerEntry expõe identidade, direção, Money e saldos como readonly. Object.freeze(this) protege esses campos em tempo de execução. Campos privados nativos continuam permitindo somente as mutações realizadas pelos métodos da própria classe.

Saldo, versão e estado da transação permanecem privados com getters de leitura. Datas são armazenadas como timestamps privados e retornadas por cópias defensivas. Money mantém Decimal privado e sua representação exata.

A consulta dos usos existentes de Object.keys, spread e JSON.stringify em src e test confirmou que as três entidades são persistidas por mappers explícitos. Nenhum contrato de transporte existente depende da serialização implícita dessas entidades. Com os campos readonly públicos, Object.keys e spread passam a enumerar os campos imutáveis e JSON.stringify passa a incluí-los, usando Money.toJSON para quantias. Estado privado e datas continuam fora dessa enumeração. A referência externa undefined aparece em Object.keys e spread, mas é omitida pelo JSON. Esse efeito foi documentado e coberto por testes próprios. Os mappers continuam sendo a fronteira explícita de persistência e não utilizam essa enumeração.
