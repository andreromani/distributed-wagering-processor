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

## Etapa 7 — Núcleo transacional

### Casos de uso e contratos

OpenWalletUseCase.execute recebe playerId, initialBalance em MoneyProps e correlação/causalidade opcionais. Retorna id, playerId, balance e version. Abertura é uma criação com conflito para jogador/moeda existentes, inclusive quando o payload é igual. Não há chave de idempotência de abertura no contrato do desafio.

ProcessWagerTransactionUseCase.execute recebe WagerPayload explícito, idempotencyKey obrigatória, metadados opcionais de evento e inbox opcional com consumerName/messageId. MoneyProps é validado antes de abrir a transação. OPENING, provider internal e keys opening: são rejeitados como INVALID_INPUT. Os identificadores devem ser strings não vazias. Referência externa é aceita somente nos tipos que a utilizam.

O resultado possui transactionId, status, failureCode quando aplicável, balance e walletVersion quando existe snapshot, referência interna quando resolvida, createdAt/processedAt em ISO, idempotentReplay e canAcknowledge. Este último indica retorno confirmado pelo commit para entrada com inbox. Os casos de uso e erros são independentes de HTTP e SQS.

ReprocessPendingReferenceUseCase delega à operação reprocess do mesmo ProcessWagerTransactionUseCase. A resolução de referências, aplicação das regras financeiras e persistência final usam a mesma implementação settle. Relógio, gerador de IDs e política de referência são injetáveis. FinancialApplicationModule registra as três instâncias com factories NestJS, mantendo o domínio e os casos de uso sem decorators.

### Fluxo e ordem de persistência

A abertura zero insere somente wallet. A abertura positiva usa Wallet.open, insere wallet, OPENING já PROCESSED com snapshot, lançamento CREDIT e os eventos WagerTransactionProcessed e WalletBalanceChanged. A versão inicial continua 1.

O processamento valida entrada, calcula hash, inicia READ COMMITTED, consulta inbox e identidade financeira e resolve replay/conflito. Para uma operação nova, bloqueia a wallet por SELECT FOR UPDATE e consulta novamente a identidade financeira após aguardar o lock. Confere player/moeda da wallet e resolve referência/reversões anteriores. Usa WagerTransaction.applyTo e as operações do aggregate.

A ordem efetiva é WagerTransaction com estado e snapshot finais, wallet quando alterada, ledger quando existente, eventos outbox e inbox. Todas as escritas usam o EntityManager do callback TypeOrmFinancialTransaction.run. A transação precisa estar PROCESSED antes de inserir ledger, conforme a trigger. A inbox é gravada ou concluída antes do commit. Qualquer falha SQL ou inesperada desfaz o conjunto inteiro. Não há chamadas externas no bloco.

Somente a wallet envolvida recebe lock. As regras locais continuam no domínio e o banco fornece unicidade, FKs, checks, imutabilidade e arbitragem entre conexões. A inicialização de conexão é compartilhada entre readiness e núcleo para evitar inicializações concorrentes do mesmo DataSource. A Promise de conexão não participa das garantias financeiras.

### Hash e identidade

canonicalPayloadHash usa SHA-256 do JSON de providerId, externalTransactionId, walletId, playerId, roundId, gameId, kind, money e referenceExternalTransactionId quando presente. As chaves são ordenadas recursivamente por ordem lexicográfica de unidades UTF-16. Arrays preservam ordem. Money é normalizado por toJSON para amount decimal com duas casas e currency. undefined em propriedades opcionais é omitido. A ordem original de propriedades não altera o hash.

idempotencyKey, identificadores internos, datas, correlação, causalidade e identificadores de transporte são excluídos. O mesmo payload financeiro gera o mesmo hash em qualquer transporte. O hash de OPENING é interno e usa playerId e initialBalance explícitos.

Mesma key global com mesmo hash retorna a transação original e seu snapshot. Mesma key com hash diferente resulta em IDEMPOTENCY_CONFLICT. Mesmo provider/externalTransactionId com outra key resulta em EXTERNAL_IDENTITY_CONFLICT, mesmo se os demais campos forem iguais. Nenhum desses conflitos autoriza uma segunda operação. Replay de estado terminal não altera wallet, versão, ledger ou eventos. Replay pendente retorna o estado persistido observado sem tentar aplicar novamente a operação.

### Erros e retries

FinancialApplicationError diferencia INVALID_INPUT, WALLET_NOT_FOUND, WALLET_CONFLICT, CONTEXT_MISMATCH, IDEMPOTENCY_CONFLICT, EXTERNAL_IDENTITY_CONFLICT, INBOX_CONFLICT, TRANSACTION_NOT_FOUND, TRANSIENT_FAILURE e PERMANENT_FAILURE.

Wallet inexistente não pode ser referenciada pela FK e produz WALLET_NOT_FOUND. Player ou moeda incompatíveis com a wallet produzem CONTEXT_MISMATCH antes de persistir uma WagerTransaction, pois a FK composta impede esse contexto. Violações financeiras de uma operação com wallet/contexto válidos são REJECTED auditáveis, com FailureCode, snapshot e evento. Exemplos incluem saldo insuficiente, referência inválida ou de valor/contexto divergente e reversão já processada. Overflow no saldo calculado é rejeitado com INVALID_AMOUNT. Erros inesperados fazem rollback e propagam, sem virar rejeição financeira.

O adaptador traduz erros SQL para PersistenceError. Os estados 40001, 40P01, 55P03, 57014, indisponibilidade 57P01/02/03 e 53300, classe 08, erros de conexão conhecidos e timeouts do pg são transitórios. Há no máximo três tentativas SQL, cada uma iniciando nova transação. A entidade de tentativa externa é recriada por factory em cada callback com a mesma identidade/hash, evitando reutilizar estado em memória após rollback.

23505 é distinguido por constraint. uq_wager_idempotency, uq_wager_provider_external, uq_wager_processed_reversal e inbox_messages_pkey permitem nova avaliação após rollback completo. Não se continua uma transação abortada. A nova tentativa consulta o vencedor e resolve replay, conflito ou rejeição por reversão anterior. uq_wallet_player_currency é convertido diretamente em WALLET_CONFLICT. Outras falhas SQL permanentes retornam PERMANENT_FAILURE. As tentativas são limitadas e mantêm os timeouts existentes de consultas e conexão.

Falha de infraestrutura permanente não gera uma transação FAILED artificial sem conseguir persistir atomicamente. Ela retorna erro de aplicação após rollback. Estados FAILED já persistidos podem ser lidos/reproduzidos.

### Snapshots e migration incremental

A constraint original ck_wager_result proibia snapshot em REJECTED. O desafio e o replay de uma aposta rejeitada após crédito posterior exigem preservar o saldo observado na rejeição. RejectedSnapshots1797000001000 amplia somente essa constraint, utilizando result_balance e result_version existentes também em REJECTED/FAILED, sem adicionar colunas ou editar a fundação.

Operações novas sempre gravam o snapshot terminal na mesma inserção/atualização do status. PROCESSED continua exigindo snapshot e processedAt. Rejeições mantêm processedAt ausente. Pares incompletos de saldo/versão são rejeitados pelo banco. Linhas legadas rejeitadas sem snapshot continuam legíveis e retornam a ausência original de balance/version, sem inventar saldo histórico a partir do saldo atual.

O down restaura a constraint anterior. Para isso, remove snapshots de REJECTED/FAILED durante a migration, com guard_wager temporariamente desabilitada na mesma transação administrativa e habilitada novamente antes do término. Status, saldo da wallet e ledger são preservados. Esse downgrade perde os snapshots adicionais de rejeições/falhas e exige planejamento antes de uso em dados reais. Os testes de reversibilidade ocorrem somente em bancos temporários.

### Referências e reversões

REFUND e ROLLBACK usam as validações do domínio e exigem valor integral e referência PROCESSED compatível. A busca de reversão anterior considera referência/tipo e PROCESSED. A constraint parcial protege a mesma regra. REFUND e ROLLBACK são contados separadamente, conforme a seção 7, sem proibição global entre tipos.

WIN exige valor positivo e pode omitir referência. Com referência declarada, aguarda BET válida e permite prêmio diferente da aposta. LOSS aceita valor não negativo, gera WagerTransactionProcessed e mantém saldo, versão e ledger.

Referência inexistente ou encontrada em PENDING/PENDING_REFERENCE permanece pendente. O contexto e tipo da referência encontrada ainda pendente serão conferidos pelo domínio quando ela se tornar elegível. Referências encontradas em REJECTED/FAILED são rejeitadas com INVALID_REFERENCE. Referência terminal incompatível em tipo, valor ou contexto recebe os códigos existentes.

Cada resolução sem referência incrementa reference_attempts. O padrão é cinco tentativas totais, incluindo a inicial, TTL de 24 horas desde createdAt e backoff de 1s, 2s, 4s etc., limitado a 60s. O esgotamento ou TTL produz REJECTED/REFERENCE_NOT_FOUND e evento de rejeição. Reprocessamento antes do próximo vencimento retorna sem alterações, exceto quando o TTL já expirou. Operações terminais nunca são reaplicadas. O scheduler futuro deverá passar os IDs elegíveis ao caso de uso.

WagerTransactionPendingReference é emitido somente ao entrar efetivamente na pendência. Tentativas seguintes que apenas atualizam agendamento não duplicam o evento. Processamento/rejeição posteriores emitem seus eventos correspondentes. A correlação é recebida por contexto, com transactionId como padrão estável. O reprocessamento pode receber contexto próprio de correlação e causalidade.

### Inbox, outbox e eventos

InboxMessage possui identidade/hash readonly, datas defensivas e processamento encapsulado. O repositório usa mapper explícito. Mesma identidade de mensagem com hash divergente gera INBOX_CONFLICT. Receipt com hash correspondente ainda não processado pode ser concluído na transação financeira. Uma operação já processada por HTTP pode receber nova inbox sem repetir movimento ou eventos. Inbox e idempotência financeira são garantias distintas. canAcknowledge só é retornado depois do commit. Ack, polling e DLQ permanecem responsabilidades da etapa de consumo.

OutboxMessage recebe o envelope explícito de IntegrationEvent. Dados e estruturas aninhadas são copiados e congelados, com proteção defensiva das datas. Seus metadados de publicação são reconstruídos pelo mapper, sem implementar retry/publicação nesta etapa.

Os envelopes usam os nomes da seção 11 do desafio, version e data. O pedido menciona eventVersion/Payload como exemplos, mas o contrato adotado preserva os nomes exatos do desafio. Cada evento concreto define eventType e version 1.

Exemplo de envelope WalletBalanceChanged

```json
{
  "eventId": "event-id",
  "eventType": "WalletBalanceChanged",
  "aggregateId": "wallet-id",
  "correlationId": "request-id",
  "occurredAt": "2026-12-11T12:00:00.000Z",
  "version": 1,
  "data": {
    "walletId": "wallet-id",
    "transactionId": "transaction-id",
    "direction": "DEBIT",
    "money": { "amount": "20.00", "currency": "BRL" },
    "balanceBefore": { "amount": "100.00", "currency": "BRL" },
    "balanceAfter": { "amount": "80.00", "currency": "BRL" },
    "walletVersion": 2
  }
}
```

WagerTransactionProcessed também cobre LOSS e OPENING. WagerTransactionRejected leva o FailureCode. WagerTransactionPendingReference registra a entrada em pendência. WalletBalanceChanged só é criado quando existe lançamento e mudança de saldo.

### Verificação e limites

Os testes unitários usam contexto em memória somente como dublê da orquestração. A garantia financeira é verificada por PostgreSQL real em banco temporário exclusivo, com reconciliação por Money e ledger incluindo OPENING. As falhas injetadas após transação, wallet, ledger, inbox e outbox devem deixar todas as tabelas no estado anterior. Uma nova tentativa válida deve executar uma única vez.

As chamadas concorrentes usam transações e conexões reais no mesmo processo Bun. Isso verifica a arbitragem SQL, sem substituir o teste distribuído futuro com três processos. Controllers financeiros, consultas/reconciliação HTTP, consumo SQS, ack/DLQ, publisher, scheduler, métricas completas, autenticação e orquestração final ainda exigem as próximas etapas do desafio.

### Resultados executados nesta etapa

Em 11/12/2026, com Bun 1.4.4, docker compose config --quiet passou e docker compose ps confirmou PostgreSQL e LocalStack healthy. Build, typecheck e lint passaram. test:unit passou com 217 testes e 763 assertions; test:integration passou com 62 testes e 307 assertions. A execução completa bun test passou com 279 testes, zero falhas e 1070 assertions, preservando os 222 testes anteriores e acrescentando 57 (32 unitários e 25 de integração).

Os testes de persistência executaram os comandos migration:run, migration:revert e migration:run em banco temporário; duas reversões desfizeram a incremental e a fundação antes da reaplicação. O novo conjunto também verificou o ciclo da migration incremental por DataSource. Nenhuma reversão foi executada no banco de desenvolvimento.

Passaram os cenários de 50 duplicatas, duas BET de 80.00 sobre 100.00 (uma aprovada e saldo 20.00), independência de wallets, reversões concorrentes, referências fora de ordem, conflitos simultâneos de idempotência/inbox e rollback após cada componente. A reconciliação utiliza Money exato. A verificação Prettier inicialmente apontou o helper de testes; após formatação, todos os arquivos src/test passaram. git diff --check passou; o Git emitiu somente avisos de normalização CRLF/LF nos documentos. Os testes completos precisaram de execução autorizada fora do sandbox para Docker e subprocessos de migrations. Não foram adicionadas dependências nem executados commit/push.

## Etapa 7.1 — Revisão pontual do núcleo transacional

### Deduplicação e corrida da inbox

recordInbox passa a usar o próprio registro retornado por checkInbox, que sempre compara payloadHash antes de devolvê-lo. Foi eliminada a consulta intermediária seguida de uma segunda leitura sem validação. Existe uma consulta inicial para detectar conflito antes do processamento e uma consulta final para validar qualquer receipt que tenha sido confirmado enquanto a operação financeira estava em andamento.

Se a consulta final encontra conteúdo divergente, INBOX_CONFLICT sai do callback e desfaz wallet, transação, ledger e outbox. Se ainda observa ausência enquanto outra transação confirma o receipt, a PK da inbox arbitra a inserção. A violação de unicidade provoca rollback completo, seguido de nova tentativa que identifica o conflito. Nenhum resultado canAcknowledge é devolvido em caso de erro.

Um receipt correspondente ainda não processado pode ser concluído. O adaptador markProcessed usa UPDATE com COALESCE para preservar a primeira data de processamento, inclusive em chamadas concorrentes. Essa operação deixou de depender de uma leitura adicional do receipt. Não existe operação da aplicação para substituir o hash ou remover e reutilizar a identidade de um receipt.

### Hash financeiro e hash da mensagem

canonicalPayloadHash preserva o algoritmo e os campos financeiros da Etapa 7, excluindo idempotencyKey e metadados de transporte. O conteúdo financeiro persistido nas wager transactions mantém o mesmo hash.

inboxPayloadHash calcula SHA-256 do JSON canônico com dois campos, payloadHash contendo o hash financeiro canônico e idempotencyKey contendo a chave enviada na mensagem. Essa composição inclui todos os campos financeiros por seu digest estável, reutiliza a canonicalização existente e distingue mensagens com a mesma operação financeira e chaves diferentes. Correlação, receipt handle, número de recebimentos e timestamps de entrega ficam fora do hash.

Receipts antigos da Etapa 7 usavam somente o hash financeiro. Seus hashes não são compatíveis com o novo algoritmo da inbox. Como o consumidor SQS ainda não foi implementado, não foi criada migration nem detecção ambígua de formatos. Os registros existentes são preservados e um replay contra um receipt antigo recebe INBOX_CONFLICT, exigindo avaliação explícita dos dados caso existam receipts fora dos bancos temporários. Nenhum dado é apagado ou reescrito automaticamente.

### Referências pendentes e autorreferência

settle entrega ao domínio a referência encontrada com seu estado real. applyTo valida identidade, provider, player, wallet, moeda, rodada, tipo e valor integral antes de manter uma referência PENDING ou PENDING_REFERENCE em espera. A validação estrutural é compartilhada com validateReference, que continua exigindo PROCESSED para uma movimentação. REJECTED e FAILED continuam referências inválidas. Referência não encontrada permanece PENDING_REFERENCE.

Autorreferência pela identidade externa do próprio provider gera uma rejeição financeira auditável REJECTED/INVALID_REFERENCE, com snapshot e evento, mesmo quando nenhuma referência foi encontrada. A rejeição ocorre antes de entrar em pendência. WIN sem referência, prêmio diferente da BET, REFUND integral e ROLLBACK dos tipos permitidos preservam suas regras. A constraint de reversão por referência/tipo e INSUFFICIENT_REVERSAL_FUNDS continuam aplicáveis.

Fixtures antigas de domínio reutilizavam externalTransactionId para a operação dependente e sua referência. Elas foram corrigidas para identidades distintas, preservando as verificações anteriores de saldo, versão, contexto e códigos de falha. O teste de WIN pendente referenciando outra WIN passou a esperar INVALID_REFERENCE_KIND imediatamente, conforme a validação estrutural antecipada solicitada.

### Retry SQL

Falhas transitórias de infraestrutura aguardam 25 ms antes da segunda tentativa e 50 ms antes da terceira, com teto explícito de 100 ms. A política é determinística e a função de espera pode ser injetada nos testes. Não foi adicionado jitter para essas duas esperas curtas. Conflitos das constraints recuperáveis continuam permitindo nova leitura imediata, após rollback completo. Erros permanentes não são repetidos.

Permanecem o limite de três tentativas, a lista explícita de constraints recuperáveis, a classificação SQL existente e uma nova transação/entidade de domínio por tentativa. Essas esperas pertencem ao retry SQL. O backoff de referências continua usando sua política persistida, e o retry de transporte será responsabilidade do consumidor futuro.

### Testes de regressão

Dois testes reais coordenam o commit do vencedor durante a consulta final da inbox do perdedor, usando wallets distintas. Uma variante retorna o receipt recém-confirmado e outra retorna a ausência observada antes do commit. As duas verificam INBOX_CONFLICT, preservação do receipt vencedor, rollback de todas as escritas financeiras do perdedor e reconciliação de ambas as wallets. A coordenação usa a conclusão explícita da operação vencedora, sem sleeps.

Os testes adicionais cobrem mudança exclusiva de idempotencyKey, redelivery, replay de operação processada sem inbox, referências pendentes incompatíveis e válidas, autorreferência, referência REJECTED/FAILED, resolução posterior de WIN pendente e ROLLBACK, backoff SQL com espera injetada e limites de retry. As constraints existentes impõem que outra wallet do mesmo jogador tenha moeda diferente. Por isso, o cenário SQL correspondente exercita wallet/moeda em conjunto, enquanto a unidade isola cada campo individualmente.

A investigação de uma falha intermitente no teste anterior de 50 duplicatas identificou outra janela entre leituras READ COMMITTED. Se a operação vencedora é confirmada entre a consulta por chave e a consulta por provider/external ID, a segunda consulta pode encontrá-la embora a primeira tenha observado ausência. A decisão existing agora compara chave e hash também nesse resultado, retornando replay para a mesma operação. Chave diferente continua EXTERNAL_IDENTITY_CONFLICT e hash divergente com a mesma chave continua IDEMPOTENCY_CONFLICT. Esse ajuste pontual foi necessário para preservar a garantia de replay concorrente. Um teste SQL coordena exatamente esse commit entre as duas consultas e verifica resultado original, efeito único e reconciliação. A falha observada na primeira suíte completa não teve seu stack integral preservado, portanto não é atribuída conclusivamente a essa janela. A janela foi reproduzida separadamente e corrigida com regressão determinística.

### Validação executada na Etapa 7.1

Com Bun 1.4.4, build, typecheck, lint e Prettier passaram. test:unit concluiu com 227 testes e 819 assertions. test:integration concluiu com 76 testes e 404 assertions em PostgreSQL e LocalStack reais. A execução final bun test concluiu com 303 testes, zero falhas e 1223 assertions. Foram preservados os 279 testes anteriores e acrescentados 24, sendo 10 unitários e 14 de integração. Os testes destrutivos continuaram restritos aos bancos temporários criados e removidos pela infraestrutura existente.

A primeira execução unitária apontou as identidades externas reutilizadas nas fixtures antigas. Após corrigir essas fixtures, todos os testes unitários passaram. Uma execução completa intermediária teve uma falha no cenário de 50 duplicatas. O cenário isolado e a repetição diagnóstica completa passaram. A investigação adicional produziu a regressão determinística de commit entre buscas de identidade descrita acima. Após sua correção, ambas as suítes finais passaram, incluindo o cenário de 50 duplicatas. Não houve retries adicionais na política para contornar esse resultado.

A última verificação git diff --check passou, com avisos de normalização CRLF/LF dos documentos já presentes na árvore de trabalho. Docker e subprocessos Bun das migrations exigiram execução autorizada fora do sandbox. Nenhuma dependência, configuração ou migration foi alterada nesta etapa. Não há bloqueio aberto para a revisão da Etapa 7.1.
